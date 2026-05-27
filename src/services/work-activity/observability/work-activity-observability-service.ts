/**
 * `WorkActivityObservabilityService` — read-only rollup that powers the
 * work-activity-analysis additions to the `internal-status` MCP tool
 * (design §9.2, work-activity-analysis task 9.1).
 *
 * The service composes four independent sections:
 *
 *   - **`extraction`** — most-recent successful extraction timestamp
 *     plus the ratio of `Empty_Extraction` rows in the trailing 24h
 *     window (R2.1 / R2.2).
 *   - **`sessions`** — open session count, last `closed_at`, and the
 *     count of sessions started in the trailing 24h window (R4.1 /
 *     R4.2).
 *   - **`summary`** — pending and failed/degraded session counts (R8.1).
 *     `failedCount = countByStatus('failed') + countByStatus('degraded')`
 *     per design §9.2.
 *   - **`providers`** — embedding + summary provider snapshots backed
 *     by {@link ProviderHealthRegistry} (R8.2 / R8.3).
 *     `providers.summary.kind` reflects the **user-configured** active
 *     provider (W23) rather than any runtime fallback the worker may
 *     be doing — observability surfaces "what the user asked for", not
 *     "what we used most recently". `providers.embedding.kind` is the
 *     wire identifier of the configured embedding provider (e.g.
 *     `'openai-compatible'`, `'ollama'`).
 *
 * Each section is computed inside its own try/catch so a derived-store
 * read failure (SQLite locked, JSON parse error, transient I/O) never
 * crashes the whole `internal-status` call. Failures collapse to zero
 * values plus a `degraded.<sectionName>` string carrying the error
 * message (design §9 / Error Handling). The four properties this
 * service has to honour are:
 *
 *   - **W5 Idempotence** — same database state ⇒ same `extraction`
 *     output across consecutive `collect()` calls; no writes outside
 *     the `flushIdleOpenSessions` entry call.
 *   - **W6 Zero-shot safety** — empty `extracted_content` table
 *     returns `lastExtractedAt: null` / `unextractedFrameRatio: 0`
 *     without throwing.
 *   - **W12 Sessions Idempotence** — same database state ⇒ same
 *     `sessions` block; no derived writes during the call (after the
 *     entry flush, which is itself idempotent — W11).
 *   - **W24 Providers zero-shot** — `providers.embedding.status`
 *     defaults to `'unknown'` until a provider has been called,
 *     without throwing.
 *
 * The service entry calls `sessionAggregator.flushIdleOpenSessions(now)`
 * once per `collect()` (design §9.2 — "保证 openSessionCount 不含已经
 * 超阈值但还没关闭的 stale 会话"). The flush itself is idempotent
 * (W11) so observability acting as a second flush call site does not
 * mutate state when nothing is stale.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 4.1, 4.2, 4.3, 8.1, 8.2, 8.3**
 */

import type { ExtractedContentStore } from '../extraction/extracted-content-store.js';
import type { SessionAggregator } from '../sessions/aggregator.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { SummaryProviderRegistry } from '../summary/registry.js';
import type {
  ProviderHealthEntry,
  ProviderHealthRegistry
} from './provider-health-registry.js';

// ---------------------------------------------------------------------------
// Public types — mirror design §9.1 / §9.2 verbatim
// ---------------------------------------------------------------------------

/**
 * `extraction` block. Schema mirrors `extractionStatusSchema` in design
 * §9.1; field semantics are R2.1 / R2.2.
 */
export interface ExtractionStatus {
  /**
   * ISO-8601 timestamp of the most-recent row in `extracted_content`
   * with a non-empty `extracted_text`. R2.1 — Empty_Extraction does
   * NOT count. `null` when no successful extraction has happened yet.
   */
  lastExtractedAt: string | null;
  /**
   * Ratio of rows in the trailing 24h window whose
   * `extracted_text === ''`. Range `[0, 1]`. Returns `0.0` on a zero
   * sample (R2.2) — the contract is "empty input ⇒ 0", not
   * `NaN`/`null`. Computed from {@link ExtractedContentStore.countByTimeWindow}
   * as `empty / total` with a fast-path when `total === 0`.
   */
  unextractedFrameRatio: number;
  /**
   * Total number of `extracted_content` rows in the trailing 24h
   * window (both `Empty_Extraction` and successful rows count).
   * Pinned by design §9.1's `extractionStatusSchema`. Surfaced
   * alongside `unextractedFrameRatio` so callers can interpret the
   * ratio without re-querying the store — `ratio * totalFramesLast24h`
   * gives the empty count and `(1 - ratio) * totalFramesLast24h`
   * gives the successful count. Returns `0` on a zero sample.
   */
  totalFramesLast24h: number;
}

