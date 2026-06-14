/**
 * Property-based tests for the Trim_Service scheduling and budget behaviour.
 *
 * Task 6.3 — Property 6: Trim 调度时序恒不超过配置间隔
 * Validates: Requirements 2.1
 *
 * The property: for any N consecutive trim cycles driven by a fake clock,
 * the elapsed time between consecutive runOnce invocations is ≤
 * config.trim.intervalSeconds.
 *
 * We test `startTrimPoller` (from src/bootstrap/create-app.ts) directly,
 * using vitest's fake timers to control the clock and a spy on `runTrimOnce`
 * to record when each invocation starts.
 */

import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startTrimPoller } from '../../../src/bootstrap/create-app.js';
import type { AppConfig, Logger } from '../../../src/types/app-config.js';

// ---------------------------------------------------------------------------
// Module-level mock for runTrimOnce — must be hoisted before any imports
// ---------------------------------------------------------------------------

vi.mock('../../../src/services/capture/providers/screenpipe/trim-service.js', () => ({
  runTrimOnce: vi.fn().mockResolvedValue({
    framesDeleted: 0,
    elementsDeleted: 0,
    reachedFloor: false,
    durationMs: 0
  })
}));

// Import the mocked module at the top level so we can reference it in tests
import { runTrimOnce as mockRunTrimOnce } from '../../../src/services/capture/providers/screenpipe/trim-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal logger stub that discards all output. */
function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  };
}

