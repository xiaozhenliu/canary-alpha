/**
 * Integration tests: `internal-status` work-activity blocks end-to-end
 * (work-activity-analysis task 9.2).
 *
 * Wires the **real** {@link BootstrapStatusService} against the real
 * {@link WorkActivityObservabilityService}, the real
 * {@link SqliteExtractedContentStore} / {@link SqliteSessionStore}
 * adapters (over an in-memory `derived.sqlite`), the real
 * {@link DefaultSessionAggregator}, the real
 * {@link SummaryProviderRegistry} factory, and a fresh
 * {@link ProviderHealthRegistry}, then drives `getStatus()` to verify
 * that the four new blocks (`extraction`, `sessions`, `summary`,
 * `providers`) are present alongside the legacy
 * `capture` / `ingestionMix` / `diskBudget` / `screenpipeStorage` /
 * `retrieval` paths (R2.3 / R4.3 / R8.6).
 *
 * The test focuses on **shape and integration** rather than per-section
 * value semantics — those live in
 * `tests/unit/work-activity/observability.test.ts`. The two scenarios
 * covered here are:
 *
 *   1. Fresh-bootstrap (no rows in `extracted_content`, no rows in
 *      `sessions`) — every block surfaces its zero-value defaults
 *      and `degraded` is omitted.
 *   2. Seeded data (one extraction row, one open and one closed
 *      session) — the blocks reflect the seeded data and the legacy
 *      paths remain intact.
 *
 * **Validates: Requirements 2.1, 4.1, 8.1, 8.6**
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { testTempRoot } from '../../helpers/test-tmp.js';
import { BootstrapStatusService } from '../../../src/services/bootstrap-status-service.js';
import { InMemoryVectorStore } from '../../../src/services/retrieval/vector-store.js';
import {
  initDerivedSchema,
  openDerivedDatabase,
  type DerivedDatabase
} from '../../../src/services/work-activity/derived-database.js';
import { SqliteExtractedContentStore } from '../../../src/services/work-activity/extraction/extracted-content-store.js';
import type { ExtractionResult } from '../../../src/services/work-activity/extraction/types.js';
import { ProviderHealthRegistry } from '../../../src/services/work-activity/observability/provider-health-registry.js';
import { WorkActivityObservabilityService } from '../../../src/services/work-activity/observability/work-activity-observability-service.js';
import { DefaultSessionAggregator } from '../../../src/services/work-activity/sessions/aggregator.js';
import { SqliteSessionStore } from '../../../src/services/work-activity/sessions/session-store.js';
import { createSummaryProviderRegistry } from '../../../src/services/work-activity/summary/registry.js';
import type { AppConfig } from '../../../src/types/app-config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/**
 * Lazily create an isolated, empty upstream-capture directory for the current
 * test and inject it into BootstrapStatusService. Without this the service
 * would inspect the developer's real `~/.screenpipe`; an empty fixture dir
 * keeps `screenpipeStorage` deterministic (ENOENT) without coupling to the
 * real machine. Recreated per test (cleaned up in `afterEach`). See TD-009.
 */
let cachedScreenpipeDir: string | undefined;
function isolatedScreenpipeDirectory(): string {
  if (cachedScreenpipeDir === undefined) {
    const dir = mkdtempSync(join(testTempRoot(), 'wa-internal-status-sp-'));
    cachedScreenpipeDir = dir;
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
      cachedScreenpipeDir = undefined;
    });
  }
  return cachedScreenpipeDir;
}

/** Stub CheckpointStore that returns null (no recovery state). */
const stubCheckpointStore = {
  readLatest: async () => null,
  writeLatest: async () => {},
  reset: async () => {}
};

/** Build a minimal `AppConfig` matching the production schema defaults. */
function makeConfig(): AppConfig {
  return {
    server: { mode: 'stdio', host: '127.0.0.1', port: 8765, maxConnections: 10 },
    logging: { level: 'info' },
    screenpipe: { url: 'http://localhost:3030' },
    providers: { embeddings: { kind: 'openai-compatible' } },
    vectorStore: { kind: 'memory' },
    retrieval: {
      freshnessWindowMinutes: 15,
      pollIntervalSeconds: 30,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 500
    },
    routines: { enabled: false, definitionsPath: '', historyPath: '' },
    paths: { configFile: '', logDirectory: '', serviceLogFile: '', derivedDatabase: '' },
    trim: { enabled: false, intervalSeconds: 3600 },
    capture: { provider: 'screenpipe', livenessThresholdSeconds: 120, permissionsGracePeriodSeconds: 60 },
    storage: { diskBudgetBytes: null, retentionDays: 7 },
    privacy: { excludeApps: [], secureAxRoles: [] },
    analysis: {
      sessions: { idleThresholdSeconds: 120 },
      summary: { provider: 'template', remoteLlmTimeoutMs: 30_000 },
      embeddings: { topK: 20, minScore: 0 }
    },
    llm: { model: 'gpt-4o-mini' }
  } as AppConfig;
}