/**
 * `sessions` block. Schema mirrors `sessionsStatusSchema` in design
 * §9.1; field semantics are R4.1 / R4.2.
 */
export interface SessionsStatus {
  /** Number of rows with `is_open = 1` in the `sessions` table. */
  openSessionCount: number;
  /**
   * Most-recent `closed_at` across closed sessions, or `null` when
   * no session has ever closed.
   */
  lastClosedAt: string | null;
  /**
   * Count of sessions whose `started_at >= now - 24h`. Includes both
   * still-open and already-closed sessions.
   */
  totalSessionsLast24h: number;
}

/**
 * `summary` block. Schema mirrors `summaryStatusSchema` in design
 * §9.1; field semantics are R8.1. `failedCount` aggregates the
 * `'failed'` and `'degraded'` summary statuses per design §9.2.
 */
export interface SummaryRollup {
  pendingCount: number;
  failedCount: number;
}

/**
 * Provider health snapshot. Wire shape matches `providersEmbeddingSchema`
 * / `providersSummarySchema` in design §9.1 — the optional `lastErrorAt`
 * / `lastLatencyMs` fields are emitted only when the underlying
 * {@link ProviderHealthEntry} has them populated.
 *
 * `kind` is the verbatim provider identifier (string for embedding to
 * accommodate the open-ended `'openai-compatible'` / `'ollama'` /
 * `'none'` enumeration; closed `'template' | 'remote-llm'` union for
 * summary).
 */
export interface ProviderStatus<KindT extends string = string> {
  kind: KindT;
  status: 'ok' | 'unavailable' | 'unknown';
  lastErrorAt?: string;
  lastLatencyMs?: number;
}

/**
 * Combined `providers` block.
 */
export interface ProvidersStatus {
  embedding: ProviderStatus<string>;
  summary: ProviderStatus<'template' | 'remote-llm'>;
}

/**
 * Per-section degradation reasons. Each key is set only when the
 * corresponding section's computation threw — the value is the error
 * message captured at the boundary (`err.message` for `Error`, else
 * `String(err)`). Zero values are still surfaced under the section
 * itself; the `degraded` map tells the operator the section is
 * approximate.
 */
export interface ObservabilityDegradation {
  extraction?: string;
  sessions?: string;
  summary?: string;
  providers?: string;
}

/**
 * Aggregate result of {@link WorkActivityObservabilityService.collect}.
 * The shape is what `internal-status` flattens into its outputSchema
 * (task 9.2). `degraded` is omitted entirely when no section fell back
 * — keeping the shape minimal in the happy path.
 */
export interface WorkActivityStatus {
  extraction: ExtractionStatus;
  sessions: SessionsStatus;
  summary: SummaryRollup;
  providers: ProvidersStatus;
  degraded?: ObservabilityDegradation;
}

// ---------------------------------------------------------------------------
// Constructor dependencies
// ---------------------------------------------------------------------------

/**
 * Construction-time wiring for {@link WorkActivityObservabilityService}.
 *
 * `now` is injectable so tests can pin the trailing-24h window to a
 * deterministic boundary. `embeddingProviderKind` is sourced from
 * `config.providers.embeddings.kind` at app bootstrap — the
 * observability service does not re-read configuration on each call,
 * so a runtime config swap requires reconstructing the service (which
 * is consistent with how {@link SummaryProviderRegistry} treats the
 * configured provider).
 */
export interface WorkActivityObservabilityDependencies {
  extractedContentStore: ExtractedContentStore;
  sessionStore: SessionStore;
  sessionAggregator: SessionAggregator;
  summaryProviderRegistry: SummaryProviderRegistry;
  providerHealth: ProviderHealthRegistry;
  embeddingProviderKind: string;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Read-only observability collector. Holds no mutable state of its
 * own — every call to {@link collect} re-reads the dependencies, so
 * idempotence is structural rather than cached.
 */
export class WorkActivityObservabilityService {
  private readonly now: () => Date;