/** Build a minimal AppConfig with the given trim interval. */
function makeConfig(intervalSeconds: number): AppConfig {
  return {
    server: { mode: 'stdio', host: '127.0.0.1', port: 3000, maxConnections: 10 },
    logging: { level: 'error' },
    screenpipe: {},
    providers: { embeddings: { kind: 'ollama' } },
    vectorStore: { kind: 'memory' },
    retrieval: {
      freshnessWindowMinutes: 60,
      pollIntervalSeconds: 60,
      maxCatchUpBatches: 10,
      maxCatchUpRecords: 1000
    },
    routines: { enabled: false, definitionsPath: '', historyPath: '' },
    paths: { configFile: '', logDirectory: '', serviceLogFile: '', derivedDatabase: '' },
    trim: { enabled: true, intervalSeconds },
    capture: { provider: 'screenpipe', livenessThresholdSeconds: 120, permissionsGracePeriodSeconds: 60 },
    storage: { diskBudgetBytes: null, retentionDays: 7 },
    privacy: { excludeApps: ['1Password', 'Keychain Access'], secureAxRoles: ['AXSecureTextField'] },
    analysis: {
      sessions: { idleThresholdSeconds: 120 },
      summary: { provider: 'template', remoteLlmTimeoutMs: 30000 },
      embeddings: { topK: 20, minScore: 0 }
    },
    llm: { model: 'gpt-4o-mini' }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 6: Trim 调度时序恒不超过配置间隔', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(mockRunTrimOnce).mockClear();
    vi.mocked(mockRunTrimOnce).mockResolvedValue({
      framesDeleted: 0,
      elementsDeleted: 0,
      reachedFloor: false,
      durationMs: 0
    });
  });

  afterEach(() => {
    // Clear all pending timers so they don't bleed into the next test
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.mocked(mockRunTrimOnce).mockClear();
  });

  /**
   * **Property 6: Trim 调度时序恒不超过配置间隔**
   * **Validates: Requirements 2.1**
   *
   * For any intervalSeconds ∈ [1, 3600] and N ∈ [2, 10] consecutive cycles,
   * the wall-clock gap between consecutive runOnce start times must be
   * ≤ intervalSeconds (in seconds).
   *
   * Implementation note: `startTrimPoller` uses `setInterval(trimOnce, intervalMs)`.
   * Each tick fires exactly once per interval. We advance fake time by
   * `intervalMs` per tick and record the fake `Date.now()` at each invocation.
   */
  it('consecutive runOnce invocations are spaced ≤ intervalSeconds apart', async () => {
    await fc.assert(
      fc.asyncProperty(
        // intervalSeconds: 1..3600
        fc.integer({ min: 1, max: 3600 }),
        // N: number of cycles to simulate (2..10)
        fc.integer({ min: 2, max: 10 }),
        async (intervalSeconds, N) => {
          // Reset fake timers and mock for each property run
          vi.clearAllTimers();
          vi.mocked(mockRunTrimOnce).mockClear();

          // Record fake Date.now() at each invocation start
          const invocationTimes: number[] = [];
          vi.mocked(mockRunTrimOnce).mockImplementation(async () => {
            invocationTimes.push(Date.now());
            return { framesDeleted: 0, elementsDeleted: 0, reachedFloor: false, durationMs: 0 };
          });

          const config = makeConfig(intervalSeconds);
          startTrimPoller({ config, logger: makeLogger() });

          const intervalMs = intervalSeconds * 1_000;

          // Advance fake clock N times, one interval per tick
          for (let i = 0; i < N; i++) {
            await vi.advanceTimersByTimeAsync(intervalMs);
          }

          // We should have at least N invocations (one per interval tick)
          expect(invocationTimes.length).toBeGreaterThanOrEqual(N);

          // Check that consecutive invocations are spaced ≤ intervalSeconds apart
          for (let i = 1; i < invocationTimes.length; i++) {
            const gapMs = invocationTimes[i] - invocationTimes[i - 1];
            const gapSeconds = gapMs / 1_000;
            expect(gapSeconds).toBeLessThanOrEqual(intervalSeconds);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Concrete example: intervalSeconds=5, 3 cycles.
   * Invocations should occur at t=5s, t=10s, t=15s — each gap exactly 5s ≤ 5s.
   */
  it('concrete example: 5s interval, 3 cycles — gaps are exactly 5s', async () => {
    const invocationTimes: number[] = [];
    vi.mocked(mockRunTrimOnce).mockImplementation(async () => {
      invocationTimes.push(Date.now());
      return { framesDeleted: 0, elementsDeleted: 0, reachedFloor: false, durationMs: 0 };
    });

    const config = makeConfig(5);
    startTrimPoller({ config, logger: makeLogger() });

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(invocationTimes.length).toBe(3);

    for (let i = 1; i < invocationTimes.length; i++) {
      const gapSeconds = (invocationTimes[i] - invocationTimes[i - 1]) / 1_000;
      expect(gapSeconds).toBeLessThanOrEqual(5);
    }
  });

  /**
   * Edge case: when a trim is already in progress (trimming=true),
   * the next tick should be skipped — so the effective gap between
   * completed invocations may be > intervalSeconds, but the *scheduled*
   * interval never exceeds intervalSeconds.
   *
   * This test verifies that the poller does NOT fire a second concurrent
   * invocation when the first is still running.
   */
  it('does not start a second trim while one is already in progress', async () => {
    let resolveFirst!: () => void;
    let concurrentCount = 0;
    let maxConcurrent = 0;

    vi.mocked(mockRunTrimOnce).mockImplementation(
      () =>
        new Promise<{ framesDeleted: number; elementsDeleted: number; reachedFloor: boolean; durationMs: number }>((resolve) => {
          concurrentCount++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);
          resolveFirst = () => {
            concurrentCount--;
            resolve({ framesDeleted: 0, elementsDeleted: 0, reachedFloor: false, durationMs: 0 });
          };
        })
    );

    const config = makeConfig(1); // 1s interval
    startTrimPoller({ config, logger: makeLogger() });

    // Advance 1s — first trim starts (and hangs)
    await vi.advanceTimersByTimeAsync(1_000);
    // Advance another 1s — second tick fires but trimming=true, so skipped
    await vi.advanceTimersByTimeAsync(1_000);
    // Advance another 1s — third tick also skipped
    await vi.advanceTimersByTimeAsync(1_000);

    // Only one concurrent invocation should ever be active
    expect(maxConcurrent).toBe(1);

    // Resolve the hanging trim
    resolveFirst();
    await vi.advanceTimersByTimeAsync(0);
  });
});
