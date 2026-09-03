import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteScreenpipeFramesReader } from '../../../src/services/capture/providers/screenpipe/frames-reader.js';
import {
  extractUniversalStructuredText,
  type AccessibilityNode
} from '../../../src/services/work-activity/extraction/universal.js';
import {
  createFixtureDb,
  insertFrame
} from '../../helpers/maintenance-fixture.js';

describe('SqliteScreenpipeFramesReader', () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'screenpipe-frames-reader-'));
    dbPath = join(dir, 'db.sqlite');
    db = createFixtureDb(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reconstructs a swept AX tree from elements_ref_frame_id', async () => {
    const frameId = insertFrame(db, {
      timestamp: '2026-09-02T12:00:00.000Z',
      treeJson: null
    });
    db.prepare(
      `UPDATE frames
       SET app_name = ?, window_name = ?, elements_ref_frame_id = ?
       WHERE id = ?`
    ).run('iTerm2', 'bash', frameId, frameId);

    const insert = db.prepare(
      `INSERT INTO elements (
        frame_id, source, role, text, parent_id, depth,
        sort_order, properties, on_screen
      ) VALUES (?, 'accessibility', ?, ?, ?, ?, ?, ?, ?)`
    );
    const root = Number(insert.run(
      frameId,
      'AXApplication',
      'iTerm2',
      null,
      0,
      0,
      JSON.stringify({ title: 'iTerm2' }),
      1
    ).lastInsertRowid);
    const window = Number(insert.run(
      frameId,
      'AXWindow',
      'bash',
      root,
      1,
      1,
      JSON.stringify({ title: 'bash' }),
      1
    ).lastInsertRowid);
    const toolbar = Number(insert.run(
      frameId,
      'AXToolbar',
      null,
      window,
      2,
      2,
      null,
      1
    ).lastInsertRowid);
    insert.run(frameId, 'AXStaticText', 'Profile', toolbar, 3, 3, null, 1);
    const menu = Number(insert.run(
      frameId,
      'AXMenu',
      null,
      window,
      2,
      4,
      null,
      1
    ).lastInsertRowid);
    insert.run(frameId, 'AXMenuItem', 'Export', menu, 3, 5, null, 1);
    insert.run(frameId, 'AXWebArea', 'shell output', window, 2, 6, null, 1);

    const reader = new SqliteScreenpipeFramesReader(dbPath);
    const frame = await reader.getFrame(frameId);
    reader.close();

    expect(frame?.accessibilityTreeJson).not.toBeNull();
    const tree = JSON.parse(frame!.accessibilityTreeJson!) as AccessibilityNode;
    expect(tree.role).toBe('AXApplication');
    expect(tree.children![0]?.role).toBe('AXWindow');
    expect(tree.children![0]?.title).toBe('bash');

    const text = extractUniversalStructuredText(tree);
    expect(text).toContain('[Window] bash');
    expect(text).toContain('[Nav] Profile');
    expect(text).toContain('[Action] Export');
    expect(text).toContain('[Body] shell output');
  });
});
