/**
 * Unit tests for `SqliteSessionStore` (work-activity-analysis task 4.1).
 *
 * The store wraps the `sessions` SQLite table behind a Promise-based
 * interface used by the Session_Aggregator, SummaryWorker, observability
 * service, recall tool, and Cascade_Delete coordinator. These tests
 * exercise every method against a fresh in-memory derived database
 * created via {@link openDerivedDatabase} + {@link initDerivedSchema},
 * covering:
 *
 *   - `createSession` / `findOpenSessionFor` round trip including the
 *     aggregator's `appName ?? ''` convention
 *   - `appendFrame` increments `active_seconds` by the caller-supplied
 *     delta and JSON-round-trips `evidence_frame_ids`
 *   - `closeSession` / `closeOpenSessionsEndedBefore` change `is_open`
 *     and report row counts; the cutoff comparison is strict-less-than
 *   - `deleteSessionsTouchingFrames` finds rows by `evidence_frame_ids`
 *     intersection (R9 Cascade_Delete) and silently skips empty input
 *   - `countOpenSessions` / `findLastClosedAt` / `countSessionsStartedSince`
 *     / `countSessionsByStatus` for observability
 *   - `listSessions` filter combinations and ordering
 *   - `getSession` for present + missing ids
 *   - `updateSummary` partial-write semantics (omitted fields stay
 *     untouched)
 *
 * The store is a thin SQL wrapper, so the tests are example-based.
 * Property tests for the aggregator's session boundary semantics
 * (W7-W11) live in task 4.2's `session-aggregator.test.ts`.
 *
 * **Validates: Requirements 3.1, 3.2**
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SqliteSessionStore,
  type AppendFrameOptions,
  type SessionRow,
  type SummaryStatus
} from '../../../src/services/work-activity/sessions/session-store.js';
import type { ExtractionResult } from '../../../src/services/work-activity/extraction/types.js';
import {
  initDerivedSchema,
  openDerivedDatabase,
  type DerivedDatabase
} from '../../../src/services/work-activity/derived-database.js';

// ---------------------------------------------------------------------------
// Per-test fixture — fresh in-memory derived database
// ---------------------------------------------------------------------------

let db: DerivedDatabase;
let store: SqliteSessionStore;

beforeEach(() => {
  db = openDerivedDatabase(':memory:');
  initDerivedSchema(db);
  store = new SqliteSessionStore(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds an `ExtractionResult` with sensible defaults. Tests override
 * `frameId` / `frameTimestamp` / `appName` / `contextKey` to set up
 * specific scenarios.
 */
function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    frameId: 1,
    frameTimestamp: tsAt(0),
    appName: 'TestApp',
    contextLabel: 'Window.txt',
    contextKey: 'TestApp::window.txt',
    extractedText: 'hello world',
    extractedTextHash:
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    extractionRuleKind: 'generic',
    sourceTypes: ['accessibility'],
    ...overrides
  };
}

const APPEND_OPTS: AppendFrameOptions = { activeSecondsDelta: 1 };

/**
 * Builds an ISO 8601 timestamp `secondsAfterEpoch` seconds after the
 * arbitrary base `2026-05-25T10:00:00Z`. Keeps the per-test timeline
 * compact and easy to reason about — `tsAt(10)` is "10 seconds in".
 */
function tsAt(secondsAfterEpoch: number): string {
  const base = Date.UTC(2026, 4, 25, 10, 0, 0); // month is 0-indexed
  return new Date(base + secondsAfterEpoch * 1000).toISOString();
}

/**
 * Inserts a session via `createSession` using the supplied extraction.
 * Returns the `session_id` so tests can chain reads/updates.
 */
async function seedSession(
  sessionId: string,
  extraction: ExtractionResult
): Promise<string> {
  await store.createSession({ session_id: sessionId, ...extraction });
  return sessionId;
}

// ---------------------------------------------------------------------------
// `createSession` + `findOpenSessionFor`
// ---------------------------------------------------------------------------

