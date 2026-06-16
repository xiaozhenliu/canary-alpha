/**
 * Unit tests for RoutineScheduler.
 *
 * Uses in-memory stubs for RoutineStore and RoutineExecutor so the
 * tests run without any file I/O or real cron timers.
 *
 * Coverage:
 *  - Scheduler reads enabled definitions and registers cron tasks
 *  - Invalid cron expressions are skipped with a warning
 *  - No-overlap guard: a second fire while a routine is running records 'skipped'
 *  - start/stop lifecycle: tasks are created on start, cleared on stop
 *  - Executor failure is captured as a 'failed' run record
 *  - Disabled routine at fire-time records 'skipped'
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoutineScheduler } from '../../../src/services/routines/scheduler.js';
import type { RoutineExecutor, RoutineExecutionResult } from '../../../src/services/routines/executor.js';
import type { RoutineDefinition, RoutineRunRecord, RoutineStore } from '../../../src/services/routines/types.js';
import type { Logger } from '../../../src/types/app-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefinition(overrides: Partial<RoutineDefinition> = {}): RoutineDefinition {
  const now = '2026-06-01T09:00:00.000Z';
  return {
    name: 'daily-summary',
    schedule: '0 9 * * *',
    enabled: true,
    prompt: 'Summarize the day',
    recentActivityMinutes: 60,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

/** Minimal logger stub that records warn calls for assertions. */
function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  } satisfies Logger;
}

/**
 * In-memory RoutineStore stub.
 *
 * Holds a definition map and a run-record list. Exposes `runs` for
 * inspection by tests, and `overrideDefinition` to mutate what
 * `readDefinition` returns mid-test (simulating a definition change
 * between start() and a cron fire).
 */
class StubRoutineStore implements RoutineStore {
  private readonly definitions = new Map<string, RoutineDefinition>();
  readonly runs: RoutineRunRecord[] = [];

  constructor(initial: RoutineDefinition[] = []) {
    for (const d of initial) {
      this.definitions.set(d.name, d);
    }
  }

  overrideDefinition(name: string, def: RoutineDefinition | undefined): void {
    if (def === undefined) {
      this.definitions.delete(name);
    } else {
      this.definitions.set(name, def);
    }
  }

  async listDefinitions(): Promise<RoutineDefinition[]> {
    return [...this.definitions.values()];
  }

  async readDefinition(name: string): Promise<RoutineDefinition | undefined> {
    return this.definitions.get(name);
  }

  async writeDefinition(definition: RoutineDefinition): Promise<boolean> {
    const existed = this.definitions.has(definition.name);
    this.definitions.set(definition.name, definition);
    return !existed;
  }

  async appendRun(record: RoutineRunRecord): Promise<void> {
    this.runs.push(record);
  }

  async listRuns(_name: string, _limit: number): Promise<RoutineRunRecord[]> {
    return this.runs;
  }
}

/**
 * Controllable RoutineExecutor stub.
 *
 * Default behaviour: resolves immediately with a fixed result.
 * Can be configured to throw or to block via an externally-controlled
 * Promise so the no-overlap test can inject a second fire while the
 * first is still in flight.
 */
class StubExecutor implements RoutineExecutor {
  private _resolveBlocked?: () => void;
  private _blocked: Promise<void> | null = null;
  private _shouldThrow = false;
  private _throwMessage = 'executor error';

  readonly calls: string[] = [];

  /** Make the next execute() call block until `unblock()` is called. */
  blockNext(): void {
    this._blocked = new Promise<void>((resolve) => {
      this._resolveBlocked = resolve;
    });
  }

  /** Unblock a previously blocked execute() call. */
  unblock(): void {
    this._resolveBlocked?.();
    this._blocked = null;
  }

  /** Make the next execute() call throw. */
  failNext(message = 'executor error'): void {
    this._shouldThrow = true;
    this._throwMessage = message;
  }

  async execute(definition: RoutineDefinition): Promise<RoutineExecutionResult> {
    this.calls.push(definition.name);

    if (this._blocked) {
      await this._blocked;
    }

    if (this._shouldThrow) {
      this._shouldThrow = false;
      throw new Error(this._throwMessage);
    }

    return {
      summary: `summary for ${definition.name}`,
      output: `output for ${definition.name}`
    };
  }
}

