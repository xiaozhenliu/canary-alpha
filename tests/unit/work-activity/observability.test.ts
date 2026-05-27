/**
 * Unit + property-based tests for `WorkActivityObservabilityService`
 * (work-activity-analysis task 9.1).
 *
 * The service is the read-only rollup that powers the four
 * work-activity blocks of the `internal-status` MCP tool —
 * `extraction`, `sessions`, `summary`, and `providers`. Behaviour is
 * pinned by design §9.2 / §9.3 and acceptance criteria R2 / R4 / R8.
 *
 * Tests run against a real in-memory derived database wired to the
 * concrete `SqliteExtractedContentStore` + `SqliteSessionStore` so
 * the observability code exercises the actual SQL paths it will hit
 * in production. A real `DefaultSessionAggregator` is wired so the
 * entry-call to `flushIdleOpenSessions` runs through real code (W11
 * is the property the test exercises transitively here, not in
 * isolation).
 *
 * Coverage:
 *
 *   - **W5 Idempotence** — calling `collect()` twice on a frozen
 *     dataset returns the same `extraction` block.
 *   - **W6 Zero-shot safety** — empty `extracted_content` table
 *     returns `lastExtractedAt: null` / `unextractedFrameRatio: 0`
 *     and does not throw.
 *   - **W12 Sessions Idempotence** — calling `collect()` twice on a
 *     frozen sessions table returns the same `sessions` block.
 *   - **W24 Providers zero-shot** — fresh `ProviderHealthRegistry`
 *     surfaces `'unknown'` status without `lastErrorAt` /
 *     `lastLatencyMs` and does not throw.
 *
 * Failure-mode coverage (design §9 Error Handling):
 *
 *   - A throwing `extractedContentStore` populates
 *     `degraded.extraction` and leaves the rest of the report normal.
 *   - A throwing `sessionStore` populates `degraded.sessions` and
 *     leaves the rest of the report normal.
 *   - A throwing summary status counter populates `degraded.summary`.
 *   - A throwing `summaryRegistry.active()` populates
 *     `degraded.providers`.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 4.1, 4.2, 4.3, 8.1, 8.2, 8.3**
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  initDerivedSchema,
  openDerivedDatabase,
  type DerivedDatabase
} from '../../../src/services/work-activity/derived-database.js';
import { SqliteExtractedContentStore } from '../../../src/services/work-activity/extraction/extracted-content-store.js';
import type { ExtractionResult } from '../../../src/services/work-activity/extraction/types.js';
import { ProviderHealthRegistry } from '../../../src/services/work-activity/observability/provider-health-registry.js';
import {
  WorkActivityObservabilityService,
  type WorkActivityObservabilityDependencies
} from '../../../src/services/work-activity/observability/work-activity-observability-service.js';
import {
  DefaultSessionAggregator,
  type SessionAggregator
} from '../../../src/services/work-activity/sessions/aggregator.js';
import {
  SqliteSessionStore,
  type SessionStore,
  type SummaryStatus
} from '../../../src/services/work-activity/sessions/session-store.js';
import { SummaryProviderRegistry } from '../../../src/services/work-activity/summary/registry.js';
import { TemplateSummaryProvider } from '../../../src/services/work-activity/summary/template.js';

// ---------------------------------------------------------------------------
// Per-test fixture
// ---------------------------------------------------------------------------

/**
 * Fixed clock pinned well after the seeded fixture timestamps so the
 * trailing-24h window deterministically covers (or excludes) the rows
 * each scenario seeds.
 */
const FIXED_NOW = new Date('2026-06-02T12:00:00.000Z');

/**
 * Idle threshold for the wired aggregator. The flush at the entry of
 * `collect()` uses this so all seeded frames at `tsAt(0)` (≈ 26 hours
 * before `FIXED_NOW`) are guaranteed stale and would close on the
 * very first flush — `W11` keeps subsequent flushes no-ops.
 */
const IDLE_THRESHOLD = 120;

let db: DerivedDatabase;
let extractedStore: SqliteExtractedContentStore;
let sessionStore: SqliteSessionStore;
let aggregator: DefaultSessionAggregator;
let providerHealth: ProviderHealthRegistry;
let summaryRegistry: SummaryProviderRegistry;
let idCounter = 0;