describe('SqliteSessionStore.createSession + findOpenSessionFor', () => {
  it('persists a new open session that round-trips through findOpenSessionFor', async () => {
    const ext = makeExtraction({
      frameId: 100,
      frameTimestamp: tsAt(10),
      appName: 'Editor',
      contextKey: 'Editor::main.ts',
      contextLabel: 'main.ts',
      sourceTypes: ['accessibility']
    });
    await seedSession('s1', ext);

    const found = await store.findOpenSessionFor('Editor', 'Editor::main.ts');
    expect(found).not.toBeNull();
    const row = found as SessionRow;

    expect(row.session_id).toBe('s1');
    expect(row.app_name).toBe('Editor');
    expect(row.context_key).toBe('Editor::main.ts');
    expect(row.context_label).toBe('main.ts');
    expect(row.started_at).toBe(tsAt(10));
    expect(row.ended_at).toBe(tsAt(10));
    expect(row.active_seconds).toBe(0);
    expect(row.source_types).toEqual(['accessibility']);
    expect(row.evidence_frame_ids).toEqual([100]);
    expect(row.is_open).toBe(true);
    expect(row.summary_text).toBeNull();
    expect(row.summary_status).toBeNull();
    expect(row.closed_at).toBeNull();
  });

  it('matches sessions created with appName=undefined when looking up with undefined', async () => {
    // Aggregator stores `extraction.appName ?? ''`; lookup with
    // undefined MUST resolve to the same row.
    const ext = makeExtraction({
      frameId: 200,
      frameTimestamp: tsAt(0),
      appName: undefined,
      contextKey: '::orphan',
      contextLabel: 'orphan'
    });
    await seedSession('s-orphan', ext);

    const found = await store.findOpenSessionFor(undefined, '::orphan');
    expect(found?.session_id).toBe('s-orphan');
    expect(found?.app_name).toBe('');
  });

  it('returns null when no open session exists for the (appName, contextKey) pair', async () => {
    await seedSession('s1', makeExtraction({ contextKey: 'A::x' }));
    expect(await store.findOpenSessionFor('A', 'A::y')).toBeNull();
    expect(await store.findOpenSessionFor('B', 'A::x')).toBeNull();
  });

  it('returns null when the matching session is closed', async () => {
    await seedSession('s1', makeExtraction({ contextKey: 'A::x' }));
    await store.closeSession('s1', tsAt(60));
    expect(await store.findOpenSessionFor('TestApp', 'A::x')).toBeNull();
  });

  it('returns the session with the most recent ended_at when multiple open sessions exist', async () => {
    // Two open sessions on the same key would normally not happen in
    // production (the aggregator closes the predecessor before
    // opening a new one), but verifying the ORDER BY ended_at DESC
    // contract guards against future regressions.
    await seedSession(
      'older',
      makeExtraction({ frameId: 1, frameTimestamp: tsAt(10), contextKey: 'A::x' })
    );
    await seedSession(
      'newer',
      makeExtraction({ frameId: 2, frameTimestamp: tsAt(60), contextKey: 'A::x' })
    );
    const found = await store.findOpenSessionFor('TestApp', 'A::x');
    expect(found?.session_id).toBe('newer');
  });
});

// ---------------------------------------------------------------------------
// `appendFrame`
// ---------------------------------------------------------------------------

