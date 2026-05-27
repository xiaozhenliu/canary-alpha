/**
 * Coverage for the P0-2 fix: cascade failure must NOT be silently
 * swallowed. The privacy control service:
 *
 *   1. Captures the cascade error and propagates a structured
 *      `cascade: { upstreamDeleted: true, cascade: 'failed', ... }`
 *      result to the caller.
 *   2. Persists a `cascade-failure` tombstone to the privacy
 *      `suppressedRanges` so retrieval (`find` / `recall`) can
 *      filter the affected window until reconciliation.
 *   3. Reconciliation retries the cascade and, on success, marks
 *      the row `resolvedAt` so it stops gating retrieval.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DefaultPrivacyControlService } from '../../../src/services/privacy/privacy-control-service.js';
import type { PrivacyState, PrivacyStore } from '../../../src/services/privacy/types.js';
import type { CascadeDeleteCoordinator } from '../../../src/services/work-activity/cascade-delete-coordinator.js';
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
  vi.restoreAllMocks();
});

async function setupScreenpipe(frames: Array<{ id: number; timestamp: string }>): Promise<string> {
  const dir = await mkdtemp(join(testTempRoot(), 'cascade-failure-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE frames (id INTEGER PRIMARY KEY, timestamp TIMESTAMP NOT NULL);
     CREATE TABLE elements (id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL);`
  );
  const insertFrame = db.prepare('INSERT INTO frames(id, timestamp) VALUES (?, ?)');
  for (const frame of frames) insertFrame.run(frame.id, frame.timestamp);
  db.close();
  return dir;
}

describe('cascade failure is propagated and persisted as a tombstone', () => {
  it('writes a cascade-failure suppressed range when the cascade throws', async () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    const dir = await setupScreenpipe([
      { id: 1, timestamp: new Date(now.getTime() - 30 * 60 * 1000).toISOString() }
    ]);
    const store = new InMemoryPrivacyStore();
    const coordinator: CascadeDeleteCoordinator = {
      cascadeByFrameIds: vi.fn().mockRejectedValue(new Error('derived db is offline')),
      cascadeByTimestampRange: vi.fn().mockRejectedValue(new Error('derived db is offline'))
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const service = new DefaultPrivacyControlService(
      store,
      () => now,
      { screenpipeDirectory: dir },
      coordinator,
      logger
    );
    const result = await service.execute({ action: 'delete-range', range: 'last_1h', confirm: true });

    expect(result.error).toBeUndefined();
    expect(result.confirmed).toBe(true);
    expect(result.deletedFrames).toBe(1);
    expect(result.cascade).toBeDefined();
    expect(result.cascade?.upstreamDeleted).toBe(true);
    expect(result.cascade?.cascade).toBe('failed');
    expect(result.cascade?.failedFrameIds).toEqual([1]);
    expect(result.cascade?.reason).toContain('derived db is offline');
    expect(logger.warn).toHaveBeenCalled();

    const persisted = await store.read();
    const tombstones = (persisted.suppressedRanges ?? []).filter((range) => range.reason === 'cascade-failure');
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.failedFrameIds).toEqual([1]);
    expect(tombstones[0]?.resolvedAt).toBeUndefined();
  });

  it('reports cascade=ok when the coordinator succeeds', async () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    const dir = await setupScreenpipe([
      { id: 5, timestamp: new Date(now.getTime() - 10 * 60 * 1000).toISOString() }
    ]);
    const store = new InMemoryPrivacyStore();
    const coordinator: CascadeDeleteCoordinator = {
      cascadeByFrameIds: vi.fn().mockResolvedValue({
        extractedContent: 1,
        sessions: 1,
        embeddings: 1,
        fallbackUsed: 'none'
      }),
      cascadeByTimestampRange: vi.fn().mockResolvedValue({
        extractedContent: 0,
        sessions: 0,
        embeddings: 0,
        fallbackUsed: 'none'
      })
    };

    const service = new DefaultPrivacyControlService(
      store,
      () => now,
      { screenpipeDirectory: dir },
      coordinator
    );
    const result = await service.execute({ action: 'delete-range', range: 'last_1h', confirm: true });

    expect(result.cascade?.cascade).toBe('ok');
    expect(result.deletedExtractedContent).toBe(1);
    expect(result.deletedSessions).toBe(1);
    expect(result.deletedEmbeddings).toBe(1);

    const persisted = await store.read();
    const tombstones = (persisted.suppressedRanges ?? []).filter((range) => range.reason === 'cascade-failure');
    expect(tombstones).toHaveLength(0);
  });
});

describe('reconcileCascadeFailures', () => {
  it('retries unresolved cascade-failure rows and marks them resolved on success', async () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    const dir = await setupScreenpipe([
      { id: 7, timestamp: new Date(now.getTime() - 30 * 60 * 1000).toISOString() }
    ]);
    const store = new InMemoryPrivacyStore();

    let cascadeAttempts = 0;
    const coordinator: CascadeDeleteCoordinator = {
      cascadeByFrameIds: vi.fn().mockImplementation(async () => {
        cascadeAttempts += 1;
        if (cascadeAttempts === 1) {
          throw new Error('temporary failure');
        }
        return { extractedContent: 1, sessions: 1, embeddings: 1, fallbackUsed: 'none' };
      }),
      cascadeByTimestampRange: vi.fn().mockResolvedValue({
        extractedContent: 0,
        sessions: 0,
        embeddings: 0,
        fallbackUsed: 'none'
      })
    };

    const service = new DefaultPrivacyControlService(
      store,
      () => now,
      { screenpipeDirectory: dir },
      coordinator
    );

    // First call: cascade throws -> tombstone written.
    const failed = await service.execute({ action: 'delete-range', range: 'last_1h', confirm: true });
    expect(failed.cascade?.cascade).toBe('failed');

    // Reconcile: the coordinator now succeeds -> tombstone resolved.
    const resolved = await service.reconcileCascadeFailures();
    expect(resolved).toBe(1);

    const persisted = await store.read();
    const tombstones = (persisted.suppressedRanges ?? []).filter((range) => range.reason === 'cascade-failure');
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.resolvedAt).toBeDefined();
  });

  it('returns 0 when no unresolved tombstones exist', async () => {
    const store = new InMemoryPrivacyStore({
      paused: false,
      excludedApps: [],
      suppressedRanges: [{ from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T01:00:00.000Z', reason: 'pause' }]
    });
    const coordinator: CascadeDeleteCoordinator = {
      cascadeByFrameIds: vi.fn(),
      cascadeByTimestampRange: vi.fn()
    };
    const service = new DefaultPrivacyControlService(store, undefined, {}, coordinator);
    expect(await service.reconcileCascadeFailures()).toBe(0);
    expect(coordinator.cascadeByFrameIds).not.toHaveBeenCalled();
  });
});
