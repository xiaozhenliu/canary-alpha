/**
 * Integration test for RoutineScheduler + FileRoutineStore.
 *
 * Uses a real FileRoutineStore pointing at a temp directory and a
 * real RoutineScheduler. Because cron tasks fire on real wall-clock
 * schedules, the test invokes the private `fireRoutine` method
 * directly rather than waiting for a cron tick.
 *
 * Coverage:
 *  - A definition written to FileRoutineStore is picked up by start()
 *  - Execution is performed and the run record is persisted to disk
 *  - listRuns() returns the persisted record after the scheduler fires
 *  - The full no-overlap path works with the real store (skipped record persisted)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoutineScheduler } from '../../../src/services/routines/scheduler.js';
import { FileRoutineStore } from '../../../src/services/routines/routine-store.js';
import type { RoutineExecutor, RoutineExecutionResult } from '../../../src/services/routines/executor.js';
import type { RoutineDefinition } from '../../../src/services/routines/types.js';
import type { Logger } from '../../../src/types/app-config.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefinition(overrides: Partial<RoutineDefinition> = {}): RoutineDefinition {
  const now = '2026-06-01T09:00:00.000Z';
  return {
    name: 'daily-summary',
    // Every-minute cron — used only as valid expression; we call fireRoutine directly.
    schedule: '* * * * *',
    enabled: true,
    prompt: 'Summarize the day',
    recentActivityMinutes: 60,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  };
}

/**
 * Stub executor that always succeeds with a fixed result.
 * Optionally blocks until `unblock()` is called.
 */
class StubExecutor implements RoutineExecutor {
  private _resolveBlocked?: () => void;
  private _blocked: Promise<void> | null = null;

  blockNext(): void {
    this._blocked = new Promise<void>((resolve) => {
      this._resolveBlocked = resolve;
    });
  }

  unblock(): void {
    this._resolveBlocked?.();
    this._blocked = null;
  }

  async execute(definition: RoutineDefinition): Promise<RoutineExecutionResult> {
    if (this._blocked) {
      await this._blocked;
    }
    return {
      summary: `done: ${definition.name}`,
      output: `detailed output for ${definition.name}`
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fireRoutine(scheduler: RoutineScheduler, name: string): Promise<void> {
  return (scheduler as unknown as Record<string, (name: string) => Promise<void>>)['fireRoutine'](name);
}

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let tempDir: string;
let store: FileRoutineStore;
let executor: StubExecutor;
let logger: Logger;
let scheduler: RoutineScheduler;

beforeEach(async () => {
  tempDir = await mkdtemp(join(testTempRoot(), 'routines-integration-'));
  const definitionsDirectory = join(tempDir, 'definitions');
  const historyDirectory = join(tempDir, 'history');
  store = new FileRoutineStore({ definitionsDirectory, historyDirectory });
  executor = new StubExecutor();
  logger = makeLogger();
  scheduler = new RoutineScheduler({ routineStore: store, executor, logger });
});

afterEach(async () => {
  scheduler.stop();
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoutineScheduler + FileRoutineStore integration', () => {
  it('picks up a written definition and persists a success run record', async () => {
    const def = makeDefinition();
    await store.writeDefinition(def);

    await scheduler.start();
    await fireRoutine(scheduler, def.name);

    const runs = await store.listRuns(def.name, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(runs[0].name).toBe(def.name);
    expect(runs[0].summary).toBe(`done: ${def.name}`);
    expect(runs[0].output).toBe(`detailed output for ${def.name}`);
    expect(runs[0].runId).toBeDefined();
    expect(runs[0].startedAt).toBeDefined();
    expect(runs[0].completedAt).toBeDefined();
  });

  it('persists a skipped run record when the routine fires while already running', async () => {
    const def = makeDefinition();
    await store.writeDefinition(def);

    await scheduler.start();

    // Block the first execution.
    executor.blockNext();
    const firstFire = fireRoutine(scheduler, def.name);

    // Fire again while the first is blocked.
    await fireRoutine(scheduler, def.name);

    // Unblock and await completion.
    executor.unblock();
    await firstFire;

    const runs = await store.listRuns(def.name, 10);
    // Two run records: one success and one skipped.
    expect(runs).toHaveLength(2);

    const statuses = runs.map((r) => r.status).sort();
    expect(statuses).toEqual(['skipped', 'success']);

    const skipped = runs.find((r) => r.status === 'skipped');
    expect(skipped?.summary).toMatch(/Skipped.*previous run still in progress/);
  });

  it('does not register a task for an invalid cron expression', async () => {
    const badDef = makeDefinition({ name: 'bad-cron', schedule: 'definitely not cron' });
    const goodDef = makeDefinition({ name: 'good-cron', schedule: '0 9 * * *' });
    await store.writeDefinition(badDef);
    await store.writeDefinition(goodDef);

    await scheduler.start();

    // Warn should be emitted for the bad definition.
    const warnArgs = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => JSON.stringify(c));
    expect(warnArgs.some((a) => a.includes('bad-cron'))).toBe(true);

    // Good definition: fire it manually to confirm it was registered correctly.
    await fireRoutine(scheduler, 'good-cron');
    const runs = await store.listRuns('good-cron', 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
  });

  it('run records survive a new FileRoutineStore instance (data is truly persisted)', async () => {
    const def = makeDefinition();
    await store.writeDefinition(def);

    await scheduler.start();
    await fireRoutine(scheduler, def.name);
    scheduler.stop();

    // Open a fresh store pointing at the same directory.
    const definitionsDirectory = join(tempDir, 'definitions');
    const historyDirectory = join(tempDir, 'history');
    const freshStore = new FileRoutineStore({ definitionsDirectory, historyDirectory });

    const runs = await freshStore.listRuns(def.name, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
  });

  it('accumulates multiple run records across successive fires', async () => {
    const def = makeDefinition();
    await store.writeDefinition(def);

    await scheduler.start();

    await fireRoutine(scheduler, def.name);
    await fireRoutine(scheduler, def.name);
    await fireRoutine(scheduler, def.name);

    const runs = await store.listRuns(def.name, 10);
    expect(runs).toHaveLength(3);
    // All should be successful.
    expect(runs.every((r) => r.status === 'success')).toBe(true);
    // All run IDs should be unique.
    const ids = new Set(runs.map((r) => r.runId));
    expect(ids.size).toBe(3);
  });
});