describe('SqliteSessionStore.appendFrame', () => {
  it('appends the new frameId and updates ended_at + active_seconds', async () => {
    await seedSession(
      's1',
      makeExtraction({ frameId: 1, frameTimestamp: tsAt(0) })
    );
    await store.appendFrame(
      's1',
      makeExtraction({ frameId: 2, frameTimestamp: tsAt(15) }),
      { activeSecondsDelta: 15 }
    );

    const row = (await store.getSession('s1')) as SessionRow;
    expect(row.evidence_frame_ids).toEqual([1, 2]);
    expect(row.ended_at).toBe(tsAt(15));
    expect(row.active_seconds).toBe(15);
  });

  it('accumulates active_seconds across multiple appends', async () => {
    await seedSession(
      's1',
      makeExtraction({ frameId: 1, frameTimestamp: tsAt(0) })
    );
    await store.appendFrame(
      's1',
      makeExtraction({ frameId: 2, frameTimestamp: tsAt(10) }),
      { activeSecondsDelta: 10 }
    );
    await store.appendFrame(
      's1',
      makeExtraction({ frameId: 3, frameTimestamp: tsAt(25) }),
      { activeSecondsDelta: 15 }
    );

    const row = (await store.getSession('s1')) as SessionRow;
    expect(row.evidence_frame_ids).toEqual([1, 2, 3]);
    expect(row.active_seconds).toBe(25);
  });

  it('treats a zero delta as a no-op increment but still appends the frameId', async () => {
    // The aggregator passes `max(0, min(gap, idleThreshold))`; very
    // close frames legitimately yield zero seconds of additional
    // active time even though the frame still extends the session.
    await seedSession(
      's1',
      makeExtraction({ frameId: 1, frameTimestamp: tsAt(0) })
    );
    await store.appendFrame(
      's1',
      makeExtraction({ frameId: 2, frameTimestamp: tsAt(0) }),
      { activeSecondsDelta: 0 }
    );

    const row = (await store.getSession('s1')) as SessionRow;
    expect(row.evidence_frame_ids).toEqual([1, 2]);
    expect(row.active_seconds).toBe(0);
  });

  it('throws when the session does not exist', async () => {
    await expect(
      store.appendFrame('missing', makeExtraction(), APPEND_OPTS)
    ).rejects.toThrow(/missing/);
  });
});

// ---------------------------------------------------------------------------
// `closeSession` / `closeOpenSessionsEndedBefore`
// ---------------------------------------------------------------------------

describe('SqliteSessionStore.closeSession', () => {
  it('marks the session closed and stamps closed_at', async () => {
    await seedSession('s1', makeExtraction({ frameTimestamp: tsAt(0) }));
    await store.closeSession('s1', tsAt(120));

    const row = (await store.getSession('s1')) as SessionRow;
    expect(row.is_open).toBe(false);
    expect(row.closed_at).toBe(tsAt(120));
  });

  it('is a no-op when the session is already closed', async () => {
    await seedSession('s1', makeExtraction());
    await store.closeSession('s1', tsAt(120));
    // Second call would clobber `closed_at` with the new value if the
    // store ignored `is_open`; verify we keep the original.
    await store.closeSession('s1', tsAt(180));

    const row = (await store.getSession('s1')) as SessionRow;
    expect(row.closed_at).toBe(tsAt(120));
  });

  it('is a no-op when the session does not exist', async () => {
    // Should not throw — observability/cascade callers rely on the
    // forgiving behaviour.
    await expect(store.closeSession('missing', tsAt(60))).resolves.toBeUndefined();
  });
});

describe('SqliteSessionStore.closeOpenSessionsEndedBefore', () => {
  it('closes only sessions whose ended_at is strictly before the cutoff', async () => {
    await seedSession(
      'old',
      makeExtraction({ frameId: 1, frameTimestamp: tsAt(0), contextKey: 'A::1' })
    );
    await seedSession(
      'edge',
      makeExtraction({ frameId: 2, frameTimestamp: tsAt(60), contextKey: 'A::2' })
    );
    await seedSession(
      'fresh',
      makeExtraction({ frameId: 3, frameTimestamp: tsAt(120), contextKey: 'A::3' })
    );

    const closed = await store.closeOpenSessionsEndedBefore(tsAt(60), tsAt(200));
    expect(closed).toBe(1);

    expect((await store.getSession('old'))?.is_open).toBe(false);
    expect((await store.getSession('old'))?.closed_at).toBe(tsAt(200));
    expect((await store.getSession('edge'))?.is_open).toBe(true);
    expect((await store.getSession('fresh'))?.is_open).toBe(true);
  });

  it('returns 0 when no open sessions match the cutoff', async () => {
    await seedSession('s1', makeExtraction({ frameTimestamp: tsAt(60) }));
    expect(await store.closeOpenSessionsEndedBefore(tsAt(0), tsAt(100))).toBe(0);
  });

  it('does not touch already-closed sessions', async () => {
    await seedSession('s1', makeExtraction({ frameTimestamp: tsAt(0) }));
    await store.closeSession('s1', tsAt(10));

    const initialClosedAt = (await store.getSession('s1'))?.closed_at;
    await store.closeOpenSessionsEndedBefore(tsAt(60), tsAt(120));
    expect((await store.getSession('s1'))?.closed_at).toBe(initialClosedAt);
  });
});

