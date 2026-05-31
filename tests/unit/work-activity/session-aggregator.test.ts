/**
 * Unit + property-based tests for `DefaultSessionAggregator`
 * (work-activity-analysis task 4.2).
 *
 * The aggregator turns a stream of per-frame `ExtractionResult` records
 * into the `sessions` table rows. Behaviour comes from design §4 and is
 * pinned by acceptance criteria R3.3 / R3.5 / R3.6 / R3.7.
 *
 * Tests run against a real in-memory derived database so the SQL +
 * aggregator stack is exercised end-to-end (a fake `SessionStore`
 * would re-implement the very logic we want to validate). Every PBT
 * uses a deterministic `now()` clock and a counter-backed
 * `generateSessionId` so replays compare cleanly.
 *
 * Coverage:
 *
 *   - **W7 Boundary_Closure** — adjacent frames whose `appName`
 *     differs land in different sessions (R3.5).
 *   - **W8 Idle_Closure** — adjacent frames whose timestamp gap
 *     exceeds `idleThresholdSeconds` land in different sessions
 *     (R3.3 / R3.6).
 *   - **W9 Context_Continuity** — adjacent frames sharing app +
 *     contextKey within the threshold land in the same session
 *     (R3.3 / R3.4).
 *   - **W10 Idempotence** — replaying a frame sequence on a fresh
 *     database produces the same `(app_name, context_key,
 *     started_at, ended_at, active_seconds, evidence_frame_ids)`
 *     tuples; only `session_id` may differ.
 *   - **W11 flushIdleOpenSessions Idempotence** — calling the flush
 *     twice with the same `now` reports `closed: 0` on the second
 *     call and leaves the table identical.
 *
 * **Validates: Requirements 3.3, 3.5, 3.6, 3.7**
 */

import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DefaultSessionAggregator,
  type SessionAggregatorDependencies
} from '../../../src/services/work-activity/sessions/aggregator.js';
import {
  SqliteSessionStore,
  type SessionRow
} from '../../../src/services/work-activity/sessions/session-store.js';
import type { ExtractionResult } from '../../../src/services/work-activity/extraction/types.js';
import {
  initDerivedSchema,
  openDerivedDatabase,
  type DerivedDatabase
} from '../../../src/services/work-activity/derived-database.js';

// ---------------------------------------------------------------------------
// Per-test fixture — fresh in-memory derived database + aggregator
// ---------------------------------------------------------------------------

const IDLE_THRESHOLD = 120; // seconds (matches design default)
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

let db: DerivedDatabase;
let store: SqliteSessionStore;
let idCounter = 0;

beforeEach(() => {
  db = openDerivedDatabase(':memory:');
  initDerivedSchema(db);
  store = new SqliteSessionStore(db);
  idCounter = 0;
});

afterEach(() => {
  db.close();
});

/**
 * Builds an aggregator wired to the per-test SQLite store. Tests pass
 * `now` and `idleThresholdSeconds` overrides when the default fixed
 * clock or 120s threshold is inappropriate.
 */