  constructor(private readonly deps: WorkActivityObservabilityDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Compute the four-section rollup. Each section runs in its own
   * try/catch — on failure the section returns its zero-value default
   * and `degraded.<sectionName>` is populated with the error message
   * (design §9 Error Handling). The four sections never short-circuit
   * each other: a `sessions` failure does not poison `extraction`.
   *
   * Idempotence: the only write path reachable from this method is
   * the entry-call to `sessionAggregator.flushIdleOpenSessions(now)`.
   * That flush is itself idempotent (W11) — when nothing is stale, no
   * SQL `UPDATE` runs. After the flush the rest of the method is
   * pure SQL `SELECT`s plus reads against the `ProviderHealthRegistry`
   * (which is mutation-free from this service's perspective).
   */
  async collect(): Promise<WorkActivityStatus> {
    const at = this.now();

    // Entry flush. Wrapped in its own try/catch so a database-locked
    // / SQLite-busy failure does not propagate; we degrade the
    // `sessions` section instead. The flush failure path is rare in
    // production (the indexer also flushes on every `runOnce`), but
    // the error envelope is the safer default for an observability
    // tool that promises "never fails".
    let flushFailure: string | null = null;
    try {
      await this.deps.sessionAggregator.flushIdleOpenSessions(at);
    } catch (err) {
      flushFailure = describeError(err);
    }

    // 24h window [from, to]; `from = now - 86_400s`. The bound is
    // **inclusive** on both sides — `countByTimeWindow` and
    // `countSessionsStartedSince` use `BETWEEN` / `>=` matching that
    // semantic. The seconds → ms conversion stays inline so the math
    // is greppable and the constant matches design §9.2 verbatim.
    const to = at.toISOString();
    const from = new Date(at.getTime() - 86_400 * 1000).toISOString();

    const degraded: ObservabilityDegradation = {};
    if (flushFailure !== null) degraded.sessions = flushFailure;

    const extraction = await this.collectExtraction(from, to, degraded);
    const sessions = await this.collectSessions(from, degraded);
    const summary = await this.collectSummary(degraded);
    const providers = this.collectProviders(degraded);

    const result: WorkActivityStatus = {
      extraction,
      sessions,
      summary,
      providers
    };
    if (
      degraded.extraction !== undefined ||
      degraded.sessions !== undefined ||
      degraded.summary !== undefined ||
      degraded.providers !== undefined
    ) {
      result.degraded = degraded;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Section computations
  // -------------------------------------------------------------------------

  private async collectExtraction(
    from: string,
    to: string,
    degraded: ObservabilityDegradation
  ): Promise<ExtractionStatus> {
    try {
      // Two reads per call: the most-recent successful extraction
      // timestamp, and the empty/total counts in the 24h window. Both
      // hit cheap SQL paths (the `idx_extracted_content_keyword`
      // partial index supports the first; the second is a single
      // aggregate query in `countByTimeWindow`).
      const lastExtractedAt =
        await this.deps.extractedContentStore.findLastExtractedAt();
      const counts = await this.deps.extractedContentStore.countByTimeWindow(
        from,
        to
      );
      // W6 zero-shot safety: an empty `extracted_content` table is
      // the canonical fresh-bootstrap state. `total === 0` ⇒ ratio 0,
      // not NaN. Negative `empty` is impossible given the SQL
      // expression but we clamp defensively so an upstream contract
      // change cannot leak `Infinity`.
      const ratio = counts.total === 0 ? 0 : counts.empty / counts.total;
      return {
        lastExtractedAt,
        unextractedFrameRatio: clampUnitInterval(ratio),
        totalFramesLast24h: counts.total
      };
    } catch (err) {
      degraded.extraction = describeError(err);
      return zeroExtraction();
    }
  }

  private async collectSessions(
    from: string,
    degraded: ObservabilityDegradation
  ): Promise<SessionsStatus> {
    try {
      // Three independent reads. We could parallelise with
      // `Promise.all` but the underlying `node:sqlite` driver is
      // synchronous and reuses the same connection — sequential calls
      // keep the SQL ordering predictable for tests asserting
      // single-statement behaviour.
      const openSessionCount =
        await this.deps.sessionStore.countOpenSessions();
      const lastClosedAt = await this.deps.sessionStore.findLastClosedAt();
      const totalSessionsLast24h =
        await this.deps.sessionStore.countSessionsStartedSince(from);
      return { openSessionCount, lastClosedAt, totalSessionsLast24h };
    } catch (err) {
      // Preserve the entry-flush degradation reason if it set one;
      // overwrite only when this section produces a fresh failure.
      // Either case still populates `degraded.sessions`, so the
      // operator sees one reason rather than a stack of them.
      degraded.sessions = describeError(err);
      return zeroSessions();
    }
  }

  private async collectSummary(
    degraded: ObservabilityDegradation
  ): Promise<SummaryRollup> {
    try {
      // Three reads matching design §9.2. Aggregate `failed +
      // degraded` so the wire `failedCount` reflects "summaries the
      // user cannot trust", regardless of whether the row is a
      // permanent failure or a transient template-fallback.
      const pendingCount =
        await this.deps.sessionStore.countSessionsByStatus('pending');
      const failed =
        await this.deps.sessionStore.countSessionsByStatus('failed');
      const degradedCount =
        await this.deps.sessionStore.countSessionsByStatus('degraded');
      return { pendingCount, failedCount: failed + degradedCount };
    } catch (err) {
      degraded.summary = describeError(err);
      return zeroSummary();
    }
  }

  private collectProviders(
    degraded: ObservabilityDegradation
  ): ProvidersStatus {
    try {
      // `providers.embedding`: kind comes from app config; status /
      // latency / lastErrorAt come from the live registry.
      const embedding = providerHealthToStatus(
        this.deps.embeddingProviderKind,
        this.deps.providerHealth.embedding
      );

      // `providers.summary`: kind comes from the registry's `active()`
      // (W23 — the wire reflects user configuration even if the
      // worker is currently routing through `fallback()` because of a
      // pause). Status / latency / lastErrorAt come from the live
      // registry.
      const activeKind = this.deps.summaryProviderRegistry.active().kind;
      const summary = providerHealthToStatus<'template' | 'remote-llm'>(
        activeKind,
        this.deps.providerHealth.summary
      );

      return { embedding, summary };
    } catch (err) {
      degraded.providers = describeError(err);
      return zeroProviders(this.deps.embeddingProviderKind);
    }
  }
}

// ---------------------------------------------------------------------------
// Section helpers (private)
// ---------------------------------------------------------------------------

/**
 * Map a {@link ProviderHealthEntry} onto the on-the-wire
 * {@link ProviderStatus}. `lastErrorAt` and `lastLatencyMs` are emitted
 * only when populated — the `internal-status` outputSchema marks both
 * as optional, so omitting them preserves the slim "happy path" shape
 * (W24 — zero-call entry has neither field).
 */
function providerHealthToStatus<KindT extends string>(
  kind: KindT,
  entry: ProviderHealthEntry
): ProviderStatus<KindT> {
  const out: ProviderStatus<KindT> = { kind, status: entry.status };
  if (entry.lastErrorAt !== undefined) out.lastErrorAt = entry.lastErrorAt;
  if (entry.lastLatencyMs !== undefined) out.lastLatencyMs = entry.lastLatencyMs;
  return out;
}

/**
 * Zero-value defaults used when a section's computation throws. Kept
 * as small builders so the shape is reused identically on the happy
 * path (`collect*` returns the same object literal) and on the
 * degraded path.
 */
function zeroExtraction(): ExtractionStatus {
  return {
    lastExtractedAt: null,
    unextractedFrameRatio: 0,
    totalFramesLast24h: 0
  };
}

function zeroSessions(): SessionsStatus {
  return { openSessionCount: 0, lastClosedAt: null, totalSessionsLast24h: 0 };
}

function zeroSummary(): SummaryRollup {
  return { pendingCount: 0, failedCount: 0 };
}

function zeroProviders(embeddingKind: string): ProvidersStatus {
  return {
    embedding: { kind: embeddingKind, status: 'unknown' },
    // `'template'` is the default user-configured provider per
    // `appConfigSchema`'s default; surfacing it as the fallback kind
    // when the registry itself fails matches what the user would see
    // on a fresh bootstrap before any provider has been wired.
    summary: { kind: 'template', status: 'unknown' }
  };
}

/**
 * Clamp a computed ratio into `[0, 1]`. Defensive guard against an
 * unexpected `NaN` / `Infinity` slipping through the SQL → JS coercion
 * (would only happen on a SQLite-driver bug; pinning this here keeps
 * the `internal-status` shape stable regardless).
 */
function clampUnitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Normalise an unknown thrown value into a string suitable for the
 * `degraded.<section>` field. `Error.message` is preserved verbatim so
 * the operator sees the SQLite / JSON parse cause; non-Error throws
 * fall back to `String(err)`.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
