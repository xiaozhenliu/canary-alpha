/**
 * Regression coverage for P2-6: the retention pass must delete the
 * exact set of frame ids it told the cascade coordinator about.
 *
 * Before the fix, retention used SELECT-then-DELETE with two
 * separate `ORDER BY timestamp ASC LIMIT N` queries; under tied
 * timestamps the second query could return a different id set
 * than the first, so the cascade coordinator would receive stale
 * frame ids while the upstream DB had actually deleted others.
 *
 * The new implementation:
 *   1. SELECTs the candidate ids,
 *   2. DELETEs by `id IN (?, ?, ...)` with the exact same id list,
 *   3. uses SQLite `changes()` to confirm the delete count.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runRetentionIfOverBudget } from '../../../src/services/capture/providers/screenpipe/trim-service.js';
import type { CascadeDeleteCoordinator } from '../../../src/services/work-activity/cascade-delete-coordinator.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setupFixture(frames: Array<{ id: number; timestamp: string }>): Promise<{
  dir: string;
  dbPath: string;
}> {
  const dir = await mkdtemp(join(testTempRoot(), 'retention-determinism-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE frames (
       id INTEGER PRIMARY KEY,
       timestamp TIMESTAMP NOT NULL,
       content_hash TEXT,
       accessibility_tree_json TEXT
     );
     CREATE TABLE elements (
       id INTEGER PRIMARY KEY,
       frame_id INTEGER NOT NULL
     );`
  );
  const insertFrame = db.prepare('INSERT INTO frames(id, timestamp) VALUES (?, ?)');
  const insertElement = db.prepare('INSERT INTO elements(id, frame_id) VALUES (?, ?)');
  for (const frame of frames) {
    insertFrame.run(frame.id, frame.timestamp);
    insertElement.run(frame.id, frame.id);
  }
  db.close();
  return { dir, dbPath };
}

function readFrameIds(dbPath: string): number[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare('SELECT id FROM frames ORDER BY id ASC').all() as Array<{ id: number | bigint }>;
    return rows.map((row) => Number(row.id));
  } finally {
    db.close();
  }
}

describe('runRetentionIfOverBudget — tied timestamps and id determinism', () => {
  it('cascade receives the exact set of frame ids deleted from frames', async () => {
    // Build a fixture where 5 frames share an identical "10 days
    // ago" timestamp, plus one fresh frame. With the budget set to
    // 1 byte, retention runs until reachedFloor=true. We pin the
    // batch size at the default 100, so all 5 old frames go in a
    // single batch. The assertion is that the cascade input set
    // equals the actually-deleted-from-frames id set.
    const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000).toISOString();
    const fresh = new Date(Date.now() - 60 * 1_000).toISOString();
    const frames = [
      { id: 100, timestamp: oldTimestamp },
      { id: 101, timestamp: oldTimestamp },
      { id: 102, timestamp: oldTimestamp },
      { id: 103, timestamp: oldTimestamp },
      { id: 104, timestamp: oldTimestamp },
      { id: 200, timestamp: fresh } // outside the retention floor
    ];
    const { dbPath } = await setupFixture(frames);

    const cascadeCalls: number[][] = [];
    const cascade: CascadeDeleteCoordinator = {
      cascadeByFrameIds: vi.fn().mockImplementation(async (ids: number[]) => {
        cascadeCalls.push([...ids]);
        return { extractedContent: 0, sessions: 0, embeddings: 0, fallbackUsed: 'none' };
      }),
      cascadeByTimestampRange: vi.fn().mockResolvedValue({
        extractedContent: 0,
        sessions: 0,
        embeddings: 0,
        fallbackUsed: 'none'
      })
    };

    const result = await runRetentionIfOverBudget(dbPath, 1, 7, cascade);

    expect(result.framesDeleted).toBe(5);
    expect(result.reachedFloor).toBe(true);

    // Cascade should have been called with the same ids that
    // were actually removed.
    const remainingIds = readFrameIds(dbPath);
    const expectedDeletedIds = [100, 101, 102, 103, 104].filter(
      (id) => !remainingIds.includes(id)
    );
    expect(cascadeCalls.length).toBeGreaterThan(0);
    const flattened = cascadeCalls.flat().sort((a, b) => a - b);
    expect(flattened).toEqual(expectedDeletedIds);
    // The fresh frame stays.
    expect(remainingIds).toContain(200);
  });

  it('handles N+1 frames sharing the same timestamp by capping at the batch limit', async () => {
    // Default RETENTION_BATCH_SIZE is 100. Build 101 frames at
    // the same old timestamp + 1 fresh frame. The first iteration
    // deletes exactly 100; the second iteration (still over
    // budget, still rows older than floor) deletes the last 1.
    const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000).toISOString();
    const fresh = new Date(Date.now() - 60 * 1_000).toISOString();
    const frames: Array<{ id: number; timestamp: string }> = [];
    for (let i = 0; i < 101; i += 1) {
      frames.push({ id: 1_000 + i, timestamp: oldTimestamp });
    }
    frames.push({ id: 9_999, timestamp: fresh });
    const { dbPath } = await setupFixture(frames);

    const cascadeIds: number[] = [];
    const cascade: CascadeDeleteCoordinator = {
      cascadeByFrameIds: vi.fn().mockImplementation(async (ids: number[]) => {
        cascadeIds.push(...ids);
        return { extractedContent: 0, sessions: 0, embeddings: 0, fallbackUsed: 'none' };
      }),
      cascadeByTimestampRange: vi.fn().mockResolvedValue({
        extractedContent: 0,
        sessions: 0,
        embeddings: 0,
        fallbackUsed: 'none'
      })
    };

    const result = await runRetentionIfOverBudget(dbPath, 1, 7, cascade);
    expect(result.framesDeleted).toBe(101);
    const remaining = readFrameIds(dbPath);
    expect(remaining).toEqual([9_999]);
    // Cascade should have been told about every single one.
    expect(cascadeIds.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 101 }, (_, i) => 1_000 + i)
    );
  });
});
