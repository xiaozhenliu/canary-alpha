/**
 * `FindService` — evidence retrieval for the `find` MCP tool.
 *
 * Task 8.2 / 8.3 (work-activity-analysis). The service answers a
 * `FindRequest` with a list of `EvidenceItem`s, optionally grouped
 * by `sessionId`, plus a deterministic `narrativeText` summary
 * string. Three modes are supported:
 *
 *   - `mode='keyword'` (default) — direct SQL scan against
 *     `extracted_content` with NFC + locale-aware case folding done
 *     in JS. Index-served by `idx_extracted_content_keyword` /
 *     `idx_extracted_content_app_ts`.
 *   - `mode='semantic'` — embed the query through the configured
 *     `EmbeddingProvider`, search the `vectorStore`, then reverse-
 *     resolve each hit to its `extracted_content` row so the tool
 *     can return the canonical text and contextLabel. R7.6 falls
 *     back to keyword (with `degraded` set) when the embedding
 *     provider or vector store is unavailable.
 *   - `mode='hybrid'` — currently equivalent to `mode='semantic'`
 *     (R7.7, deferred). The service does NOT mark hybrid responses
 *     as degraded when running through the semantic path: the
 *     caller asked for hybrid and we are giving them what we can.
 *     A semantic-provider failure under hybrid still falls back to
 *     keyword, but the `degraded` field stays absent (per design
 *     §8.2 + tasks.md 8.3).
 *
 * Design references:
 *   - design.md §8.2 (keyword + semantic SQL / vector flow,
 *     narrativeText template, groupBy semantics).
 *   - requirements.md R7.2 / R7.3 / R7.4 / R7.5 / R7.6 / R7.7 /
 *     R7.8 / R7.15.
 *
 * **Validates: Requirements 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.15**
 */

import type { DerivedDatabase } from '../derived-database.js';
import type {
  EmbeddingProvider,
  VectorStore
} from '../../retrieval/types.js';
import type { ExtractedContentStore } from '../extraction/extracted-content-store.js';
import type { PrivacyStateReader } from '../../privacy/types.js';
import type { Logger } from '../../../types/app-config.js';
import { collectActiveCascadeFailureIntervals } from '../suppression.js';
import {
  collectKeywordMatches,
  rowToEvidenceItem,
  SQL_HARD_SCAN_LIMIT
} from './keyword-queries.js';
import { executeSemanticQuery } from './semantic-queries.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminator for the requested search mode. The MCP tool input
 * schema (R7.2) defaults to `'keyword'`; `'semantic'` and `'hybrid'`
 * will be added by task 8.3 (currently the service rejects them with
 * a typed error).
 */
export type FindMode = 'keyword' | 'semantic' | 'hybrid';

/**
 * Evidence row shape returned by the `find` tool (R7.3).
 *
 * The shape mirrors `evidenceItemSchema` in `src/mcp/tools/find.ts` —
 * keep the two in lock-step. `sessionId` is optional because a frame
 * may not yet belong to a closed/open session (e.g. a brand new frame
 * the aggregator has not folded in yet, or an extracted_content row
 * left over after Cascade_Delete removed the parent session).
 *
 * `frameId` is allowed to be `string | number` to mirror the upstream
 * MCP schema; this service always emits `number` because the
 * `extracted_content.frame_id` column is `INTEGER PRIMARY KEY`.
 */
export interface EvidenceItem {
  frameId: number;
  sessionId?: string;
  appName?: string;
  contextLabel: string;
  extractedText: string;
  timestamp: string;
  matchSource: 'keyword' | 'semantic';
  score?: number;
  sourceTypes: string[];
}

/**
 * `groupBy='session'` shape — same items as `data` but bucketed.
 *
 * Per design §8.2, the `data` array is preserved alongside
 * `groupedBySession` (callers can read either view); this means the
 * group's `items[]` are a strict subset of `data` keyed by `sessionId`.
 * Items without a `sessionId` (frames not yet attached to any session)
 * are dropped from the grouped view but remain in `data`.
 */
