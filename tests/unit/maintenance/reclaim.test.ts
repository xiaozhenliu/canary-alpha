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
    insertFrame(db, { timestamp: isoMinutesAgo(60), elementsRefFrameId: 12_345 });
    const status = createAxTreeMaintenanceService({ databasePath: dbPath }).status();
    expect(status.framesWithTreeJson).toBe(1);
    expect(status.danglingRefs).toBe(1);
    expect(status.pageCount).toBeGreaterThan(0);
  });

  it('sweep and reclaim degrade to no-op when required schema is absent', () => {
    db.exec('DROP TABLE elements');
    const svc = createAxTreeMaintenanceService({ databasePath: dbPath });
    expect(svc.sweepOnce().skippedSchemaGuard).toBe(true);
    expect(svc.reclaimOnce({ maxPages: 100 }).skippedSchemaGuard).toBe(true);
  });
});