// ---------------------------------------------------------------------------
// Direct fireRoutine invocation helper
//
// node-cron tasks fire on real wall-clock schedule, which is unsuitable
// for fast unit tests. We call the private `fireRoutine` method directly
// (as `(scheduler as any).fireRoutine(name)`) to exercise the scheduling
// logic without waiting for a real cron tick.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fireRoutine(scheduler: RoutineScheduler, name: string): Promise<void> {
  return (scheduler as unknown as Record<string, (name: string) => Promise<void>>)['fireRoutine'](name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoutineScheduler — cron task registration', () => {
  it('registers a cron task for each enabled definition', async () => {
    const store = new StubRoutineStore([
      makeDefinition({ name: 'daily-summary', enabled: true }),
      makeDefinition({ name: 'weekly-review', enabled: true, schedule: '0 9 * * 1' })
    ]);
    const executor = new StubExecutor();
    const logger = makeLogger();
    const scheduler = new RoutineScheduler({ routineStore: store, executor, logger });

    await scheduler.start();

    // Both enabled definitions should be registered (no invalid-schedule warning).
    expect(logger.warn).not.toHaveBeenCalled();
    // Info logs should mention both routine names.
    const infoArgs = logger.info.mock.calls.map((c) => JSON.stringify(c));
    expect(infoArgs.some((a) => a.includes('daily-summary'))).toBe(true);
    expect(infoArgs.some((a) => a.includes('weekly-review'))).toBe(true);

    scheduler.stop();
  });

  it('skips disabled definitions during start()', async () => {
    const store = new StubRoutineStore([
      makeDefinition({ name: 'active', enabled: true }),
      makeDefinition({ name: 'paused', enabled: false })
    ]);
    const executor = new StubExecutor();
    const logger = makeLogger();
    const scheduler = new RoutineScheduler({ routineStore: store, executor, logger });

    await scheduler.start();

    // Only 'active' should appear in info logs as scheduled.
    const scheduledLogs = logger.info.mock.calls
      .filter((c) => String(c[0]).includes('scheduled'))
      .map((c) => JSON.stringify(c));
    expect(scheduledLogs.some((a) => a.includes('active'))).toBe(true);
    expect(scheduledLogs.some((a) => a.includes('paused'))).toBe(false);

    scheduler.stop();
  });

  it('rejects invalid cron expressions and logs a warning', async () => {
    const store = new StubRoutineStore([
      makeDefinition({ name: 'bad-cron', schedule: 'not a valid cron' }),
      makeDefinition({ name: 'good-cron', schedule: '0 9 * * *' })
    ]);
    const executor = new StubExecutor();
    const logger = makeLogger();
    const scheduler = new RoutineScheduler({ routineStore: store, executor, logger });

    await scheduler.start();

    // Invalid cron expression triggers a warning.
    const warnArgs = logger.warn.mock.calls.map((c) => JSON.stringify(c));
    expect(warnArgs.some((a) => a.includes('bad-cron'))).toBe(true);
    expect(warnArgs.some((a) => a.includes('invalid cron'))).toBe(true);

    // The valid one still gets scheduled (no additional warn for it).
    const warnForGood = warnArgs.some((a) => a.includes('good-cron'));
    expect(warnForGood).toBe(false);

    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------

describe('RoutineScheduler — start/stop lifecycle', () => {
  it('stop() clears all tasks without throwing', async () => {
    const store = new StubRoutineStore([makeDefinition()]);
    const executor = new StubExecutor();
    const logger = makeLogger();
    const scheduler = new RoutineScheduler({ routineStore: store, executor, logger });

    await scheduler.start();
    // Should not throw.
    expect(() => scheduler.stop()).not.toThrow();

    // Calling stop() again is safe.
    expect(() => scheduler.stop()).not.toThrow();
  });

  it('stop() logs the correct count of tasks destroyed', async () => {
    const store = new StubRoutineStore([
      makeDefinition({ name: 'r1' }),
      makeDefinition({ name: 'r2', schedule: '0 10 * * *' })
    ]);
    const executor = new StubExecutor();
    const logger = makeLogger();
    const scheduler = new RoutineScheduler({ routineStore: store, executor, logger });

    await scheduler.start();
    scheduler.stop();

    const stopLog = logger.info.mock.calls.find((c) => String(c[0]).includes('stopping'));
    expect(stopLog).toBeDefined();
    // The metadata object should report count: 2.
    expect(stopLog?.[1]).toMatchObject({ count: 2 });
  });

  it('start() with no definitions starts successfully with count 0', async () => {
    const store = new StubRoutineStore([]);
    const executor = new StubExecutor();
    const logger = makeLogger();
    const scheduler = new RoutineScheduler({ routineStore: store, executor, logger });

    await expect(scheduler.start()).resolves.toBeUndefined();
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------

describe('RoutineScheduler — fireRoutine (no-overlap + success path)', () => {
  it('executes a routine and records a success run', async () => {
    const def = makeDefinition();
    const store = new StubRoutineStore([def]);
    const executor = new StubExecutor();
    const logger = makeLogger();
    const scheduler = new RoutineScheduler({ routineStore: store, executor, logger });

    await scheduler.start();
    await fireRoutine(scheduler, def.name);
    scheduler.stop();

    expect(executor.calls).toEqual([def.name]);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].status).toBe('success');
    expect(store.runs[0].name).toBe(def.name);
    expect(store.runs[0].summary).toBe(`summary for ${def.name}`);
    expect(store.runs[0].output).toBe(`output for ${def.name}`);
  });

  it('no-overlap: a second fire while the first is running records skipped', async () => {
    const def = makeDefinition();
    const store = new StubRoutineStore([def]);
    const executor = new StubExecutor();
    const logger = makeLogger();
    const scheduler = new RoutineScheduler({ routineStore: store, executor, logger });

    await scheduler.start();

    // Block the first execution so we can fire again before it completes.
    executor.blockNext();
    const firstFire = fireRoutine(scheduler, def.name);

    // Fire again while the first is still in progress.
    await fireRoutine(scheduler, def.name);

    // Unblock and wait for the first to complete.
    executor.unblock();
    await firstFire;

    scheduler.stop();

    // First run: success; second run (fired while first was running): skipped.
    const runStatuses = store.runs.map((r) => r.status);
    expect(runStatuses).toContain('success');
    expect(runStatuses).toContain('skipped');

    const skippedRun = store.runs.find((r) => r.status === 'skipped');
    expect(skippedRun?.summary).toMatch(/Skipped.*previous run still in progress/);
  });

  it('records a failed run when the executor throws', async () => {
    const def = makeDefinition();
    const store = new StubRoutineStore([def]);
    const executor = new StubExecutor();
    const logger = makeLogger();
    const scheduler = new RoutineScheduler({ routineStore: store, executor, logger });

    await scheduler.start();
    executor.failNext('simulated executor failure');
    await fireRoutine(scheduler, def.name);
    scheduler.stop();

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].status).toBe('failed');
    expect(store.runs[0].error?.message).toBe('simulated executor failure');
    expect(store.runs[0].summary).toMatch(/Error: simulated executor failure/);
  });

  it('records a skipped run when the definition is disabled at fire-time', async () => {
    const def = makeDefinition({ enabled: true });
    const store = new StubRoutineStore([def]);
    const executor = new StubExecutor();
    const logger = makeLogger();
    const scheduler = new RoutineScheduler({ routineStore: store, executor, logger });

    await scheduler.start();

    // Disable the routine between start() and fire.
    store.overrideDefinition(def.name, { ...def, enabled: false });
    await fireRoutine(scheduler, def.name);

    scheduler.stop();

    expect(executor.calls).toHaveLength(0);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].status).toBe('skipped');
    expect(store.runs[0].summary).toMatch(/Skipped.*routine is disabled/);
  });

  it('removes the cron task when the definition is deleted between start and fire', async () => {
    const def = makeDefinition();
    const store = new StubRoutineStore([def]);
    const executor = new StubExecutor();
    const logger = makeLogger();
    const scheduler = new RoutineScheduler({ routineStore: store, executor, logger });

    await scheduler.start();

    // Delete the definition from the store.
    store.overrideDefinition(def.name, undefined);
    await fireRoutine(scheduler, def.name);

    scheduler.stop();

    // Executor should not have been called; no run record persisted.
    expect(executor.calls).toHaveLength(0);
    expect(store.runs).toHaveLength(0);

    // Warning should be logged.
    const warnArgs = logger.warn.mock.calls.map((c) => JSON.stringify(c));
    expect(warnArgs.some((a) => a.includes('not found'))).toBe(true);
  });
});
