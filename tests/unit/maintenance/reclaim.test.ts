import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAxTreeMaintenanceService } from '../../../src/services/maintenance/ax-tree-maintenance-service.js';
import { createFixtureDb, insertFrame, isoMinutesAgo } from '../../helpers/maintenance-fixture.js';

describe('reclaim & status', () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ax-reclaim-'));
    dbPath = join(dir, 'db.sqlite');
    db = createFixtureDb(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reclaims pages on an incremental auto_vacuum database', () => {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;');
    const big = 'x'.repeat(100_000);
    for (let i = 0; i < 50; i += 1) {
      insertFrame(db, { timestamp: isoMinutesAgo(60), treeJson: big });
    }
    const before = Number((db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count);
    db.prepare('DELETE FROM frames').run();
    const result = createAxTreeMaintenanceService({ databasePath: dbPath }).reclaimOnce({ maxPages: 100_000 });
    const after = Number((db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count);
    expect(result.skippedSchemaGuard).toBe(false);
    expect(after).toBeLessThan(before);
    const freelist = Number((db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count);
    expect(freelist / after).toBeLessThan(0.1);
  });

  it('status reports residual JSON frames and dangling refs', () => {
    insertFrame(db, { timestamp: isoMinutesAgo(60), treeJson: '[]' });
    insertFrame(db, { timestamp: isoMinutesAgo(60), treeJson: '[]', elementsRefFrameId: 12_345 });
    const status = createAxTreeMaintenanceService({ databasePath: dbPath }).status();
    expect(status.framesWithTreeJson).toBe(2);
    expect(status.danglingRefs).toBe(1);
    expect(status.pageCount).toBeGreaterThan(0);
  });

  it('status treats OCR-only referenced elements as dangling for accessibility maintenance', () => {
    const target = insertFrame(db, { timestamp: isoMinutesAgo(60) });
    db.prepare(
      `INSERT INTO elements (frame_id, source, role, text, depth, sort_order)
       VALUES (?, 'ocr', 'OCRText', 'ocr only', 0, 0)`
    ).run(target);
    insertFrame(db, { timestamp: isoMinutesAgo(60), treeJson: '[]', elementsRefFrameId: target });
    const status = createAxTreeMaintenanceService({ databasePath: dbPath }).status();
    expect(status.danglingRefs).toBe(1);
  });

  it('status ignores stale refs that no longer have tree JSON to repair', () => {
    const target = insertFrame(db, { timestamp: isoMinutesAgo(60) });
    db.prepare(
      `INSERT INTO elements (frame_id, source, role, text, depth, sort_order)
       VALUES (?, 'ocr', 'OCRText', 'ocr only', 0, 0)`
    ).run(target);
    insertFrame(db, { timestamp: isoMinutesAgo(60), elementsRefFrameId: target });
    insertFrame(db, { timestamp: isoMinutesAgo(60), elementsRefFrameId: 99_999 });
    const status = createAxTreeMaintenanceService({ databasePath: dbPath }).status();
    expect(status.framesWithTreeJson).toBe(0);
    expect(status.danglingRefs).toBe(0);
  });

  it('sweep and reclaim degrade to no-op when required schema is absent', () => {
    db.exec('DROP TABLE elements');
    const svc = createAxTreeMaintenanceService({ databasePath: dbPath });
    expect(svc.sweepOnce().skippedSchemaGuard).toBe(true);
    expect(svc.reclaimOnce({ maxPages: 100 }).skippedSchemaGuard).toBe(true);
    expect(svc.status().skippedSchemaGuard).toBe(true);
  });

  it('reclaim degrades to no-op when another writer holds the lock', () => {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;');
    const writer = new DatabaseSync(dbPath);
    try {
      writer.exec('BEGIN IMMEDIATE');
      const result = createAxTreeMaintenanceService({ databasePath: dbPath, busyTimeoutMs: 25 }).reclaimOnce({
        maxPages: 100
      });
      expect(result.skippedBusy).toBe(true);
      expect(result.pagesAfter).toBe(result.pagesBefore);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  it('reclaim reports busy instead of schema drift when schema reads are locked', () => {
    db.exec('PRAGMA journal_mode = DELETE;');
    const writer = new DatabaseSync(dbPath);
    try {
      writer.exec('BEGIN EXCLUSIVE');
      const result = createAxTreeMaintenanceService({ databasePath: dbPath, busyTimeoutMs: 25 }).reclaimOnce({
        maxPages: 100
      });
      expect(result.skippedBusy).toBe(true);
      expect(result.skippedSchemaGuard).toBe(false);
      expect(result.pagesAfter).toBe(result.pagesBefore);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  it('degrades before converting when an actually written elements column is missing', () => {
    db.exec('ALTER TABLE elements DROP COLUMN on_screen');
    insertFrame(db, { timestamp: isoMinutesAgo(60), treeJson: '[]' });
    const svc = createAxTreeMaintenanceService({ databasePath: dbPath });
    expect(svc.sweepOnce().skippedSchemaGuard).toBe(true);
    expect(svc.status().skippedSchemaGuard).toBe(true);
  });

  it('degrades before converting when elements.id is not an integer primary key', () => {
    db.close();
    db = new DatabaseSync(dbPath);
    db.exec(`
      DROP TABLE elements;
      CREATE TABLE elements (
        frame_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT,
        parent_id INTEGER,
        depth INTEGER NOT NULL DEFAULT 0,
        left_bound REAL,
        top_bound REAL,
        width_bound REAL,
        height_bound REAL,
        confidence REAL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        properties TEXT,
        on_screen INTEGER
      );
    `);
    insertFrame(db, { timestamp: isoMinutesAgo(60), treeJson: '[]' });
    const svc = createAxTreeMaintenanceService({ databasePath: dbPath });
    expect(svc.sweepOnce().skippedSchemaGuard).toBe(true);
  });
});