export interface SessionGroup {
  sessionId: string;
  items: EvidenceItem[];
}

/**
 * Input shape for `FindService.find`. Mirrors the MCP tool
 * `inputSchema` in `src/mcp/tools/find.ts`. Validation (length, default
 * values, ISO-8601 format) is the tool layer's responsibility — the
 * service trusts what it gets and only enforces semantic guards
 * (e.g. rejecting unsupported modes for now).
 */
export interface FindRequest {
  query: string;
  from?: string;
  to?: string;
  mode?: FindMode;
  appName?: string;
  limit?: number;
  groupBy?: 'session';
}

/**
 * Output shape.
 *
 * `narrativeText` is always present (R7.15 / W20). `groupedBySession`
 * is only populated when the caller asks for `groupBy='session'`.
 *
 * `degraded` carries three distinct signals on a single field:
 *
 *   1. **Semantic → keyword fallback** (R7.6) — the caller asked for
 *      `mode='semantic'` but the embedding provider or vector store
 *      was unavailable, so we ran the keyword path instead.
 *      `requestedMode='semantic'`, `actualMode='keyword'`.
 *   2. **Scan truncation** (task 8.2) — the keyword scan hit the
 *      `SQL_HARD_SCAN_LIMIT` ceiling before exhausting the time
 *      window. `requestedMode === actualMode === 'keyword'`, and
 *      `reason` explains the truncation. Callers SHOULD treat the
 *      result set as approximate and narrow the time window if
 *      completeness is required.
 *
 * `mode='hybrid'` is currently equivalent to `mode='semantic'` (R7.7
 * deferred); when hybrid runs through the semantic path successfully
 * the response does NOT carry a `degraded` marker (the user asked for
 * hybrid and the implementation gave them what it can — semantic).
 * If the semantic path under hybrid fails, the service still falls
 * back to keyword but again without `degraded`, per design §8.2 — the
 * `degraded` field is reserved for honest semantic→keyword degradation
 * the caller specifically requested via `mode='semantic'`.
 */
export interface FindResult {
  data: EvidenceItem[];
  groupedBySession?: SessionGroup[];
  narrativeText: string;
  degraded?: {
    requestedMode: FindMode;
    actualMode: 'keyword' | 'semantic';
    reason: string;
  };
}

/**
 * Service interface — kept narrow so unit tests of the MCP tool can
 * substitute a stub. The single method intentionally returns a
 * resolved promise (rather than throwing) when the result set is
 * empty; the only thrown errors are programming faults (unsupported
 * mode for now, malformed time bounds, etc.).
 */