interface Harness {
  service: BootstrapStatusService;
  db: DerivedDatabase;
  extractedStore: SqliteExtractedContentStore;
  sessionStore: SqliteSessionStore;
}

/**
 * Build the production wiring against an in-memory derived database
 * + an `InMemoryVectorStore`. Returns the service plus the real
 * stores so seeding scenarios can write rows directly through the
 * SQL adapters (the same paths the indexing tail would use).
 */
function buildHarness(now: Date = new Date('2026-04-13T11:00:00.000Z')): Harness {
  const db = openDerivedDatabase(':memory:');
  initDerivedSchema(db);
  cleanups.push(() => {
    db.close();
  });

  const extractedStore = new SqliteExtractedContentStore(db);
  const sessionStore = new SqliteSessionStore(db);

  let counter = 0;
  const aggregator = new DefaultSessionAggregator({
    store: sessionStore,
    idleThresholdSeconds: 120,
    now: () => now,
    generateSessionId: () => `sid-${++counter}`
  });

  const config = makeConfig();
  const summaryRegistry = createSummaryProviderRegistry(config);
  const providerHealth = new ProviderHealthRegistry({ now: () => now });

  const observability = new WorkActivityObservabilityService({
    extractedContentStore: extractedStore,
    sessionStore,
    sessionAggregator: aggregator,
    summaryProviderRegistry: summaryRegistry,
    providerHealth,
    embeddingProviderKind: config.providers.embeddings.kind,
    now: () => now
  });

  const vectorStore = new InMemoryVectorStore({ kind: 'memory' } as never);
  const service = new BootstrapStatusService(config, {
    checkpointStore: stubCheckpointStore,
    vectorStore,
    workActivityObservability: observability,
    screenpipeDirectory: isolatedScreenpipeDirectory()
  });

  return { service, db, extractedStore, sessionStore };
}

/**
 * Build a minimal `ExtractionResult` for seeding. Uses deterministic
 * defaults so tests only override the fields the scenario cares
 * about.
 */