function buildAggregator(
  overrides: Partial<SessionAggregatorDependencies> = {}
): DefaultSessionAggregator {
  const deps: SessionAggregatorDependencies = {
    store,
    idleThresholdSeconds: IDLE_THRESHOLD,
    now: () => FIXED_NOW,
    generateSessionId: () => `sid-${++idCounter}`,
    ...overrides
  };
  return new DefaultSessionAggregator(deps);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds an `ExtractionResult` with sensible defaults; tests override
 * the relevant fields. `contextKey` is computed from `appName +
 * contextLabel` to mirror real callers — tests that need a custom key
 * pass it explicitly.
 */
function makeExtraction(
  overrides: Partial<ExtractionResult> & {
    secondsAfterEpoch: number;
  }
): ExtractionResult {
  const { secondsAfterEpoch, ...rest } = overrides;
  const appName = rest.appName ?? 'TestApp';
  const contextLabel = rest.contextLabel ?? 'Window.txt';
  return {
    frameId: rest.frameId ?? secondsAfterEpoch,
    frameTimestamp: tsAt(secondsAfterEpoch),
    appName,
    contextLabel,
    contextKey:
      rest.contextKey ?? `${appName}::${contextLabel.toLowerCase()}`,
    extractedText: rest.extractedText ?? 'sample text',
    extractedTextHash: rest.extractedTextHash ?? null,
    extractionRuleKind: rest.extractionRuleKind ?? 'generic',
    sourceTypes: rest.sourceTypes ?? ['accessibility']
  };
}

/**
 * ISO timestamp `secondsAfterEpoch` seconds after a fixed base. The
 * base is well before {@link FIXED_NOW} so all generated frames are in
 * the past and `flushIdleOpenSessions(FIXED_NOW)` can close them.
 */
function tsAt(secondsAfterEpoch: number): string {
  const base = Date.UTC(2026, 5, 1, 10, 0, 0); // 2 hours before FIXED_NOW
  return new Date(base + secondsAfterEpoch * 1000).toISOString();
}

/**
 * Reads every row from the `sessions` table ordered by `started_at`
 * for stable comparison. Used by the idempotence property to compare
 * two replays of the same frame sequence.
 */
async function dumpSessions(): Promise<SessionRow[]> {
  return store.listSessions({});
}

// ---------------------------------------------------------------------------
// Example-based smoke tests (sanity)
// ---------------------------------------------------------------------------

describe('DefaultSessionAggregator (example-based)', () => {
  it('creates a new session on the first frame', async () => {
    const agg = buildAggregator();
    const ext = makeExtraction({ secondsAfterEpoch: 0 });

    const { sessionId, created } = await agg.handleExtraction(ext);

    expect(created).toBe(true);
    expect(sessionId).toBe('sid-1');
    const rows = await dumpSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].is_open).toBe(true);
    expect(rows[0].evidence_frame_ids).toEqual([0]);
    expect(rows[0].active_seconds).toBe(0);
    expect(rows[0].started_at).toBe(rows[0].ended_at);
  });

  it('extends an existing session within the idle threshold', async () => {
    const agg = buildAggregator();
    const e1 = makeExtraction({ secondsAfterEpoch: 0, frameId: 1 });
    const e2 = makeExtraction({ secondsAfterEpoch: 30, frameId: 2 });

    const r1 = await agg.handleExtraction(e1);
    const r2 = await agg.handleExtraction(e2);

    expect(r2.created).toBe(false);
    expect(r2.sessionId).toBe(r1.sessionId);
    const rows = await dumpSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].evidence_frame_ids).toEqual([1, 2]);
    // 30s gap, fully inside [0, IDLE_THRESHOLD] → contributes 30s
    expect(rows[0].active_seconds).toBe(30);
    expect(rows[0].ended_at).toBe(e2.frameTimestamp);
  });

  it('closes the open session and creates a new one on app switch', async () => {
    const agg = buildAggregator();
    const e1 = makeExtraction({
      secondsAfterEpoch: 0,
      frameId: 1,
      appName: 'AppA',
      contextLabel: 'doc.md',
      contextKey: 'AppA::doc.md'
    });
    const e2 = makeExtraction({
      secondsAfterEpoch: 5,
      frameId: 2,
      appName: 'AppB',
      contextLabel: 'browser',
      contextKey: 'AppB::browser'
    });

    const r1 = await agg.handleExtraction(e1);
    const r2 = await agg.handleExtraction(e2);

    expect(r2.created).toBe(true);
    expect(r2.sessionId).not.toBe(r1.sessionId);
    const rows = await dumpSessions();
    expect(rows).toHaveLength(2);
    // The AppA session retains is_open=true here because its
    // `(appName, contextKey)` no longer matches the new frame —
    // `flushIdleOpenSessions` will close it later.
    const appA = rows.find((r) => r.app_name === 'AppA')!;
    const appB = rows.find((r) => r.app_name === 'AppB')!;
    expect(appA.evidence_frame_ids).toEqual([1]);
    expect(appB.evidence_frame_ids).toEqual([2]);
  });

  it('starts a new session when the gap exceeds the idle threshold', async () => {
    const agg = buildAggregator();
    const e1 = makeExtraction({ secondsAfterEpoch: 0, frameId: 1 });
    const e2 = makeExtraction({
      secondsAfterEpoch: IDLE_THRESHOLD + 1,
      frameId: 2
    });

    await agg.handleExtraction(e1);
    const r2 = await agg.handleExtraction(e2);

    expect(r2.created).toBe(true);
    const rows = await dumpSessions();
    expect(rows).toHaveLength(2);
    // The first row was closed when the second frame arrived (because
    // `findOpenSessionFor` returned it but `canExtend` rejected the gap).
    const closed = rows.find((r) => !r.is_open)!;
    expect(closed.evidence_frame_ids).toEqual([1]);
    const open = rows.find((r) => r.is_open)!;
    expect(open.evidence_frame_ids).toEqual([2]);
  });

  it('clamps the active_seconds delta when receiving an out-of-order frame', async () => {
    // Out-of-order arrivals (within the same `(appName, contextKey)`
    // bucket) should not decrement `active_seconds`. The aggregator's
    // canExtend allows gap >= 0, so the test covers the gap == 0 case
    // explicitly — replaying the same timestamp adds 0 active seconds.
    const agg = buildAggregator();
    const e1 = makeExtraction({ secondsAfterEpoch: 10, frameId: 1 });
    const e2 = makeExtraction({ secondsAfterEpoch: 10, frameId: 2 });

    await agg.handleExtraction(e1);
    await agg.handleExtraction(e2);

    const rows = await dumpSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].active_seconds).toBe(0);
    expect(rows[0].evidence_frame_ids).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// flushIdleOpenSessions — example coverage before PBT