export interface FindService {
  find(request: FindRequest): Promise<FindResult>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Default upper bound for `limit` when the caller omits it. Matches
 * the MCP tool input schema default (R7.2) and the `recall` tool
 * convention.
 */
const DEFAULT_LIMIT = 20;

/**
 * Hard ceiling on `limit` to keep a single tool call from bringing
 * back tens of thousands of rows. The MCP tool input schema also
 * caps at 100, so this is defensive — it guards the service when
 * called directly from non-MCP code paths (e.g. evaluation harness).
 */
const MAX_LIMIT = 100;

/**
 * Sentinel timestamps used when the caller omits `from` / `to`.
 *
 * The schema is `frame_timestamp TEXT NOT NULL` storing ISO-8601
 * strings, so we lean on lexicographic comparison: any real timestamp
 * sorts strictly between these two values. Keeping the SQL a single
 * `BETWEEN` clause (rather than dynamically building the WHERE) makes
 * the query plan stable and the `idx_extracted_content_keyword`
 * partial index addressable.
 */
const MIN_ISO = '0001-01-01T00:00:00.000Z';
const MAX_ISO = '9999-12-31T23:59:59.999Z';

/**
 * Constructor dependencies for {@link DefaultFindService}.
 *
 *   - `db` — the derived SQLite handle used by the keyword path.
 *     Mandatory; reused for the reverse session lookup that decorates
 *     both keyword and semantic results.
 *   - `embeddingProvider` / `vectorStore` — required for `mode='semantic'`
 *     (and the hybrid alias). Either may be omitted on test rigs that
 *     only exercise the keyword path; in that case semantic mode falls
 *     back to keyword via the R7.6 degradation branch.
 *   - `extractedContentStore` — used by the semantic path to fetch the
 *     canonical `contextLabel` / `extractedText` / `sourceTypes` for
 *     each vector hit. Optional for the same reason as the embedding
 *     pair: when absent, semantic mode degrades to keyword.
 */
export interface DefaultFindServiceDependencies {
  db: DerivedDatabase;
  embeddingProvider?: EmbeddingProvider;
  vectorStore?: VectorStore;
  extractedContentStore?: ExtractedContentStore;
  /**
   * Optional privacy-state reader. When provided, the service
   * filters out evidence items whose `frame_timestamp` falls within
   * an unresolved `cascade-failure` suppressed range (R9.1
   * Cascade_Delete partial-failure tombstone). Pause / delete-range
   * suppression rows do not gate `find` — they are recorded for
   * audit trace only — so the filter only consults rows tagged
   * `reason: 'cascade-failure'` with no `resolvedAt`.
   */
  privacyState?: PrivacyStateReader;
  logger?: Logger;
}

/**
 * Concrete `FindService` backed by direct SQL against the derived
 * database (keyword mode) and the configured `EmbeddingProvider` +
 * `VectorStore` (semantic / hybrid). Holds the dep bundle by
 * reference; the caller owns each member's lifecycle, mirroring
 * `SqliteExtractedContentStore` / `SqliteSessionStore`.
 *
 * Why direct SQL rather than going through `ExtractedContentStore` for
 * keyword: the store's `listByTimeWindow` does not support a keyword
 * filter or `appName` filter, and adding two ad-hoc filter parameters
 * there would clutter the store's API for a single consumer. The task
 * description explicitly allows "在 find-service 里直接发 SQL 走 derived
 * database" so we keep the keyword pipeline self-contained.
 *
 * The semantic path however does go through `ExtractedContentStore`
 * (`getByFrameIds`) — it needs the per-frame canonical row shape
 * (extractedText / contextLabel / sourceTypes), which the store
 * already returns; re-implementing it inline would duplicate the
 * row→`ExtractionResult` mapping.
 */
export class DefaultFindService implements FindService {
  private readonly db: DerivedDatabase;
  private readonly embeddingProvider: EmbeddingProvider | undefined;
  private readonly vectorStore: VectorStore | undefined;
  private readonly extractedContentStore: ExtractedContentStore | undefined;
  private readonly privacyState: PrivacyStateReader | undefined;
  private readonly logger: Logger | undefined;

  /**
   * Accepts either the legacy positional `DerivedDatabase` form (used
   * by tasks 8.2 unit tests and earlier wiring) or the new
   * `DefaultFindServiceDependencies` bundle (added in task 8.3 to
   * carry the semantic collaborators). Keeping the legacy form keeps
   * the migration trivial — call sites that only need keyword can
   * still construct `new DefaultFindService(db)` and the semantic
   * mode will simply degrade to keyword.
   */
  constructor(dependencies: DerivedDatabase | DefaultFindServiceDependencies) {
    if (isDependencyBundle(dependencies)) {
      this.db = dependencies.db;
      this.embeddingProvider = dependencies.embeddingProvider;
      this.vectorStore = dependencies.vectorStore;
      this.extractedContentStore = dependencies.extractedContentStore;
      this.privacyState = dependencies.privacyState;
      this.logger = dependencies.logger;
    } else {
      this.db = dependencies;
      this.embeddingProvider = undefined;
      this.vectorStore = undefined;
      this.extractedContentStore = undefined;
      this.privacyState = undefined;
      this.logger = undefined;
    }
  }