// ---------------------------------------------------------------------------
// `deleteSessionsTouchingFrames` (Cascade_Delete)
// ---------------------------------------------------------------------------

describe('SqliteSessionStore.deleteSessionsTouchingFrames', () => {
  it('returns 0 for empty input without touching the database', async () => {
    await seedSession('s1', makeExtraction({ frameId: 1 }));
    expect(await store.deleteSessionsTouchingFrames([])).toBe(0);
    expect(await store.getSession('s1')).not.toBeNull();
  });

  it('deletes a session whose evidence_frame_ids intersects the input', async () => {
    await seedSession(
      's1',
      makeExtraction({ frameId: 10, frameTimestamp: tsAt(0) })
    );
    await store.appendFrame(
      's1',
      makeExtraction({ frameId: 11, frameTimestamp: tsAt(1) }),
      { activeSecondsDelta: 1 }
    );

    const removed = await store.deleteSessionsTouchingFrames([11]);
    expect(removed).toBe(1);
    expect(await store.getSession('s1')).toBeNull();
  });

  it('preserves sessions whose evidence_frame_ids does not intersect', async () => {
    await seedSession('s1', makeExtraction({ frameId: 1, contextKey: 'A::1' }));
    await seedSession('s2', makeExtraction({ frameId: 2, contextKey: 'A::2' }));

    const removed = await store.deleteSessionsTouchingFrames([2, 999]);
    expect(removed).toBe(1);
    expect(await store.getSession('s1')).not.toBeNull();
    expect(await store.getSession('s2')).toBeNull();
  });

  it('deletes the entire session even when only one of many frames matches (R9.2 — no re-sessionize)', async () => {
    await seedSession('s1', makeExtraction({ frameId: 1, frameTimestamp: tsAt(0) }));
    for (let i = 2; i <= 5; i++) {
      await store.appendFrame(
        's1',
        makeExtraction({ frameId: i, frameTimestamp: tsAt(i) }),
        { activeSecondsDelta: 1 }
      );
    }

    // Only one frame in the cascade; per R9.2 the entire session row
    // is removed, not just the touched frames.
    const removed = await store.deleteSessionsTouchingFrames([3]);
    expect(removed).toBe(1);
    expect(await store.getSession('s1')).toBeNull();
  });

  it('handles inputs that exceed MAX_BIND_PARAMS by chunking', async () => {
    // Insert a session that references frame_id=1000 and a wide set
    // of cascade ids that includes 1000 — the delete must still find
    // it after the IN list is split into chunks.
    await seedSession(
      's1',
      makeExtraction({ frameId: 1000, frameTimestamp: tsAt(0) })
    );
    const ids: number[] = [];
    for (let i = 1; i <= 1500; i++) ids.push(i);
    ids.push(1000);

    const removed = await store.deleteSessionsTouchingFrames(ids);
    expect(removed).toBe(1);
    expect(await store.getSession('s1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Observability counters
// ---------------------------------------------------------------------------

describe('SqliteSessionStore.countOpenSessions', () => {
  it('returns 0 on an empty table', async () => {
    expect(await store.countOpenSessions()).toBe(0);
  });

  it('counts only open sessions', async () => {
    await seedSession('a', makeExtraction({ frameId: 1, contextKey: 'A::1' }));
    await seedSession('b', makeExtraction({ frameId: 2, contextKey: 'A::2' }));
    await seedSession('c', makeExtraction({ frameId: 3, contextKey: 'A::3' }));
    await store.closeSession('a', tsAt(60));

    expect(await store.countOpenSessions()).toBe(2);
  });
});

describe('SqliteSessionStore.findLastClosedAt', () => {
  it('returns null when no sessions have ever closed', async () => {
    await seedSession('s1', makeExtraction());
    expect(await store.findLastClosedAt()).toBeNull();
  });

  it('returns the maximum closed_at across closed sessions', async () => {
    await seedSession('a', makeExtraction({ frameId: 1, contextKey: 'A::1' }));
    await seedSession('b', makeExtraction({ frameId: 2, contextKey: 'A::2' }));
    await seedSession('c', makeExtraction({ frameId: 3, contextKey: 'A::3' }));
    await store.closeSession('a', tsAt(60));
    await store.closeSession('b', tsAt(180));
    await store.closeSession('c', tsAt(120));

    expect(await store.findLastClosedAt()).toBe(tsAt(180));
  });
});

describe('SqliteSessionStore.countSessionsStartedSince', () => {
  it('returns 0 on an empty table', async () => {
    expect(await store.countSessionsStartedSince(tsAt(0))).toBe(0);
  });

  it('counts sessions whose started_at is at or after the cutoff', async () => {
    await seedSession(
      'old',
      makeExtraction({ frameId: 1, frameTimestamp: tsAt(0), contextKey: 'A::1' })
    );
    await seedSession(
      'edge',
      makeExtraction({ frameId: 2, frameTimestamp: tsAt(60), contextKey: 'A::2' })
    );
    await seedSession(
      'fresh',
      makeExtraction({ frameId: 3, frameTimestamp: tsAt(120), contextKey: 'A::3' })
    );

    expect(await store.countSessionsStartedSince(tsAt(60))).toBe(2);
  });

  it('counts an offset-stored session against a UTC-Z cutoff', async () => {
    // started_at 10:01:00Z (stored as 18:01:00+08:00); cutoff 10:00:00Z is
    // earlier, so the session must be counted. Raw string compare would miss
    // it ("18:..." < "10:..." is false on the >= side).
    await seedSession(
      'offset',
      makeExtraction({
        frameId: 9,
        frameTimestamp: '2026-05-25T18:01:00.000+08:00',
        contextKey: 'A::tz'
      })
    );
    expect(await store.countSessionsStartedSince('2026-05-25T10:00:00.000Z')).toBe(1);
  });
});

describe('SqliteSessionStore.countSessionsByStatus', () => {
  it('returns 0 when no session matches the requested status', async () => {
    await seedSession('s1', makeExtraction());
    expect(await store.countSessionsByStatus('pending')).toBe(0);
  });

  it('counts sessions per summary_status independently', async () => {
    await seedSession('a', makeExtraction({ frameId: 1, contextKey: 'A::1' }));
    await seedSession('b', makeExtraction({ frameId: 2, contextKey: 'A::2' }));
    await seedSession('c', makeExtraction({ frameId: 3, contextKey: 'A::3' }));
    await seedSession('d', makeExtraction({ frameId: 4, contextKey: 'A::4' }));

    await store.updateSummary('a', { summaryStatus: 'pending' });
    await store.updateSummary('b', { summaryStatus: 'pending' });
    await store.updateSummary('c', { summaryStatus: 'failed' });
    await store.updateSummary('d', { summaryStatus: 'ready' });

    expect(await store.countSessionsByStatus('pending')).toBe(2);
    expect(await store.countSessionsByStatus('failed')).toBe(1);
    expect(await store.countSessionsByStatus('ready')).toBe(1);
    expect(
      await store.countSessionsByStatus('not_applicable' as SummaryStatus)
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// `listSessions`
// ---------------------------------------------------------------------------

describe('SqliteSessionStore.listSessions', () => {
  /** Seeds three sessions across two apps and timestamps. */
  async function seedListFixture(): Promise<void> {
    await seedSession(
      'editor-old',
      makeExtraction({
        frameId: 1,
        frameTimestamp: tsAt(0),
        appName: 'Editor',
        contextKey: 'Editor::main.ts'
      })
    );
    await seedSession(
      'editor-new',
      makeExtraction({
        frameId: 2,
        frameTimestamp: tsAt(120),
        appName: 'Editor',
        contextKey: 'Editor::other.ts'
      })
    );
    await seedSession(
      'browser',
      makeExtraction({
        frameId: 3,
        frameTimestamp: tsAt(60),
        appName: 'Browser',
        contextKey: 'Browser::docs'
      })
    );
  }

  it('returns all sessions in started_at DESC order when filter is empty', async () => {
    await seedListFixture();
    const rows = await store.listSessions({});
    expect(rows.map((r) => r.session_id)).toEqual([
      'editor-new',
      'browser',
      'editor-old'
    ]);
  });

  it('filters by appName', async () => {
    await seedListFixture();
    const rows = await store.listSessions({ appName: 'Editor' });
    expect(rows.map((r) => r.session_id).sort()).toEqual([
      'editor-new',
      'editor-old'
    ]);
  });

  it('filters by from/to (started_at inclusive bounds)', async () => {
    await seedListFixture();
    const rows = await store.listSessions({ from: tsAt(60), to: tsAt(120) });
    expect(rows.map((r) => r.session_id).sort()).toEqual(['browser', 'editor-new']);
  });

  it('matches a session stored with UTC timestamp against UTC-Z window bounds', async () => {
    // After Phase 0 timestamp normalization, all timestamps in
    // derived.sqlite are canonical UTC Z-suffix. The write path
    // (aggregator.ts) normalizes frameTimestamp before storing.
    await seedSession(
      'offset-session',
      makeExtraction({
        frameId: 99,
        frameTimestamp: '2026-05-25T10:01:00.000Z',
        appName: 'Editor',
        contextKey: 'Editor::tz'
      })
    );
    const rows = await store.listSessions({
      from: '2026-05-25T10:00:00.000Z',
      to: '2026-05-25T10:02:00.000Z'
    });
    expect(rows.map((r) => r.session_id)).toContain('offset-session');
  });

  it('filters by isOpen=true / isOpen=false', async () => {
    await seedListFixture();
    await store.closeSession('editor-old', tsAt(200));

    const open = await store.listSessions({ isOpen: true });
    expect(open.map((r) => r.session_id).sort()).toEqual(['browser', 'editor-new']);

    const closed = await store.listSessions({ isOpen: false });
    expect(closed.map((r) => r.session_id)).toEqual(['editor-old']);
  });

  it('respects limit + offset for pagination', async () => {
    await seedListFixture();
    const page1 = await store.listSessions({ limit: 2 });
    expect(page1.map((r) => r.session_id)).toEqual(['editor-new', 'browser']);

    const page2 = await store.listSessions({ limit: 2, offset: 2 });
    expect(page2.map((r) => r.session_id)).toEqual(['editor-old']);
  });

  it('honours offset without limit (SQLite needs LIMIT to follow OFFSET)', async () => {
    // SQLite rejects `OFFSET n` without a leading `LIMIT`. The store
    // emits `LIMIT -1` (SQLite's "unbounded" sentinel) when the
    // caller sets only `offset`, so a paged read still works end to
    // end. Catching this regression early prevents a runtime SQL
    // error in callers that compose pagination via offset alone.
    await seedListFixture();
    const rows = await store.listSessions({ offset: 1 });
    expect(rows.map((r) => r.session_id)).toEqual(['browser', 'editor-old']);
  });

  it('returns an empty array when no session matches', async () => {
    await seedListFixture();
    const rows = await store.listSessions({ appName: 'Nonexistent' });
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `getSession`
// ---------------------------------------------------------------------------

describe('SqliteSessionStore.getSession', () => {
  it('returns null when no row matches', async () => {
    expect(await store.getSession('missing')).toBeNull();
  });

  it('round-trips evidence_frame_ids and source_types from JSON storage', async () => {
    await seedSession(
      's1',
      makeExtraction({
        frameId: 1,
        frameTimestamp: tsAt(0),
        sourceTypes: ['accessibility', 'ocr']
      })
    );
    await store.appendFrame(
      's1',
      makeExtraction({ frameId: 2, frameTimestamp: tsAt(10) }),
      { activeSecondsDelta: 10 }
    );

    const row = (await store.getSession('s1')) as SessionRow;
    expect(row.evidence_frame_ids).toEqual([1, 2]);
    expect(row.source_types).toEqual(['accessibility', 'ocr']);
  });
});

// ---------------------------------------------------------------------------
// `updateSummary`
// ---------------------------------------------------------------------------

describe('SqliteSessionStore.updateSummary', () => {
  it('writes summary_text, status, provider_kind, generated_at as a single update', async () => {
    await seedSession('s1', makeExtraction());
    await store.updateSummary('s1', {
      summaryText: 'in Editor for 2 minutes',
      summaryStatus: 'ready',
      summaryProviderKind: 'template',
      summaryGeneratedAt: tsAt(120)
    });

    const row = (await store.getSession('s1')) as SessionRow;
    expect(row.summary_text).toBe('in Editor for 2 minutes');
    expect(row.summary_status).toBe('ready');
    expect(row.summary_provider_kind).toBe('template');
    expect(row.summary_generated_at).toBe(tsAt(120));
  });

  it('leaves untouched columns alone when the update is partial', async () => {
    // First write a successful summary, then mark the session
    // `'failed'` without overwriting the stored text — the worker
    // (design §6.5) relies on this to keep degraded-text observable.
    await seedSession('s1', makeExtraction());
    await store.updateSummary('s1', {
      summaryText: 'first summary',
      summaryStatus: 'ready',
      summaryProviderKind: 'template',
      summaryGeneratedAt: tsAt(60)
    });
    await store.updateSummary('s1', { summaryStatus: 'failed' });

    const row = (await store.getSession('s1')) as SessionRow;
    expect(row.summary_text).toBe('first summary');
    expect(row.summary_status).toBe('failed');
    expect(row.summary_provider_kind).toBe('template');
    expect(row.summary_generated_at).toBe(tsAt(60));
  });

  it('explicitly clears columns when null is passed', async () => {
    await seedSession('s1', makeExtraction());
    await store.updateSummary('s1', {
      summaryText: 'first',
      summaryStatus: 'ready',
      summaryProviderKind: 'template',
      summaryGeneratedAt: tsAt(60)
    });
    await store.updateSummary('s1', { summaryText: null });

    const row = (await store.getSession('s1')) as SessionRow;
    expect(row.summary_text).toBeNull();
    // The other columns are untouched.
    expect(row.summary_status).toBe('ready');
  });

  it('is a no-op when no fields are provided', async () => {
    await seedSession('s1', makeExtraction());
    await store.updateSummary('s1', {
      summaryStatus: 'pending'
    });
    await store.updateSummary('s1', {}); // should not throw

    const row = (await store.getSession('s1')) as SessionRow;
    expect(row.summary_status).toBe('pending');
  });

  it('coerces unknown summary_status / summary_provider_kind values to null on read', async () => {
    // Writers go through the typed `updateSummary` API, but a future
    // migration, hand-edited database, or buggy direct INSERT could
    // park an unknown literal in these columns. The row mapper MUST
    // surface those as `null` rather than leak them through as if
    // they were valid — preventing invalid statuses from reaching
    // tool output (`recall.summary.status`, `inspect.session.summary`).
    await seedSession('s1', makeExtraction());
    db.prepare(
      `UPDATE sessions
         SET summary_status = ?, summary_provider_kind = ?
       WHERE session_id = ?`
    ).run('mystery-status', 'mystery-provider', 's1');

    const row = (await store.getSession('s1')) as SessionRow;
    expect(row.summary_status).toBeNull();
    expect(row.summary_provider_kind).toBeNull();

    // listSessions() runs the same row mapper, so the bogus values
    // do not leak through that read path either.
    const listed = await store.listSessions({});
    expect(listed[0].summary_status).toBeNull();
    expect(listed[0].summary_provider_kind).toBeNull();
  });
});