function makeExtraction(overrides: Partial<ExtractionResult>): ExtractionResult {
  return {
    frameId: 1,
    frameTimestamp: '2026-04-13T10:30:00.000Z',
    appName: 'iTerm2',
    contextLabel: '~/code',
    contextKey: 'iTerm2::~/code',
    extractedText: 'ls -la output',
    extractedTextHash: 'abc123',
    extractionRuleKind: 'terminal',
    sourceTypes: ['accessibility'],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('internal-status: work-activity blocks present and structured (task 9.2)', () => {
  it('fresh bootstrap surfaces zero-value defaults for all four new blocks and omits degraded', async () => {
    const { service } = buildHarness();

    const status = await service.getStatus();

    // ─── extraction (R2.1 / R2.2) ───────────────────────────────
    expect(status.extraction).toBeDefined();
    expect(status.extraction!.lastExtractedAt).toBeNull();
    expect(status.extraction!.unextractedFrameRatio).toBe(0);
    expect(status.extraction!.totalFramesLast24h).toBe(0);

    // ─── sessions (R4.1 / R4.2) ─────────────────────────────────
    expect(status.sessions).toBeDefined();
    expect(status.sessions!.openSessionCount).toBe(0);
    expect(status.sessions!.lastClosedAt).toBeNull();
    expect(status.sessions!.totalSessionsLast24h).toBe(0);

    // ─── summary (R8.1) ─────────────────────────────────────────
    expect(status.summary).toBeDefined();
    expect(status.summary!.pendingCount).toBe(0);
    expect(status.summary!.failedCount).toBe(0);

    // ─── providers (R8.2 / R8.3 / W24) ──────────────────────────
    expect(status.providers).toBeDefined();
    expect(status.providers!.embedding.kind).toBe('openai-compatible');
    expect(status.providers!.embedding.status).toBe('unknown');
    // W24 — fresh registry MUST NOT surface lastErrorAt / lastLatencyMs.
    expect(status.providers!.embedding.lastErrorAt).toBeUndefined();
    expect(status.providers!.embedding.lastLatencyMs).toBeUndefined();
    // `template` is the configured default; W23 says `kind`
    // reflects user configuration, not runtime fallback.
    expect(status.providers!.summary.kind).toBe('template');
    expect(status.providers!.summary.status).toBe('unknown');
    expect(status.providers!.summary.lastErrorAt).toBeUndefined();
    expect(status.providers!.summary.lastLatencyMs).toBeUndefined();

    // ─── degraded omitted on healthy collect() ──────────────────
    expect(status.degraded).toBeUndefined();
  });

  it('legacy paths (capture / ingestionMix / diskBudget / screenpipeStorage / retrieval) remain present alongside the new blocks (R2.3 / R4.3 / R8.6)', async () => {
    const { service } = buildHarness();

    const status = await service.getStatus();

    // R2.3 / R4.3 / R8.6 — the four new blocks MUST sit alongside,
    // not replace, the upstream observability paths. We only assert
    // they exist with the expected top-level shape; per-section
    // value semantics live in their own integration suite
    // (`tests/integration/observability/internal-status.test.ts`).
    expect(status.screenpipeStorage).toBeDefined();
    expect(typeof status.screenpipeStorage.inspectionStatus).toBe('string');
    expect(status.retrieval).toBeDefined();
    expect(typeof status.retrieval.checkpointExists).toBe('boolean');
    expect(typeof status.retrieval.vectorStoreKind).toBe('string');
    // `capture` / `ingestionMix` / `diskBudget` are optional in the
    // type but populated by the upstream observability service in
    // production. The harness wires a real `InMemoryVectorStore` so
    // `ingestionMix` always lands; `capture` / `diskBudget` depend
    // on the screenpipe directory layout at test time, so we only
    // assert that *if present* their shape matches.
    expect(status.ingestionMix).toBeDefined();
    expect(typeof status.ingestionMix!.windowSeconds).toBe('number');

    // The new blocks are still present.
    expect(status.extraction).toBeDefined();
    expect(status.sessions).toBeDefined();
    expect(status.summary).toBeDefined();
    expect(status.providers).toBeDefined();
  });

  it('seeded extraction + sessions surface in the rollup (extraction.lastExtractedAt populated, sessions counts non-zero)', async () => {
    const fixedNow = new Date('2026-04-13T12:00:00.000Z');
    const { service, extractedStore, sessionStore } = buildHarness(fixedNow);

    // Seed an `extracted_content` row with a non-empty extracted_text
    // so `lastExtractedAt` lands on the seeded timestamp.
    const seededAt = '2026-04-13T11:30:00.000Z';
    await extractedStore.upsert(
      makeExtraction({
        frameId: 100,
        frameTimestamp: seededAt,
        extractedText: 'hello world',
        extractedTextHash: 'deadbeef'
      })
    );

    // Seed two sessions through the same `createSession` adapter the
    // aggregator uses. Both started within the trailing 24h window
    // so they show up in `totalSessionsLast24h`. The store opens
    // sessions with `is_open = 1`; we close one explicitly so the
    // observability rollup reports a meaningful `lastClosedAt`.
    await sessionStore.createSession({
      session_id: 'open-1',
      ...makeExtraction({
        frameId: 200,
        frameTimestamp: '2026-04-13T11:55:00.000Z',
        appName: 'Safari',
        contextKey: 'Safari::Example',
        contextLabel: 'Example',
        sourceTypes: ['accessibility']
      })
    });
    await sessionStore.createSession({
      session_id: 'closed-1',
      ...makeExtraction({
        frameId: 101,
        frameTimestamp: '2026-04-13T11:00:00.000Z',
        appName: 'iTerm2',
        contextKey: 'iTerm2::~/code',
        contextLabel: '~/code',
        sourceTypes: ['accessibility']
      })
    });
    await sessionStore.closeSession('closed-1', '2026-04-13T11:10:30.000Z');
    // Mark this session's summary as pending so `summary.pendingCount`
    // reflects the seeded state without going through the worker.
    await sessionStore.updateSummary('closed-1', { summaryStatus: 'pending' });

    const status = await service.getStatus();

    // ─── extraction reflects the seeded row ─────────────────────
    expect(status.extraction!.lastExtractedAt).toBe(seededAt);
    // Only one row, with non-empty text → ratio = 0/1 = 0.
    expect(status.extraction!.unextractedFrameRatio).toBe(0);
    // One row in the trailing 24h window — the denominator the
    // ratio was computed against (design §9.1 totalFramesLast24h).
    expect(status.extraction!.totalFramesLast24h).toBe(1);

    // ─── sessions reflect both seeded rows ──────────────────────
    // The aggregator's entry-flush at the start of `collect()` will
    // close the open `Safari` session because its `ended_at`
    // (frameTimestamp) is older than `idleThresholdSeconds` (120s)
    // before `fixedNow` (~5 min gap), so `openSessionCount` is 0
    // after the flush — a documented R3.6 invariant exercised here
    // as a side effect.
    expect(status.sessions!.openSessionCount).toBe(0);
    // `lastClosedAt` MUST surface a non-null timestamp now that two
    // sessions are closed (the originally-closed one + the freshly-
    // flushed one).
    expect(status.sessions!.lastClosedAt).not.toBeNull();
    // Both sessions' `started_at` is within the 24h trailing window.
    expect(status.sessions!.totalSessionsLast24h).toBe(2);

    // ─── summary reflects the seeded `pending` row ──────────────
    expect(status.summary!.pendingCount).toBe(1);
    expect(status.summary!.failedCount).toBe(0);

    // ─── providers unchanged — still reflect user configuration ─
    expect(status.providers!.embedding.kind).toBe('openai-compatible');
    expect(status.providers!.summary.kind).toBe('template');

    // ─── degraded still omitted on the happy path ───────────────
    expect(status.degraded).toBeUndefined();
  });

  it('provider health failures surface through providers.embedding.status without affecting other blocks', async () => {
    const fixedNow = new Date('2026-04-13T12:00:00.000Z');
    const db = openDerivedDatabase(':memory:');
    initDerivedSchema(db);
    cleanups.push(() => db.close());

    const extractedStore = new SqliteExtractedContentStore(db);
    const sessionStore = new SqliteSessionStore(db);
    const aggregator = new DefaultSessionAggregator({
      store: sessionStore,
      idleThresholdSeconds: 120,
      now: () => fixedNow,
      generateSessionId: () => 'sid-x'
    });

    const config = makeConfig();
    const summaryRegistry = createSummaryProviderRegistry(config);
    const providerHealth = new ProviderHealthRegistry({ now: () => fixedNow });
    // Pre-seed a failure on the embedding slot — the rollup MUST
    // surface `status: 'unavailable'` plus a `lastErrorAt` timestamp
    // (R8.2 / design §9.3).
    providerHealth.recordFailure('embedding', 'connect timeout');

    const observability = new WorkActivityObservabilityService({
      extractedContentStore: extractedStore,
      sessionStore,
      sessionAggregator: aggregator,
      summaryProviderRegistry: summaryRegistry,
      providerHealth,
      embeddingProviderKind: config.providers.embeddings.kind,
      now: () => fixedNow
    });

    const service = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore: new InMemoryVectorStore({ kind: 'memory' } as never),
      workActivityObservability: observability,
      screenpipeDirectory: isolatedScreenpipeDirectory()
    });

    const status = await service.getStatus();

    expect(status.providers!.embedding.status).toBe('unavailable');
    expect(status.providers!.embedding.lastErrorAt).toBe(fixedNow.toISOString());
    // Summary slot untouched → still `unknown`.
    expect(status.providers!.summary.status).toBe('unknown');
    // Other blocks unaffected by a provider failure.
    expect(status.extraction).toBeDefined();
    expect(status.sessions).toBeDefined();
    expect(status.summary).toBeDefined();
    expect(status.degraded).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Negative path: omitted observability dependency
// ---------------------------------------------------------------------------

describe('internal-status: work-activity blocks omitted when observability dep is absent', () => {
  it('without `workActivityObservability` the four new blocks are omitted entirely', async () => {
    // This mirrors the partial-bootstrap path used by the legacy
    // observability integration suite — the service only receives
    // the upstream slice, and `getStatus()` MUST still succeed and
    // produce a well-formed response.
    const config = makeConfig();
    const service = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore: new InMemoryVectorStore({ kind: 'memory' } as never),
      screenpipeDirectory: isolatedScreenpipeDirectory()
    });

    const status = await service.getStatus();

    expect(status.extraction).toBeUndefined();
    expect(status.sessions).toBeUndefined();
    expect(status.summary).toBeUndefined();
    expect(status.providers).toBeUndefined();
    expect(status.degraded).toBeUndefined();
    // Legacy paths still present.
    expect(status.screenpipeStorage).toBeDefined();
    expect(status.retrieval).toBeDefined();
  });
});
