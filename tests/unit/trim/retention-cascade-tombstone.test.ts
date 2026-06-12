/**
 * P0-2 follow-up: retention pass cascade failures must NOT be
 * silently swallowed. When `cascadeByFrameIds` throws inside the
 * retention loop:
 *
 *   - the failure is logged via the supplied logger,
 *   - a `cascade-failure` tombstone is written to the privacy store,
 *   - the tombstone covers the affected frame-id set so retrieval
 *     tools (`find` / `recall`) can hide the orphaned derived rows
 *     until reconciliation.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runRetentionIfOverBudget } from '../../../src/services/capture/providers/screenpipe/trim-service.js';
import type { CascadeDeleteCoordinator } from '../../../src/services/work-activity/cascade-delete-coordinator.js';
import type { PrivacyState, PrivacyStore } from '../../../src/services/privacy/types.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

class InMemoryPrivacyStore implements PrivacyStore {
  constructor(private state: PrivacyState = { paused: false, excludedApps: [] }) {}
  async read(): Promise<PrivacyState> {
    return JSON.parse(JSON.stringify(this.state));
  }
  async write(state: PrivacyState): Promise<void> {
    this.state = JSON.parse(JSON.stringify(state));
  }
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setupFixture(frames: Array<{ id: number; timestamp: string }>): Promise<string> {
  const dir = await mkdtemp(join(testTempRoot(), 'retention-cascade-tombstone-'));
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
  return dbPath;
}

describe('runRetentionIfOverBudget — cascade failure persistence', () => {
  it('logs the failure and writes a cascade-failure tombstone covering the deleted frame ids and timestamps', async () => {
    const oldestDeletedAt = new Date(Date.now() - 12 * 24 * 60 * 60 * 1_000).toISOString();
    const newestDeletedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();
    const dbPath = await setupFixture([
      { id: 1001, timestamp: oldestDeletedAt },
      { id: 1002, timestamp: newestDeletedAt }
    ]);

    const cascade: CascadeDeleteCoordinator = {
      cascadeByFrameIds: vi.fn().mockRejectedValue(new Error('derived store offline')),
      cascadeByTimestampRange: vi.fn().mockRejectedValue(new Error('derived store offline'))
    };
    const privacyStore = new InMemoryPrivacyStore();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const result = await runRetentionIfOverBudget(dbPath, 1, 7, cascade, {
      privacyStore,
      logger
    });

    expect(result.framesDeleted).toBe(2);
    expect(logger.warn).toHaveBeenCalled();

    const persisted = await privacyStore.read();
    const tombstones = (persisted.suppressedRanges ?? []).filter(
      (range) => range.reason === 'cascade-failure'
    );
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.failedFrameIds?.sort((a, b) => a - b)).toEqual([1001, 1002]);
    expect(tombstones[0]?.resolvedAt).toBeUndefined();

    // The tombstone interval must actually cover the deleted
    // frames' timestamps, otherwise `find`/`recall` (which gate by
    // `[from, to]` interval) would still surface orphaned derived
    // rows. The interval should be `[oldestDeletedAt, newestDeletedAt]`.
    const tombstoneFrom = Date.parse(tombstones[0]!.from);
    const tombstoneTo = Date.parse(tombstones[0]!.to);
    expect(Date.parse(oldestDeletedAt)).toBeGreaterThanOrEqual(tombstoneFrom);
    expect(Date.parse(newestDeletedAt)).toBeLessThanOrEqual(tombstoneTo);
  });

  it('does not write a tombstone when no cascade coordinator is provided', async () => {
    const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000).toISOString();
    const dbPath = await setupFixture([{ id: 2001, timestamp: oldTimestamp }]);

    const privacyStore = new InMemoryPrivacyStore();

    await runRetentionIfOverBudget(dbPath, 1, 7, undefined, {
      privacyStore,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    });

    const persisted = await privacyStore.read();
    expect(persisted.suppressedRanges ?? []).toHaveLength(0);
  });
});
