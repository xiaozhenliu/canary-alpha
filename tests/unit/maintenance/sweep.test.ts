import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAxTreeMaintenanceService } from '../../../src/services/maintenance/ax-tree-maintenance-service.js';
import {
  createFixtureDb,
  insertFrame,
  insertWorkerElement,
  isoMinutesAgo,
  syntheticTree
} from '../../helpers/maintenance-fixture.js';

describe('sweep', () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ax-sweep-'));
    dbPath = join(dir, 'db.sqlite');
    db = createFixtureDb(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const treeJson = JSON.stringify(syntheticTree());
  const svc = () => createAxTreeMaintenanceService({ databasePath: dbPath });

  it('case A nulls JSON when the same frame already has elements', () => {
    const id = insertFrame(db, { timestamp: isoMinutesAgo(30), treeJson });
    insertWorkerElement(db, id, 'hello');
    const result = svc().sweepOnce();
    expect(result.jsonNulledViaExisting).toBe(1);
    expect((db.prepare('SELECT accessibility_tree_json AS t FROM frames WHERE id = ?').get(id) as { t: string | null }).t)
      .toBeNull();
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM elements WHERE frame_id = ?').get(id) as { n: number }).n))
      .toBe(1);
  });

  it('case A follows elements_ref_frame_id before nulling JSON', () => {
    const target = insertFrame(db, { timestamp: isoMinutesAgo(40) });
    insertWorkerElement(db, target, 'shared');
    const id = insertFrame(db, { timestamp: isoMinutesAgo(30), treeJson, elementsRefFrameId: target });
    const result = svc().sweepOnce();
    expect(result.jsonNulledViaExisting).toBe(1);
    expect(result.converted).toBe(0);
    expect((db.prepare('SELECT accessibility_tree_json AS t FROM frames WHERE id = ?').get(id) as { t: string | null }).t)
      .toBeNull();
  });

  it('converts dangling refs instead of losing content', () => {
    const id = insertFrame(db, { timestamp: isoMinutesAgo(30), treeJson, elementsRefFrameId: 99_999 });
    const result = svc().sweepOnce();
    expect(result.converted).toBe(1);
    expect(result.jsonNulledViaExisting).toBe(0);
    const rows = db
      .prepare('SELECT role, text, depth, sort_order, properties FROM elements WHERE frame_id = ? ORDER BY sort_order')
      .all(id) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(5);
    expect(rows[2]).toMatchObject({ role: 'AXStaticText', text: 'hello', depth: 2 });
    const frame = db.prepare('SELECT elements_ref_frame_id AS r, accessibility_tree_json AS t FROM frames WHERE id = ?').get(
      id
    ) as { r: number; t: string | null };
    expect(Number(frame.r)).toBe(id);
    expect(frame.t).toBeNull();
  });

  it('case B preserves source, parent chain and properties', () => {
    const id = insertFrame(db, { timestamp: isoMinutesAgo(30), treeJson });
    svc().sweepOnce();
    const rows = db
      .prepare('SELECT id, source, parent_id, properties FROM elements WHERE frame_id = ? ORDER BY sort_order')
      .all(id) as Array<{ id: number; source: string; parent_id: number | null; properties: string | null }>;
    expect(rows.every((row) => row.source === 'accessibility')).toBe(true);
    expect(rows[0].parent_id).toBeNull();
    expect(Number(rows[1].parent_id)).toBe(Number(rows[0].id));
    expect(Number(rows[2].parent_id)).toBe(Number(rows[1].id));
    expect(Number(rows[4].parent_id)).toBe(Number(rows[0].id));
    expect(JSON.parse(rows[1].properties!).role_description).toBe('heading');
    expect(JSON.parse(rows[1].properties!)._converted_by).toBe('maintenance');
  });

  it('does not touch frames younger than the age window', () => {
    const id = insertFrame(db, { timestamp: isoMinutesAgo(5), treeJson });
    const result = svc().sweepOnce();
    expect(result.jsonNulledViaExisting + result.converted).toBe(0);
    expect((db.prepare('SELECT accessibility_tree_json AS t FROM frames WHERE id = ?').get(id) as { t: string | null }).t)
      .toBe(treeJson);
  });

  it('keeps invalid JSON for later inspection', () => {
    const id = insertFrame(db, { timestamp: isoMinutesAgo(30), treeJson: 'corrupted{{{' });
    const result = svc().sweepOnce();
    expect(result.convertFailures).toBe(1);
    expect((db.prepare('SELECT accessibility_tree_json AS t FROM frames WHERE id = ?').get(id) as { t: string | null }).t)
      .toBe('corrupted{{{');
  });

  it('rechecks inside the transaction to avoid duplicate rows after a worker race', () => {
    const id = insertFrame(db, { timestamp: isoMinutesAgo(30), treeJson });
    const service = createAxTreeMaintenanceService({
      databasePath: dbPath,
      beforeConvertTxn: () => {
        insertWorkerElement(db, id, 'raced');
      }
    });
    const result = service.sweepOnce();
    expect(result.converted).toBe(0);
    expect(result.jsonNulledViaExisting).toBe(1);
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM elements WHERE frame_id = ?').get(id) as { n: number }).n))
      .toBe(1);
  });
});
