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

  function treeText(json: string): string {
    return (JSON.parse(json) as Array<{ text?: string }>)
      .map((node) => node.text)
      .filter((text): text is string => typeof text === 'string')
      .join('\n');
  }

  it('case A nulls JSON when the same frame already has elements', () => {
    const id = insertFrame(db, { timestamp: isoMinutesAgo(30), treeJson });
    insertWorkerElement(db, id, 'hello');
    const beforeText = treeText(treeJson);
    const result = svc().sweepOnce();
    expect(result.jsonNulledViaExisting).toBe(1);
    expect((db.prepare('SELECT accessibility_tree_json AS t FROM frames WHERE id = ?').get(id) as { t: string | null }).t)
      .toBeNull();
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM elements WHERE frame_id = ?').get(id) as { n: number }).n))
      .toBe(1);
    expect(treeText(treeJson)).toBe(beforeText);
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

  it('does not treat OCR-only elements as normalized accessibility rows', () => {
    const id = insertFrame(db, { timestamp: isoMinutesAgo(30), treeJson });
    db.prepare(
      `INSERT INTO elements (frame_id, source, role, text, depth, sort_order)
       VALUES (?, 'ocr', 'OCRText', 'ocr only', 0, 0)`
    ).run(id);

    const result = svc().sweepOnce();
    expect(result.converted).toBe(1);
    expect(result.jsonNulledViaExisting).toBe(0);
    expect(
      Number(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM elements WHERE frame_id = ? AND source = 'accessibility'")
            .get(id) as { n: number }
        ).n
      )
    ).toBe(5);
    expect(
      Number((db.prepare("SELECT COUNT(*) AS n FROM elements WHERE frame_id = ? AND source = 'ocr'").get(id) as { n: number }).n)
    ).toBe(1);
  });

  it('does not treat referenced OCR-only elements as normalized accessibility rows', () => {
    const target = insertFrame(db, { timestamp: isoMinutesAgo(40) });
    db.prepare(
      `INSERT INTO elements (frame_id, source, role, text, depth, sort_order)
       VALUES (?, 'ocr', 'OCRText', 'ocr only', 0, 0)`
    ).run(target);
    const id = insertFrame(db, { timestamp: isoMinutesAgo(30), treeJson, elementsRefFrameId: target });

    const result = svc().sweepOnce();
    expect(result.converted).toBe(1);
    expect(result.jsonNulledViaExisting).toBe(0);
    const frame = db.prepare('SELECT elements_ref_frame_id AS ref FROM frames WHERE id = ?').get(id) as {
      ref: number;
    };
    expect(Number(frame.ref)).toBe(id);
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

  it('keeps converted tree payload under five percent for wrapper-heavy synthetic trees', () => {
    function wrappedTree(nodeCount: number) {
      return Array.from({ length: nodeCount }, (_, index) => ({
        role: index === 0 ? 'AXWindow' : 'AXStaticText',
        text: index === 0 ? 'Demo Window' : 'x',
        depth: index === 0 ? 0 : 1,
        bounds: {
          left: 0.12345678901234567,
          top: 0.22345678901234567,
          width: 0.32345678901234567,
          height: 0.42345678901234567,
          layout_cache: 'wrapper-only metadata '.repeat(120)
        },
        on_screen: true
      }));
    }

    let originalBytes = 0;
    for (let i = 0; i < 30; i += 1) {
      const json = JSON.stringify(wrappedTree(500));
      originalBytes += Buffer.byteLength(json);
      insertFrame(db, { timestamp: isoMinutesAgo(60), treeJson: json });
    }

    const result = createAxTreeMaintenanceService({ databasePath: dbPath, batchSize: 100 }).sweepOnce();
    expect(result.converted).toBe(30);
    const convertedPayload = Number(
      (
        db
          .prepare(
            `SELECT COALESCE(
               SUM(
                 LENGTH(role) +
                 COALESCE(LENGTH(text), 0) +
                 COALESCE(LENGTH(properties), 0) +
                 64
               ),
               0
             ) AS bytes
             FROM elements
             WHERE source = 'accessibility'`
          )
          .get() as { bytes: number }
      ).bytes
    );
    const residualJson = Number(
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(LENGTH(accessibility_tree_json)), 0) AS bytes
             FROM frames`
          )
          .get() as { bytes: number }
      ).bytes
    );
    expect((convertedPayload + residualJson) / originalBytes).toBeLessThanOrEqual(0.05);
  });

  it('does not leak SQLITE_BUSY when another writer holds the database lock', () => {
    const id = insertFrame(db, { timestamp: isoMinutesAgo(30), treeJson });
    const writer = new DatabaseSync(dbPath);
    try {
      writer.exec('BEGIN IMMEDIATE');
      expect(() =>
        createAxTreeMaintenanceService({ databasePath: dbPath, busyTimeoutMs: 25 }).sweepOnce()
      ).not.toThrow();
      const row = db.prepare('SELECT accessibility_tree_json AS t FROM frames WHERE id = ?').get(id) as {
        t: string | null;
      };
      expect(row.t).toBe(treeJson);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
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