  async find(request: FindRequest): Promise<FindResult> {
    const startTime = performance.now();
    const requestedMode: FindMode = request.mode ?? 'keyword';

    // Hybrid is presently a deferred alias for semantic (R7.7).
    // We keep the request's `requestedMode` distinction so the
    // R7.6 degraded marker logic can tell whether the caller
    // actually asked for semantic — semantic requests that fall
    // back to keyword get a `degraded` marker, hybrid requests that
    // do the same do NOT (per design §8.2; the user asked for
    // hybrid, not for honest semantic-mode handling).
    let result: FindResult;
    if (requestedMode === 'semantic' || requestedMode === 'hybrid') {
      result = await this.findSemantic(request, requestedMode);
    } else {
      result = await this.findKeyword(request, /*degradedFromSemantic*/ null);
    }

    const durationMs = Math.round(performance.now() - startTime);
    this.logger?.info('Find query executed', {
      query: request.query,
      requestedMode,
      actualMode: result.degraded ? result.degraded.actualMode : requestedMode,
      resultsCount: result.data.length,
      durationMs
    });

    return result;
  }

  /**
   * Drop evidence items whose `timestamp` falls inside an unresolved
   * `cascade-failure` privacy suppression interval. The privacy
   * service writes such tombstones when Cascade_Delete partially
   * failed, and surfacing those rows would give the user the
   * impression their delete-range did nothing. Pause / delete-range
   * suppression rows are left alone — those windows already had
   * their derived rows cleaned, so filtering would erase legitimate
   * evidence.
   */
  private async applySuppressionFilter<T extends { timestamp: string }>(
    items: T[]
  ): Promise<T[]> {
    if (this.privacyState === undefined || items.length === 0) return items;
    let intervals: Array<{ from: number; to: number }>;
    try {
      const state = await this.privacyState.read();
      intervals = collectActiveCascadeFailureIntervals(state.suppressedRanges);
    } catch {
      // Defensive: a privacy-store read failure must not break
      // `find`. Surface every item — the worst case is the user
      // sees evidence they tried to delete, which is the same
      // behaviour as before this filter existed.
      return items;
    }
    if (intervals.length === 0) return items;
    return items.filter((item) => {
      const ms = Date.parse(item.timestamp);
      if (!Number.isFinite(ms)) return true;
      return !intervals.some((interval) => ms >= interval.from && ms <= interval.to);
    });
  }

  // -----------------------------------------------------------------------
  // Mode dispatch helpers
  // -----------------------------------------------------------------------

  /**
   * Semantic / hybrid path. Delegates the embed → vector-query →
   * reverse-resolve pipeline to {@link executeSemanticQuery} and
   * handles fallback / degradation / session decoration here.
   *
   *   - Caller requested `'semantic'` → mark `degraded` (R7.6).
   *   - Caller requested `'hybrid'` → no `degraded` marker (R7.7
   *     deferred; hybrid is currently best-effort semantic with
   *     keyword fallback).
   */
  private async findSemantic(
    request: FindRequest,
    requestedMode: 'semantic' | 'hybrid'
  ): Promise<FindResult> {
    const limit = clampLimit(request.limit);
    const from = request.from ?? MIN_ISO;
    const to = request.to ?? MAX_ISO;

    const degradedMarker: FindResult['degraded'] | null =
      requestedMode === 'semantic'
        ? { requestedMode, actualMode: 'keyword', reason: 'embedding provider unavailable' }
        : null;

    if (
      this.embeddingProvider === undefined ||
      this.vectorStore === undefined ||
      this.extractedContentStore === undefined
    ) {
      return this.findKeyword(request, degradedMarker);
    }

    const semanticItems = await executeSemanticQuery({
      embeddingProvider: this.embeddingProvider,
      vectorStore: this.vectorStore,
      extractedContentStore: this.extractedContentStore,
      query: request.query,
      from,
      to,
      appName: request.appName,
      limit
    });

    if (semanticItems === null) {
      return this.findKeyword(request, degradedMarker);
    }

    const survivingFrameIds = semanticItems.map((item) => item.frameId);
    const frameToSession = this.lookupSessionsByFrameIds(survivingFrameIds);
    for (const item of semanticItems) {
      const sessionId = frameToSession.get(item.frameId);
      if (sessionId !== undefined) item.sessionId = sessionId;
    }

    const filtered = await this.applySuppressionFilter(semanticItems);
    return {
      data: filtered,
      groupedBySession:
        request.groupBy === 'session' ? buildSessionGroups(filtered) : undefined,
      narrativeText: buildNarrativeText(filtered)
    };
  }