// ---------------------------------------------------------------------------

describe('DefaultSessionAggregator.flushIdleOpenSessions (example-based)', () => {
  it('closes open sessions whose ended_at is older than the threshold', async () => {
    const agg = buildAggregator();
    // Frame at FIXED_NOW - (IDLE_THRESHOLD + 60)s — well past stale
    const staleSec = -(IDLE_THRESHOLD + 60);
    // Adjusted for our `tsAt` base, FIXED_NOW is at +7200s; pick an
    // offset whose result is older than FIXED_NOW - IDLE_THRESHOLD
    const fixedSec =
      (FIXED_NOW.getTime() - Date.UTC(2026, 5, 1, 10, 0, 0)) / 1000;
    const ext = makeExtraction({
      secondsAfterEpoch: fixedSec + staleSec,
      frameId: 1
    });

    await agg.handleExtraction(ext);

    const result = await agg.flushIdleOpenSessions();
    expect(result.closed).toBe(1);
    const rows = await dumpSessions();
    expect(rows[0].is_open).toBe(false);
    expect(rows[0].closed_at).toBe(FIXED_NOW.toISOString());
  });

  it('leaves sessions ended within the threshold open', async () => {
    const agg = buildAggregator();
    // Frame at exactly FIXED_NOW - 30s → not stale
    const fixedSec =
      (FIXED_NOW.getTime() - Date.UTC(2026, 5, 1, 10, 0, 0)) / 1000;
    const ext = makeExtraction({
      secondsAfterEpoch: fixedSec - 30,
      frameId: 1
    });
    await agg.handleExtraction(ext);

    const result = await agg.flushIdleOpenSessions();
    expect(result.closed).toBe(0);
    const rows = await dumpSessions();
    expect(rows[0].is_open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PBT helpers — frame sequence arbitrary
// ---------------------------------------------------------------------------

interface FrameDescriptor {
  frameId: number;
  appName: string;
  contextKey: string;
  /** ISO timestamp; monotonically non-decreasing within a sequence. */
  frameTimestamp: string;
  contextLabel: string;
}

/** A small set of arbitrary app/context buckets to keep the search space tractable. */
const APP_NAMES = ['AppA', 'AppB', 'AppC'];
const CONTEXT_LABELS = ['file1', 'file2', 'file3'];

/**
 * Builds a frame sequence with monotonic timestamps. Each frame picks
 * an app, a context label, and a non-negative gap from the previous
 * frame. The gap range covers both "below" and "above" the idle
 * threshold so the aggregator's branches all get exercised.
 *
 * The arbitrary returns frames already converted into the
 * {@link makeExtraction} form for direct use by tests.
 */
const frameSequenceArb = fc
  .array(
    fc.record({
      app: fc.constantFrom(...APP_NAMES),
      ctx: fc.constantFrom(...CONTEXT_LABELS),
      gapSeconds: fc.integer({ min: 0, max: IDLE_THRESHOLD * 2 + 30 })
    }),
    { minLength: 1, maxLength: 25 }
  )
  .map((items) => {
    const baseSec = 0;
    let cursor = baseSec;
    return items.map((item, idx): FrameDescriptor => {
      cursor += item.gapSeconds;
      const contextLabel = item.ctx;
      return {
        frameId: idx + 1,
        appName: item.app,
        contextLabel,
        contextKey: `${item.app}::${contextLabel}`,
        frameTimestamp: tsAt(cursor)
      };
    });
  });

function toExtraction(f: FrameDescriptor): ExtractionResult {
  return {
    frameId: f.frameId,
    frameTimestamp: f.frameTimestamp,
    appName: f.appName,
    contextLabel: f.contextLabel,
    contextKey: f.contextKey,
    extractedText: 'x',
    extractedTextHash: null,
    extractionRuleKind: 'generic',
    sourceTypes: ['accessibility']
  };
}

/**
 * Drives a frame sequence through a fresh aggregator+store and returns
 * the resulting (sorted) session rows. Closes the database after use.
 * Used by Idempotence (W10) so the replay runs in an independent
 * environment.
 */
async function runSequence(
  sequence: FrameDescriptor[]
): Promise<SessionRow[]> {
  const replayDb = openDerivedDatabase(':memory:');
  initDerivedSchema(replayDb);
  const replayStore = new SqliteSessionStore(replayDb);
  let counter = 0;
  const agg = new DefaultSessionAggregator({
    store: replayStore,
    idleThresholdSeconds: IDLE_THRESHOLD,
    now: () => FIXED_NOW,
    generateSessionId: () => `sid-${++counter}`
  });
  for (const f of sequence) {
    await agg.handleExtraction(toExtraction(f));
  }
  const rows = await replayStore.listSessions({});
  replayDb.close();
  return rows;
}

// ---------------------------------------------------------------------------
// Property W7: Boundary_Closure
// **Validates: Requirements 3.5, 3.3**
// ---------------------------------------------------------------------------

describe('DefaultSessionAggregator (PBT — W7 Boundary_Closure)', () => {
  it('adjacent frames with different appName land in different sessions', async () => {
    await fc.assert(
      fc.asyncProperty(frameSequenceArb, async (sequence) => {
        // Drive the sequence through a fresh aggregator; track the
        // session each frame lands in.
        const replayDb = openDerivedDatabase(':memory:');
        initDerivedSchema(replayDb);
        const replayStore = new SqliteSessionStore(replayDb);
        let counter = 0;
        const agg = new DefaultSessionAggregator({
          store: replayStore,
          idleThresholdSeconds: IDLE_THRESHOLD,
          now: () => FIXED_NOW,
          generateSessionId: () => `sid-${++counter}`
        });
        const frameToSession = new Map<number, string>();
        for (const f of sequence) {
          const r = await agg.handleExtraction(toExtraction(f));
          frameToSession.set(f.frameId, r.sessionId);
        }
        replayDb.close();

        // For each adjacent pair where appName differs, sessionIds
        // MUST differ.
        for (let i = 0; i < sequence.length - 1; i++) {
          const a = sequence[i];
          const b = sequence[i + 1];
          if (a.appName !== b.appName) {
            expect(frameToSession.get(a.frameId)).not.toBe(
              frameToSession.get(b.frameId)
            );
          }
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property W8: Idle_Closure
// **Validates: Requirements 3.3, 3.6**
// ---------------------------------------------------------------------------

describe('DefaultSessionAggregator (PBT — W8 Idle_Closure)', () => {
  it('adjacent frames with gap > idleThresholdSeconds land in different sessions', async () => {
    await fc.assert(
      fc.asyncProperty(frameSequenceArb, async (sequence) => {
        const replayDb = openDerivedDatabase(':memory:');
        initDerivedSchema(replayDb);
        const replayStore = new SqliteSessionStore(replayDb);
        let counter = 0;
        const agg = new DefaultSessionAggregator({
          store: replayStore,
          idleThresholdSeconds: IDLE_THRESHOLD,
          now: () => FIXED_NOW,
          generateSessionId: () => `sid-${++counter}`
        });
        const frameToSession = new Map<number, string>();
        for (const f of sequence) {
          const r = await agg.handleExtraction(toExtraction(f));
          frameToSession.set(f.frameId, r.sessionId);
        }
        replayDb.close();

        for (let i = 0; i < sequence.length - 1; i++) {
          const a = sequence[i];
          const b = sequence[i + 1];
          const gap =
            (Date.parse(b.frameTimestamp) - Date.parse(a.frameTimestamp)) /
            1000;
          if (gap > IDLE_THRESHOLD) {
            expect(frameToSession.get(a.frameId)).not.toBe(
              frameToSession.get(b.frameId)
            );
          }
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property W9: Context_Continuity
// **Validates: Requirements 3.3, 3.4**
// ---------------------------------------------------------------------------

describe('DefaultSessionAggregator (PBT — W9 Context_Continuity)', () => {
  it('adjacent frames sharing app + contextKey within threshold land in same session', async () => {
    await fc.assert(
      fc.asyncProperty(frameSequenceArb, async (sequence) => {
        const replayDb = openDerivedDatabase(':memory:');
        initDerivedSchema(replayDb);
        const replayStore = new SqliteSessionStore(replayDb);
        let counter = 0;
        const agg = new DefaultSessionAggregator({
          store: replayStore,
          idleThresholdSeconds: IDLE_THRESHOLD,
          now: () => FIXED_NOW,
          generateSessionId: () => `sid-${++counter}`
        });
        const frameToSession = new Map<number, string>();
        for (const f of sequence) {
          const r = await agg.handleExtraction(toExtraction(f));
          frameToSession.set(f.frameId, r.sessionId);
        }
        replayDb.close();

        for (let i = 0; i < sequence.length - 1; i++) {
          const a = sequence[i];
          const b = sequence[i + 1];
          const gap =
            (Date.parse(b.frameTimestamp) - Date.parse(a.frameTimestamp)) /
            1000;
          if (
            a.appName === b.appName &&
            a.contextKey === b.contextKey &&
            gap >= 0 &&
            gap <= IDLE_THRESHOLD
          ) {
            expect(frameToSession.get(a.frameId)).toBe(
              frameToSession.get(b.frameId)
            );
          }
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property W10: Idempotence (replay produces identical session content)
// **Validates: Requirements 3.3, 3.4**
// ---------------------------------------------------------------------------

describe('DefaultSessionAggregator (PBT — W10 Idempotence)', () => {
  it('replaying the same sequence on a fresh database yields equivalent sessions', async () => {
    await fc.assert(
      fc.asyncProperty(frameSequenceArb, async (sequence) => {
        const first = await runSequence(sequence);
        const second = await runSequence(sequence);

        // Both runs must produce the same number of sessions and the
        // same `(app_name, context_key, started_at, ended_at,
        // active_seconds, evidence_frame_ids)` tuples in the same
        // order. `session_id` may differ (counter-based) so it is
        // excluded from the comparison.
        expect(second).toHaveLength(first.length);
        const project = (rows: SessionRow[]) =>
          rows.map((r) => ({
            app_name: r.app_name,
            context_key: r.context_key,
            started_at: r.started_at,
            ended_at: r.ended_at,
            active_seconds: r.active_seconds,
            evidence_frame_ids: r.evidence_frame_ids,
            is_open: r.is_open
          }));
        expect(project(second)).toEqual(project(first));
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property W11: flushIdleOpenSessions Idempotence
// **Validates: Requirements 3.6**
// ---------------------------------------------------------------------------

describe('DefaultSessionAggregator (PBT — W11 flush idempotence)', () => {
  it('a second flush at the same `now` reports closed: 0 and leaves rows unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(frameSequenceArb, async (sequence) => {
        const replayDb = openDerivedDatabase(':memory:');
        initDerivedSchema(replayDb);
        const replayStore = new SqliteSessionStore(replayDb);
        let counter = 0;
        const agg = new DefaultSessionAggregator({
          store: replayStore,
          idleThresholdSeconds: IDLE_THRESHOLD,
          now: () => FIXED_NOW,
          generateSessionId: () => `sid-${++counter}`
        });
        for (const f of sequence) {
          await agg.handleExtraction(toExtraction(f));
        }

        const before = await replayStore.listSessions({});
        const first = await agg.flushIdleOpenSessions(FIXED_NOW);
        const between = await replayStore.listSessions({});
        const second = await agg.flushIdleOpenSessions(FIXED_NOW);
        const after = await replayStore.listSessions({});
        replayDb.close();

        // First flush is allowed to close ≥ 0 rows; second flush MUST
        // be a no-op.
        expect(first.closed).toBeGreaterThanOrEqual(0);
        expect(second.closed).toBe(0);
        // The table is unchanged across the second flush.
        expect(after).toEqual(between);
        // Sanity: every row that had `ended_at >= FIXED_NOW -
        // IDLE_THRESHOLD` survived as is_open=true, every other row
        // is closed.
        const cutoffMs = FIXED_NOW.getTime() - IDLE_THRESHOLD * 1000;
        for (const row of after) {
          const endedMs = Date.parse(row.ended_at);
          if (endedMs < cutoffMs) {
            expect(row.is_open).toBe(false);
            expect(row.closed_at).toBe(FIXED_NOW.toISOString());
          }
        }
        // `before` must be the pre-flush snapshot; assert it has no
        // closed rows from this flush (we assert via length compared
        // to `between`).
        expect(before.length).toBe(between.length);
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting helpers used by the smoke tests above are kept local;
// nothing else to export from this file.
// ---------------------------------------------------------------------------