beforeEach(() => {
  db = openDerivedDatabase(':memory:');
  initDerivedSchema(db);
  extractedStore = new SqliteExtractedContentStore(db);
  sessionStore = new SqliteSessionStore(db);
  idCounter = 0;
  aggregator = new DefaultSessionAggregator({
    store: sessionStore,
    idleThresholdSeconds: IDLE_THRESHOLD,
    now: () => FIXED_NOW,
    generateSessionId: () => `sid-${++idCounter}`
  });
  providerHealth = new ProviderHealthRegistry({
    now: () => FIXED_NOW
  });
  summaryRegistry = new SummaryProviderRegistry(new TemplateSummaryProvider());
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds the service with the per-test wiring. Tests pass overrides
 * (notably a throwing store) when they want to exercise the
 * degradation paths.
 */
function buildService(
  overrides: Partial<WorkActivityObservabilityDependencies> = {}
): WorkActivityObservabilityService {
  const deps: WorkActivityObservabilityDependencies = {
    extractedContentStore: extractedStore,
    sessionStore: sessionStore,
    sessionAggregator: aggregator,
    summaryProviderRegistry: summaryRegistry,
    providerHealth: providerHealth,
    embeddingProviderKind: 'openai-compatible',
    now: () => FIXED_NOW,
    ...overrides
  };
  return new WorkActivityObservabilityService(deps);
}

/**
 * ISO-8601 timestamp `secondsAfterEpoch` seconds after a fixed base.
 * The base sits roughly 26h before {@link FIXED_NOW} so seeded rows
 * fall *outside* the trailing-24h window unless the test explicitly
 * targets a recent timestamp via {@link tsRecent}.
 */
function tsAt(secondsAfterEpoch: number): string {
  const base = Date.UTC(2026, 5, 1, 10, 0, 0);
  return new Date(base + secondsAfterEpoch * 1000).toISOString();
}

/**
 * ISO-8601 timestamp inside the trailing-24h window relative to
 * {@link FIXED_NOW}. The default places the row 1 hour before now —
 * solidly inside the window without colliding with `FIXED_NOW` itself.
 */
function tsRecent(secondsBeforeNow = 3600): string {
  return new Date(FIXED_NOW.getTime() - secondsBeforeNow * 1000).toISOString();
}

/**
 * Writes a row to `extracted_content` directly via the store.
 * `extractedText: ''` produces an `Empty_Extraction` row; otherwise
 * the row counts as a successful extraction toward
 * `extraction.lastExtractedAt`.
 */
async function seedExtraction(overrides: Partial<ExtractionResult> & { frameId: number }): Promise<void> {
  const ext: ExtractionResult = {
    frameId: overrides.frameId,
    frameTimestamp: overrides.frameTimestamp ?? tsRecent(),
    appName: overrides.appName ?? 'TestApp',
    contextLabel: overrides.contextLabel ?? 'Window.txt',
    contextKey: overrides.contextKey ?? 'TestApp::window.txt',
    extractedText: overrides.extractedText ?? 'sample text',
    extractedTextHash: overrides.extractedTextHash ?? null,
    extractionRuleKind: overrides.extractionRuleKind ?? 'generic',
    sourceTypes: overrides.sourceTypes ?? ['accessibility']
  };
  await extractedStore.upsert(ext);
}

/**
 * Inserts a session row directly through the store. Tests use this
 * instead of driving the aggregator when they want full control over
 * `started_at` / `ended_at` / `is_open` / `closed_at`.
 */
async function seedSession(opts: {
  sessionId: string;
  appName?: string;
  contextKey?: string;
  startedAt: string;
  endedAt: string;
  isOpen: boolean;
  closedAt?: string;
  frameIds?: number[];
  summaryStatus?: SummaryStatus;
}): Promise<void> {
  await sessionStore.createSession({
    session_id: opts.sessionId,
    frameId: (opts.frameIds ?? [opts.sessionId.length])[0],
    frameTimestamp: opts.startedAt,
    appName: opts.appName ?? 'TestApp',
    contextLabel: 'Window.txt',
    contextKey: opts.contextKey ?? 'TestApp::window.txt',
    extractedText: 'sample text',
    extractedTextHash: null,
    extractionRuleKind: 'generic',
    sourceTypes: ['accessibility']
  });
  if (opts.endedAt !== opts.startedAt) {
    // Bring `ended_at` to the requested value via raw SQL since the
    // store does not expose an "advance ended_at" without a frame
    // append. This keeps the seeded rows a faithful reflection of
    // the cases the aggregator writes in production.
    db.prepare(
      `UPDATE sessions SET ended_at = ?, evidence_frame_ids = ? WHERE session_id = ?`
    ).run(
      opts.endedAt,
      JSON.stringify(opts.frameIds ?? [opts.sessionId.length]),
      opts.sessionId
    );
  }
  if (!opts.isOpen) {
    await sessionStore.closeSession(
      opts.sessionId,
      opts.closedAt ?? opts.endedAt
    );
  }
  if (opts.summaryStatus !== undefined) {
    await sessionStore.updateSummary(opts.sessionId, {
      summaryStatus: opts.summaryStatus
    });
  }
}

// ---------------------------------------------------------------------------
// W6 — zero-shot safety
// **Validates: Requirements 2.2**
// ---------------------------------------------------------------------------

describe('WorkActivityObservabilityService.collect (W6 — zero-shot safety)', () => {
  it('returns null/0 fields without throwing on an empty derived database', async () => {
    const service = buildService();

    const result = await service.collect();

    expect(result.extraction.lastExtractedAt).toBeNull();
    expect(result.extraction.unextractedFrameRatio).toBe(0);
    expect(result.sessions.openSessionCount).toBe(0);
    expect(result.sessions.lastClosedAt).toBeNull();
    expect(result.sessions.totalSessionsLast24h).toBe(0);
    expect(result.summary.pendingCount).toBe(0);
    expect(result.summary.failedCount).toBe(0);
    // `degraded` is omitted entirely on the happy path so the
    // wire shape stays minimal when nothing went wrong.
    expect(result.degraded).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// W5 — extraction Idempotence
// **Validates: Requirements 2.1, 2.3**
// ---------------------------------------------------------------------------

describe('WorkActivityObservabilityService.collect (W5 — extraction Idempotence)', () => {
  it('returns the same extraction block across consecutive calls on a frozen dataset', async () => {
    // Mix of empty + non-empty rows inside the trailing-24h window
    // so both `lastExtractedAt` and `unextractedFrameRatio` are
    // populated (not just the zero-shot fast paths).
    await seedExtraction({ frameId: 1, frameTimestamp: tsRecent(7200), extractedText: 'first' });
    await seedExtraction({ frameId: 2, frameTimestamp: tsRecent(3600), extractedText: '' });
    await seedExtraction({ frameId: 3, frameTimestamp: tsRecent(1800), extractedText: 'second' });

    const service = buildService();

    const a = await service.collect();
    const b = await service.collect();

    expect(b.extraction).toEqual(a.extraction);
    // Sanity-check the values themselves so the equality is not
    // trivially passing on two `null` runs.
    expect(a.extraction.lastExtractedAt).toBe(tsRecent(1800));
    // 1 empty out of 3 total → 1/3
    expect(a.extraction.unextractedFrameRatio).toBeCloseTo(1 / 3, 12);
  });

  it('does not mutate the underlying table', async () => {
    await seedExtraction({ frameId: 1, frameTimestamp: tsRecent(3600), extractedText: 'only' });

    const service = buildService();

    const before = await extractedStore.countByTimeWindow(
      tsAt(0),
      tsRecent(0)
    );
    await service.collect();
    await service.collect();
    const after = await extractedStore.countByTimeWindow(
      tsAt(0),
      tsRecent(0)
    );

    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// W12 — sessions Idempotence
// **Validates: Requirements 4.1**
// ---------------------------------------------------------------------------

describe('WorkActivityObservabilityService.collect (W12 — sessions Idempotence)', () => {
  it('returns the same sessions block across consecutive calls on a frozen dataset', async () => {
    // Two closed sessions inside the 24h window, one open session
    // ending recently (well within the idle threshold so the
    // aggregator's flush leaves it alone). The mix exercises every
    // sessions field at once.
    await seedSession({
      sessionId: 'closed-1',
      startedAt: tsRecent(7200),
      endedAt: tsRecent(7000),
      isOpen: false,
      closedAt: tsRecent(6900),
      frameIds: [10]
    });
    await seedSession({
      sessionId: 'closed-2',
      startedAt: tsRecent(3600),
      endedAt: tsRecent(3500),
      isOpen: false,
      closedAt: tsRecent(3400),
      frameIds: [20]
    });
    await seedSession({
      sessionId: 'open-1',
      startedAt: tsRecent(60),
      endedAt: tsRecent(60),
      isOpen: true,
      frameIds: [30]
    });

    const service = buildService();

    const a = await service.collect();
    const b = await service.collect();

    expect(b.sessions).toEqual(a.sessions);
    expect(a.sessions.openSessionCount).toBe(1);
    expect(a.sessions.lastClosedAt).toBe(tsRecent(3400));
    expect(a.sessions.totalSessionsLast24h).toBe(3);
  });

  it('flushing idle sessions twice via collect() is a no-op after the first call', async () => {
    // Stale open session (endedAt well before FIXED_NOW -
    // IDLE_THRESHOLD) — the entry flush should close it on the
    // first `collect()` and leave the table untouched on the second.
    await seedSession({
      sessionId: 'stale-open',
      startedAt: tsAt(0),
      endedAt: tsAt(60),
      isOpen: true,
      frameIds: [1]
    });

    const service = buildService();

    const a = await service.collect();
    const b = await service.collect();

    // After both calls the session is closed.
    const rows = await sessionStore.listSessions({});
    expect(rows).toHaveLength(1);
    expect(rows[0].is_open).toBe(false);
    // Both reports agree on `openSessionCount: 0`.
    expect(a.sessions.openSessionCount).toBe(0);
    expect(b.sessions.openSessionCount).toBe(0);
    expect(b.sessions).toEqual(a.sessions);
  });
});

// ---------------------------------------------------------------------------
// W24 — providers zero-shot
// **Validates: Requirements 8.2**
// ---------------------------------------------------------------------------

describe('WorkActivityObservabilityService.collect (W24 — providers zero-shot)', () => {
  it('reports unknown status with no lastErrorAt/lastLatencyMs when no provider call has been recorded', async () => {
    const service = buildService();

    const result = await service.collect();

    expect(result.providers.embedding.kind).toBe('openai-compatible');
    expect(result.providers.embedding.status).toBe('unknown');
    expect(result.providers.embedding.lastErrorAt).toBeUndefined();
    expect(result.providers.embedding.lastLatencyMs).toBeUndefined();

    expect(result.providers.summary.kind).toBe('template');
    expect(result.providers.summary.status).toBe('unknown');
    expect(result.providers.summary.lastErrorAt).toBeUndefined();
    expect(result.providers.summary.lastLatencyMs).toBeUndefined();
  });

  it('still returns the configured embedding provider kind verbatim when the registry is empty', async () => {
    const service = buildService({ embeddingProviderKind: 'ollama' });

    const result = await service.collect();

    expect(result.providers.embedding.kind).toBe('ollama');
    expect(result.providers.embedding.status).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Failure modes — degraded sections do not poison their siblings
// ---------------------------------------------------------------------------

describe('WorkActivityObservabilityService.collect (failure modes)', () => {
  /**
   * A test-double `ExtractedContentStore` whose two read methods
   * always throw. Every write/list method is unimplemented because
   * `collect()` only calls the two read methods.
   */
  const throwingExtractedStore = {
    findLastExtractedAt: async () => {
      throw new Error('boom-extracted');
    },
    countByTimeWindow: async () => {
      throw new Error('boom-extracted');
    },
    upsert: async () => {
      throw new Error('not used');
    },
    getByFrameIds: async () => {
      throw new Error('not used');
    },
    deleteByFrameIds: async () => {
      throw new Error('not used');
    },
    listByTimeWindow: async () => {
      throw new Error('not used');
    }
  } satisfies ConstructorParameters<typeof WorkActivityObservabilityService>[0]['extractedContentStore'];

  it('throwing extractedContentStore fills degraded.extraction and leaves other blocks normal', async () => {
    // Seed enough state for sessions / summary to compute non-zero
    // values so the test can prove the failure was contained.
    await seedSession({
      sessionId: 'closed-1',
      startedAt: tsRecent(3600),
      endedAt: tsRecent(3500),
      isOpen: false,
      closedAt: tsRecent(3400),
      frameIds: [1],
      summaryStatus: 'pending'
    });

    const service = buildService({
      extractedContentStore: throwingExtractedStore
    });

    const result = await service.collect();

    // extraction degraded → zero values + reason captured
    expect(result.extraction).toEqual({
      lastExtractedAt: null,
      unextractedFrameRatio: 0,
      totalFramesLast24h: 0
    });
    expect(result.degraded?.extraction).toBe('boom-extracted');

    // sessions / summary / providers unaffected
    expect(result.sessions.openSessionCount).toBe(0);
    expect(result.sessions.totalSessionsLast24h).toBe(1);
    expect(result.summary.pendingCount).toBe(1);
    expect(result.providers.embedding.status).toBe('unknown');
    // No collateral damage in the other `degraded` slots.
    expect(result.degraded?.sessions).toBeUndefined();
    expect(result.degraded?.summary).toBeUndefined();
    expect(result.degraded?.providers).toBeUndefined();
  });

  it('throwing sessionStore counters fill degraded.sessions and leave other blocks normal', async () => {
    await seedExtraction({
      frameId: 1,
      frameTimestamp: tsRecent(3600),
      extractedText: 'present'
    });

    // Custom `SessionStore` that throws on the three observability
    // reads. We keep `closeOpenSessionsEndedBefore` working so the
    // entry flush succeeds — the failure under test is the
    // `collectSessions` path, not the flush guard.
    const baseStore = sessionStore;
    const throwingSessionStore: SessionStore = {
      ...baseStore,
      countOpenSessions: async () => {
        throw new Error('boom-sessions');
      },
      findLastClosedAt: async () => {
        throw new Error('boom-sessions');
      },
      countSessionsStartedSince: async () => {
        throw new Error('boom-sessions');
      },
      // Bind the methods that DO need to work back to the live
      // store so the entry flush + summary counters stay healthy.
      closeOpenSessionsEndedBefore:
        baseStore.closeOpenSessionsEndedBefore.bind(baseStore),
      countSessionsByStatus:
        baseStore.countSessionsByStatus.bind(baseStore),
      findOpenSessionFor: baseStore.findOpenSessionFor.bind(baseStore),
      appendFrame: baseStore.appendFrame.bind(baseStore),
      createSession: baseStore.createSession.bind(baseStore),
      closeSession: baseStore.closeSession.bind(baseStore),
      deleteSessionsTouchingFrames:
        baseStore.deleteSessionsTouchingFrames.bind(baseStore),
      listSessions: baseStore.listSessions.bind(baseStore),
      getSession: baseStore.getSession.bind(baseStore),
      updateSummary: baseStore.updateSummary.bind(baseStore)
    };

    // Build a fresh aggregator so the entry flush still works
    // through the wrapper's bound `closeOpenSessionsEndedBefore`.
    const wrappingAggregator: SessionAggregator =
      new DefaultSessionAggregator({
        store: throwingSessionStore,
        idleThresholdSeconds: IDLE_THRESHOLD,
        now: () => FIXED_NOW,
        generateSessionId: () => `sid-${++idCounter}`
      });

    const service = buildService({
      sessionStore: throwingSessionStore,
      sessionAggregator: wrappingAggregator
    });

    const result = await service.collect();

    expect(result.sessions).toEqual({
      openSessionCount: 0,
      lastClosedAt: null,
      totalSessionsLast24h: 0
    });
    expect(result.degraded?.sessions).toBe('boom-sessions');

    expect(result.extraction.lastExtractedAt).toBe(tsRecent(3600));
    expect(result.summary).toEqual({ pendingCount: 0, failedCount: 0 });
    expect(result.providers.embedding.status).toBe('unknown');
    expect(result.degraded?.extraction).toBeUndefined();
    expect(result.degraded?.summary).toBeUndefined();
    expect(result.degraded?.providers).toBeUndefined();
  });

  it('throwing summary status counter fills degraded.summary and leaves other blocks normal', async () => {
    await seedExtraction({
      frameId: 1,
      frameTimestamp: tsRecent(3600),
      extractedText: 'present'
    });

    const baseStore = sessionStore;
    const throwingSessionStore: SessionStore = {
      ...baseStore,
      countSessionsByStatus: async () => {
        throw new Error('boom-summary');
      },
      // Re-bind the rest so the entry flush + sessions block read
      // path stay healthy.
      closeOpenSessionsEndedBefore:
        baseStore.closeOpenSessionsEndedBefore.bind(baseStore),
      countOpenSessions: baseStore.countOpenSessions.bind(baseStore),
      findLastClosedAt: baseStore.findLastClosedAt.bind(baseStore),
      countSessionsStartedSince:
        baseStore.countSessionsStartedSince.bind(baseStore),
      findOpenSessionFor: baseStore.findOpenSessionFor.bind(baseStore),
      appendFrame: baseStore.appendFrame.bind(baseStore),
      createSession: baseStore.createSession.bind(baseStore),
      closeSession: baseStore.closeSession.bind(baseStore),
      deleteSessionsTouchingFrames:
        baseStore.deleteSessionsTouchingFrames.bind(baseStore),
      listSessions: baseStore.listSessions.bind(baseStore),
      getSession: baseStore.getSession.bind(baseStore),
      updateSummary: baseStore.updateSummary.bind(baseStore)
    };

    const wrappingAggregator: SessionAggregator =
      new DefaultSessionAggregator({
        store: throwingSessionStore,
        idleThresholdSeconds: IDLE_THRESHOLD,
        now: () => FIXED_NOW,
        generateSessionId: () => `sid-${++idCounter}`
      });

    const service = buildService({
      sessionStore: throwingSessionStore,
      sessionAggregator: wrappingAggregator
    });

    const result = await service.collect();

    expect(result.summary).toEqual({ pendingCount: 0, failedCount: 0 });
    expect(result.degraded?.summary).toBe('boom-summary');

    expect(result.extraction.lastExtractedAt).toBe(tsRecent(3600));
    expect(result.sessions).toEqual({
      openSessionCount: 0,
      lastClosedAt: null,
      totalSessionsLast24h: 0
    });
    expect(result.providers.embedding.status).toBe('unknown');
    expect(result.degraded?.extraction).toBeUndefined();
    expect(result.degraded?.sessions).toBeUndefined();
    expect(result.degraded?.providers).toBeUndefined();
  });

  it('throwing summaryRegistry.active() fills degraded.providers and leaves other blocks normal', async () => {
    await seedExtraction({
      frameId: 1,
      frameTimestamp: tsRecent(3600),
      extractedText: 'present'
    });

    // A SummaryProviderRegistry that explodes when asked for the
    // active provider. Casting through `unknown` because the class
    // is concrete; we only need to override the one method
    // `collectProviders` calls.
    const explodingRegistry = {
      active() {
        throw new Error('boom-providers');
      },
      fallback() {
        return new TemplateSummaryProvider();
      }
    } as unknown as SummaryProviderRegistry;

    const service = buildService({
      summaryProviderRegistry: explodingRegistry
    });

    const result = await service.collect();

    expect(result.providers.embedding.kind).toBe('openai-compatible');
    expect(result.providers.embedding.status).toBe('unknown');
    expect(result.providers.summary.kind).toBe('template');
    expect(result.providers.summary.status).toBe('unknown');
    expect(result.degraded?.providers).toBe('boom-providers');

    expect(result.extraction.lastExtractedAt).toBe(tsRecent(3600));
    expect(result.sessions.openSessionCount).toBe(0);
    expect(result.summary).toEqual({ pendingCount: 0, failedCount: 0 });
    expect(result.degraded?.extraction).toBeUndefined();
    expect(result.degraded?.sessions).toBeUndefined();
    expect(result.degraded?.summary).toBeUndefined();
  });
});