  /**
   * Keyword path. Shared between native `mode='keyword'` requests and
   * the R7.6 degradation branch from semantic. The optional
   * `degradedFromSemantic` argument carries the marker the caller
   * should see in the response; passing `null` (the native keyword
   * call site) leaves the marker absent unless the SQL scan itself
   * truncates.
   */
  private async findKeyword(
    request: FindRequest,
    degradedFromSemantic: FindResult['degraded'] | null
  ): Promise<FindResult> {
    const limit = clampLimit(request.limit);
    const from = request.from ?? MIN_ISO;
    const to = request.to ?? MAX_ISO;

    const { rows: matchedRows, truncated } = await collectKeywordMatches(this.db, {
      query: request.query,
      from,
      to,
      appName: request.appName ?? null,
      limit
    });

    // Step 2: enrich each candidate with its `sessionId` by joining
    // against `sessions.evidence_frame_ids` (JSON array). One round
    // trip handles all candidates.
    const frameIds = matchedRows.map((row) => Number(row.frame_id));
    const frameToSession = this.lookupSessionsByFrameIds(frameIds);

    const items: EvidenceItem[] = matchedRows.map((row) =>
      rowToEvidenceItem(row, frameToSession.get(Number(row.frame_id)))
    );

    // Step 3: optional `groupBy='session'`. Items without a
    // `sessionId` (extracted_content rows whose owning session was
    // already cascade-deleted, or rows the aggregator has not yet
    // folded in) are dropped from the grouped view but kept in
    // `data` so callers can still see them.
    //
    // The grouped view is computed from the filtered list below so
    // suppressed-window items disappear from both `data` and
    // `groupedBySession` consistently.

    // Resolve the `degraded` marker. Two distinct signals can fire:
    //
    //   1. `degradedFromSemantic` — the caller asked for `mode='semantic'`
    //      but the embedding provider / vector store was unavailable, so
    //      we ran the keyword path instead (R7.6). The marker is built
    //      by `findSemantic` and passed through verbatim.
    //   2. `truncated` — the keyword scan hit `SQL_HARD_SCAN_LIMIT`
    //      before exhausting the time window (task 8.2 hardening).
    //
    // When **both** fire (a semantic request that fell back to
    // keyword and then truncated), we report the semantic-fallback
    // signal — that's the more important explanation for the caller,
    // and the truncation is a secondary symptom of the same query
    // running on a window too large to scan exhaustively.
    let degraded: FindResult['degraded'] | undefined;
    if (degradedFromSemantic !== null) {
      degraded = degradedFromSemantic;
    } else if (truncated) {
      const requestedMode: FindMode = request.mode ?? 'keyword';
      degraded = {
        requestedMode,
        actualMode: 'keyword',
        reason: `keyword scan truncated at ${SQL_HARD_SCAN_LIMIT} rows; narrow the time window for a complete result`
      };
    }

    const filtered = await this.applySuppressionFilter(items);
    const filteredGroupedBySession =
      request.groupBy === 'session'
        ? buildSessionGroups(filtered)
        : undefined;
    return {
      data: filtered,
      groupedBySession: filteredGroupedBySession,
      narrativeText: buildNarrativeText(filtered),
      degraded
    };
  }

  /**
   * Builds a `frameId -> sessionId` map for the supplied frame IDs by
   * joining `sessions.evidence_frame_ids` (JSON array) via SQLite's
   * `json_each`. One row per (session, frame) pair; we collapse into
   * a Map keyed by frame_id.
   *
   * Why `json_each`: design §8.2 lists two reverse-lookup options
   * (LIKE on the JSON string, or json_each); the LIKE approach is
   * fragile (`LIKE '%1%'` matches `[11]`) so we use the structured
   * variant. SQLite ships JSON1 by default since 3.38, so this is
   * always available.
   *
   * Empty input is the fast path — `IN ()` is a SQL parse error and
   * cascade-delete bookkeeping frequently passes empty arrays during
   * dry runs.
   */
  private lookupSessionsByFrameIds(frameIds: number[]): Map<number, string> {
    const result = new Map<number, string>();
    if (frameIds.length === 0) return result;

    const unique = Array.from(new Set(frameIds));
    const placeholders = unique.map(() => '?').join(', ');
    const stmt = this.db.prepare(
      `SELECT s.session_id AS session_id,
              CAST(je.value AS INTEGER) AS frame_id
       FROM sessions s, json_each(s.evidence_frame_ids) je
       WHERE CAST(je.value AS INTEGER) IN (${placeholders})`
    );
    const rows = stmt.all(...unique) as unknown as Array<{
      session_id: string;
      frame_id: number | bigint;
    }>;
    for (const row of rows) {
      result.set(Number(row.frame_id), row.session_id);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Math.floor(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Type guard discriminating the `DefaultFindService` constructor's
 * legacy positional form (`DerivedDatabase`) from the new dependency
 * bundle (`DefaultFindServiceDependencies`).
 *
 * `DerivedDatabase` is the `DatabaseSync` handle from `node:sqlite`;
 * we recognise the bundle by the presence of its required `db`
 * property. The check is shape-based rather than `instanceof` because
 * the bundle is a plain object literal.
 */
function isDependencyBundle(
  value: DerivedDatabase | DefaultFindServiceDependencies
): value is DefaultFindServiceDependencies {
  return (
    typeof value === 'object' &&
    value !== null &&
    'db' in value &&
    (value as DefaultFindServiceDependencies).db !== undefined
  );
}

/**
 * Buckets items by `sessionId`. Order within a bucket follows the
 * input order (which is `frame_timestamp DESC` from the SQL `ORDER
 * BY`); the buckets themselves are emitted in first-seen order so
 * the most-recent fragment determines the group's position.
 */
function buildSessionGroups(items: EvidenceItem[]): SessionGroup[] {
  const groups = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    if (item.sessionId === undefined) continue;
    const bucket = groups.get(item.sessionId);
    if (bucket === undefined) {
      groups.set(item.sessionId, [item]);
    } else {
      bucket.push(item);
    }
  }
  return Array.from(groups, ([sessionId, items]) => ({ sessionId, items }));
}

/**
 * Builds the deterministic `narrativeText` for a `find` response.
 *
 * Per design §8.2, the template is:
 *
 *   "找到 N 条证据，分布在 M 个会话中（{appName 计数} 应用）。"
 *
 * where the appName breakdown is comma-separated `appName: count`
 * pairs, sorted by count descending then appName ascending so the
 * output is deterministic across runs (W22 Stateless). Items with
 * no `appName` are bucketed under the literal `'unknown'` so the
 * count reconciles with the total.
 *
 * When the result set is empty the narrative collapses to a single
 * sentence — the schema (R7.15) only requires the field be present
 * and stringly-typed, so this is the most useful empty-state
 * message we can offer without venturing into hallucinated stats.
 */
function buildNarrativeText(items: EvidenceItem[]): string {
  if (items.length === 0) {
    return '未找到匹配证据。';
  }
  const sessionIds = new Set(items.map((it) => it.sessionId).filter((id): id is string => id !== undefined));
  const appCounts = new Map<string, number>();
  for (const item of items) {
    const key = item.appName ?? 'unknown';
    appCounts.set(key, (appCounts.get(key) ?? 0) + 1);
  }
  const appBreakdown = Array.from(appCounts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .map(([appName, count]) => `${appName}: ${count}`)
    .join(', ');
  return `找到 ${items.length} 条证据，分布在 ${sessionIds.size} 个会话中（${appBreakdown} 应用）。`;
}

