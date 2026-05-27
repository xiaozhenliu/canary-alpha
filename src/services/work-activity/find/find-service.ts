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
  RetrievalEvidenceItem,
  VectorSearchRequest,
  VectorStore
} from '../../retrieval/types.js';
import type { ExtractedContentStore } from '../extraction/extracted-content-store.js';
import type { ExtractionResult } from '../extraction/types.js';
import type { PrivacyStateReader } from '../../privacy/types.js';

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
    } else {
      this.db = dependencies;
      this.embeddingProvider = undefined;
      this.vectorStore = undefined;
      this.extractedContentStore = undefined;
      this.privacyState = undefined;
    }
  }

  async find(request: FindRequest): Promise<FindResult> {
    const requestedMode: FindMode = request.mode ?? 'keyword';

    // Hybrid is presently a deferred alias for semantic (R7.7).
    // We keep the request's `requestedMode` distinction so the
    // R7.6 degraded marker logic can tell whether the caller
    // actually asked for semantic — semantic requests that fall
    // back to keyword get a `degraded` marker, hybrid requests that
    // do the same do NOT (per design §8.2; the user asked for
    // hybrid, not for honest semantic-mode handling).
    if (requestedMode === 'semantic' || requestedMode === 'hybrid') {
      return this.findSemantic(request, requestedMode);
    }

    return this.findKeyword(request, /*degradedFromSemantic*/ null);
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
   * Semantic / hybrid path. Embeds the query, queries the vector
   * store, and reverse-resolves each hit to its `extracted_content`
   * row. On any failure (provider unavailable, vector store missing,
   * embed throws, query throws) we fall back to keyword mode:
   *
   *   - Caller requested `'semantic'` → mark `degraded` (R7.6).
   *   - Caller requested `'hybrid'` → no `degraded` marker (R7.7
   *     deferred; hybrid is currently best-effort semantic with
   *     keyword fallback, and the response should not falsely claim
   *     "honest semantic was requested but downgraded").
   */
  private async findSemantic(
    request: FindRequest,
    requestedMode: 'semantic' | 'hybrid'
  ): Promise<FindResult> {
    const limit = clampLimit(request.limit);
    const from = request.from ?? MIN_ISO;
    const to = request.to ?? MAX_ISO;

    // Pre-flight: any missing collaborator forces a graceful
    // degradation rather than a hard error. The MCP wiring layer
    // SHOULD provide the full bundle, but unit tests / fixtures may
    // construct the service with only the keyword deps (see the
    // legacy positional constructor).
    if (
      this.embeddingProvider === undefined ||
      this.vectorStore === undefined ||
      this.extractedContentStore === undefined
    ) {
      return this.findKeyword(
        request,
        requestedMode === 'semantic'
          ? {
              requestedMode,
              actualMode: 'keyword',
              reason: 'embedding provider unavailable'
            }
          : null
      );
    }

    // Step 1: embed the query. Provider failures (network down, quota
    // exhausted, process not running) are mapped to the documented
    // R7.6 fallback path; we do NOT raise — `find` is read-only and
    // the keyword index is always available as a fallback.
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embeddingProvider.embed(request.query);
    } catch {
      return this.findKeyword(
        request,
        requestedMode === 'semantic'
          ? {
              requestedMode,
              actualMode: 'keyword',
              reason: 'embedding provider unavailable'
            }
          : null
      );
    }

    // Step 2: query the vector store. Same degradation discipline as
    // the embed call above — vector-store failures fall back rather
    // than bubble up.
    //
    // We over-fetch (`limit * 2`) to leave headroom for two
    // post-filtering steps that may shrink the candidate list:
    //   1. Hash-dedup may produce multiple frames that share the
    //      same embedding (different frameIds, identical text).
    //   2. The reverse `extracted_content` lookup may drop frames
    //      whose row has since been Cascade_Deleted (race window).
    // The over-fetch is bounded (×2 + max 100) so it can't blow up
    // pathologically.
    const vectorRequest: VectorSearchRequest = {
      queryEmbedding,
      from,
      to,
      appName: request.appName,
      limit: Math.max(limit * 2, limit)
    };
    let vectorHits: RetrievalEvidenceItem[];
    try {
      vectorHits = await this.vectorStore.query(vectorRequest);
    } catch {
      return this.findKeyword(
        request,
        requestedMode === 'semantic'
          ? {
              requestedMode,
              actualMode: 'keyword',
              reason: 'embedding provider unavailable'
            }
          : null
      );
    }

    // Step 3: reverse-resolve each hit to its `extracted_content` row
    // so the response carries the canonical text + label, then trim
    // back down to `limit`. We also build a map from frameId → vector
    // score so we can attach the score to the EvidenceItem.
    const frameIds = vectorHits
      .map((hit) => extractFrameId(hit))
      .filter((id): id is number => id !== null);

    if (frameIds.length === 0) {
      // Vector store had no usable hits in the window. Return an
      // empty data set rather than degrading — semantic returned
      // honestly, just with no matches.
      return {
        data: [],
        groupedBySession: request.groupBy === 'session' ? [] : undefined,
        narrativeText: buildNarrativeText([])
      };
    }

    const rows = await this.extractedContentStore.getByFrameIds(frameIds);
    const rowsByFrameId = new Map<number, ExtractionResult>(
      rows.map((row) => [row.frameId, row])
    );

    // Preserve the vector store's ordering (highest score first) by
    // walking `vectorHits` and looking up the row. Frames that have
    // since been Cascade_Deleted are silently dropped.
    const orderedItems: EvidenceItem[] = [];
    for (const hit of vectorHits) {
      if (orderedItems.length >= limit) break;
      const frameId = extractFrameId(hit);
      if (frameId === null) continue;
      const row = rowsByFrameId.get(frameId);
      if (row === undefined) continue;
      orderedItems.push(rowToSemanticEvidenceItem(row, hit.score));
    }

    // Reverse-lookup sessionId for each surviving frame.
    const survivingFrameIds = orderedItems.map((item) => item.frameId);
    const frameToSession = this.lookupSessionsByFrameIds(survivingFrameIds);
    for (const item of orderedItems) {
      const sessionId = frameToSession.get(item.frameId);
      if (sessionId !== undefined) item.sessionId = sessionId;
    }

    const filtered = await this.applySuppressionFilter(orderedItems);
    const filteredGroupedBySession =
      request.groupBy === 'session' ? buildSessionGroups(filtered) : undefined;
    return {
      data: filtered,
      groupedBySession: filteredGroupedBySession,
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

    // Step 1: page through `extracted_content` in `frame_timestamp
    // DESC` order, keyword-filter each page in JS, and stop once we
    // have `limit` matches. This pattern keeps the keyword filter
    // authoritatively in JS (so non-ASCII case + NFC normalisation
    // work correctly — see `normaliseForKeyword`) without ever
    // pulling the entire window into memory at once.
    //
    // Why pagination instead of a single capped fetch:
    //   * A single SQL `LIMIT N` (where N >= some multiplier of the
    //     user limit) silently drops valid matches that sit deeper
    //     in the time window than the multiplier allows. Codex
    //     flagged this in the first round of review of task 8.2.
    //   * The SQL stage is bounded by index-served predicates
    //     (`extracted_text != ''`, `frame_timestamp BETWEEN`,
    //     `app_name = ?`), so the worst-case scan is the user's
    //     time window — no pathological all-table-scan.
    //   * Each page fetch is small (`SQL_PAGE_SIZE`), so peak heap
    //     usage stays bounded even on a 24h window with hundreds of
    //     thousands of frames (the perf SLA fixture in task 13.1).
    //
    // The scan can still hit the defensive `SQL_HARD_SCAN_LIMIT`
    // ceiling. When it does, `truncated` flips to `true` so the
    // caller can surface a `degraded` marker instead of returning
    // a possibly-incomplete result silently.
    const { rows: matchedRows, truncated } = await this.collectKeywordMatches({
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

  // -----------------------------------------------------------------------
  // Internal SQL helpers
  // -----------------------------------------------------------------------

  /**
   * Pages through `extracted_content` (newest first) and applies the
   * authoritative JS keyword filter, stopping as soon as the caller's
   * `limit` is satisfied. The pagination key is the latest seen
   * `frame_timestamp`; SQLite's `idx_extracted_content_timestamp` (or
   * `idx_extracted_content_app_ts` when `appName` is bound) serves
   * the predicate cheaply.
   *
   * The SQL stage filters only by indexed predicates (time window,
   * appName, non-empty extracted text) — the keyword filter is JS-
   * side because SQLite's built-in `lower()` is ASCII-only and would
   * silently exclude valid non-ASCII case mismatches (e.g. stored
   * `CAFÉ` against query `café`).
   *
   * Pagination key tie-breaking: when two rows share the same
   * `frame_timestamp`, we use `frame_id` (PRIMARY KEY) as the
   * secondary key. Without the tie-breaker the same row could be
   * returned on consecutive pages, leading to duplicates in the
   * result set.
   */
  private async collectKeywordMatches(filters: {
    query: string;
    from: string;
    to: string;
    appName: string | null;
    limit: number;
  }): Promise<{ rows: RawExtractedContentRow[]; truncated: boolean }> {
    const normalisedQuery = normaliseForKeyword(filters.query);
    const matched: RawExtractedContentRow[] = [];

    // Pagination cursor: `(timestamp, frame_id)` — strictly less than
    // the smallest pair seen so far. We seed with the upper bound so
    // the first page is the most-recent slice of the window.
    let cursorTimestamp = filters.to;
    let cursorFrameId: number | null = null;
    let scannedRows = 0;
    let truncated = false;

    // The defensive ceiling is enforced row-wise (not page-wise) so
    // the early-exit check inside the inner loop is exact: as soon
    // as we have scanned `SQL_HARD_SCAN_LIMIT` rows without hitting
    // `limit` matches, we set `truncated = true` and return whatever
    // we have. Surfacing the truncation on the result lets callers
    // distinguish "no more matches in window" from "scan capped".
    while (matched.length < filters.limit) {
      const page = this.fetchPage({
        from: filters.from,
        to: cursorTimestamp,
        appName: filters.appName,
        cursorFrameId,
        pageSize: SQL_PAGE_SIZE
      });
      if (page.length === 0) break;

      let stoppedEarly = false;
      for (const row of page) {
        if (
          normaliseForKeyword(row.extracted_text).includes(normalisedQuery)
        ) {
          matched.push(row);
          if (matched.length >= filters.limit) {
            stoppedEarly = true;
            break;
          }
        }
        scannedRows++;
        if (scannedRows >= SQL_HARD_SCAN_LIMIT) {
          truncated = true;
          stoppedEarly = true;
          break;
        }
      }
      if (stoppedEarly) break;

      // Advance the cursor past the last row in the page.
      const lastRow = page[page.length - 1];
      cursorTimestamp = lastRow.frame_timestamp;
      cursorFrameId = Number(lastRow.frame_id);

      // If the page came back smaller than `pageSize`, SQLite has
      // exhausted the window — no point asking for more.
      if (page.length < SQL_PAGE_SIZE) break;
    }

    return { rows: matched, truncated };
  }

  /**
   * Single-page SELECT used by `collectKeywordMatches`.
   *
   * The WHERE clause uses a `(timestamp, frame_id)` keyset cursor
   * matching the (DESC, DESC) order so iteration is index-friendly:
   *
   *   * `frame_timestamp < cursorTimestamp` — primary key advance,
   *   * `OR (frame_timestamp = cursorTimestamp AND frame_id <
   *     cursorFrameId)` — secondary key advance for ties.
   *
   * On the first page (`cursorFrameId === null`) the secondary
   * predicate is replaced with `frame_timestamp <= cursorTimestamp`
   * so the upper-bound row is included — the user-supplied `to`
   * bound is inclusive (R7.4 BETWEEN semantics).
   *
   * `(? IS NULL OR app_name = ?)` lets us bind the appName
   * parameter twice (positional) and keeps the query plan stable
   * between "filter by app" and "any app".
   */
  private fetchPage(filters: {
    from: string;
    to: string;
    appName: string | null;
    cursorFrameId: number | null;
    pageSize: number;
  }): RawExtractedContentRow[] {
    if (filters.cursorFrameId === null) {
      const stmt = this.db.prepare(
        `SELECT
            frame_id,
            frame_timestamp,
            app_name,
            context_label,
            extracted_text,
            source_types
         FROM extracted_content
         WHERE extracted_text != ''
           AND frame_timestamp BETWEEN ? AND ?
           AND (? IS NULL OR app_name = ?)
         ORDER BY frame_timestamp DESC, frame_id DESC
         LIMIT ?`
      );
      return stmt.all(
        filters.from,
        filters.to,
        filters.appName,
        filters.appName,
        filters.pageSize
      ) as unknown as RawExtractedContentRow[];
    }

    const stmt = this.db.prepare(
      `SELECT
          frame_id,
          frame_timestamp,
          app_name,
          context_label,
          extracted_text,
          source_types
       FROM extracted_content
       WHERE extracted_text != ''
         AND frame_timestamp >= ?
         AND (? IS NULL OR app_name = ?)
         AND (
           frame_timestamp < ?
           OR (frame_timestamp = ? AND frame_id < ?)
         )
       ORDER BY frame_timestamp DESC, frame_id DESC
       LIMIT ?`
    );
    return stmt.all(
      filters.from,
      filters.appName,
      filters.appName,
      filters.to,
      filters.to,
      filters.cursorFrameId,
      filters.pageSize
    ) as unknown as RawExtractedContentRow[];
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

/**
 * Typed error for callers that want to distinguish "service missing
 * capability" from "request invalid" or "database down". Task 8.3
 * will catch this in the tool handler to fall back to keyword search
 * with a `degraded` annotation.
 */
export class FindModeNotImplementedError extends Error {
  readonly code = 'FIND_MODE_NOT_IMPLEMENTED' as const;
  constructor(public readonly mode: FindMode) {
    super(`FindService: mode "${mode}" is not implemented yet (task 8.3).`);
    this.name = 'FindModeNotImplementedError';
  }
}

// ---------------------------------------------------------------------------
// Helpers — kept private to this module
// ---------------------------------------------------------------------------

/**
 * Raw row shape returned by the keyword SELECT. Mirrors the column
 * names verbatim. We do not pull `context_key`, `extracted_text_hash`,
 * `extraction_rule_kind`, or `inserted_at` — none of them surface in
 * the `EvidenceItem` schema, so reading less is faster and avoids
 * accidentally leaking the hash through the tool output.
 */
interface RawExtractedContentRow {
  frame_id: number | bigint;
  frame_timestamp: string;
  app_name: string | null;
  context_label: string;
  extracted_text: string;
  source_types: string;
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  // The MCP schema layer enforces `positive().max(100)`, but defend
  // against direct service calls that bypass it.
  const n = Math.floor(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Page size for the keyset-paginated keyword scan. Sized small
 * enough that JS keyword evaluation per round stays cheap (1k
 * rows ≈ 1k `String.prototype.normalize` + `toLocaleLowerCase`
 * calls), but large enough that the round-trip overhead per page
 * does not dominate. The perf SLA test in task 13.1 (24h × 1Hz
 * × 5 apps ≈ 432k rows) drives the upper bound; smaller windows
 * complete in a single page.
 */
const SQL_PAGE_SIZE = 1_000;

/**
 * Hard ceiling on the total number of rows the service will scan
 * before giving up on the keyword search. Defends against a
 * pathological query that never matches: without a ceiling, the
 * service would page through the entire `extracted_content` table.
 *
 * The value is generous (500k rows) — task 13.1's perf SLA fixture
 * is ~432k rows and the SLA is ≤ 500ms; if the keyword never
 * matches, we still need to scan everything once, so the ceiling
 * has to be larger than the fixture itself.
 */
const SQL_HARD_SCAN_LIMIT = 500_000;

/**
 * Normalises both the query and stored text to a comparable form.
 *
 *   - Unicode NFC canonical composition so accents written as
 *     decomposed sequences (e.g. `é` = `e` + combining acute) match
 *     their precomposed counterparts.
 *   - `toLocaleLowerCase('en-US')` to avoid the Turkish-i pitfall —
 *     the dotless `i` lower-cases differently in Turkish, which
 *     would otherwise make two machines disagree on whether a query
 *     matches.
 *
 * Mirrors the rule used by `normalizeWindowTitle` in the sessions
 * package, but kept local here to avoid a cross-package import for
 * a one-line helper.
 */
function normaliseForKeyword(s: string): string {
  return s.normalize('NFC').toLocaleLowerCase('en-US');
}

function rowToEvidenceItem(
  row: RawExtractedContentRow,
  sessionId: string | undefined
): EvidenceItem {
  return {
    frameId: Number(row.frame_id),
    sessionId,
    appName: row.app_name ?? undefined,
    contextLabel: row.context_label,
    extractedText: row.extracted_text,
    timestamp: row.frame_timestamp,
    matchSource: 'keyword',
    sourceTypes: parseSourceTypes(row.source_types)
  };
}

/**
 * Re-shapes an `ExtractionResult` (returned by
 * `ExtractedContentStore.getByFrameIds`) into the semantic-mode
 * `EvidenceItem` shape. Differs from `rowToEvidenceItem` in two
 * ways:
 *
 *   - `matchSource` is `'semantic'` because the row was reached via
 *     the vector store (R7.5). When the semantic path falls back
 *     to keyword (R7.6), `findKeyword` is called instead and emits
 *     `'keyword'` items; we never lie about how a hit was scored.
 *   - The caller passes the vector-store score so the response can
 *     surface it via the optional `score` field (R7.3).
 *
 * `sessionId` is left undefined here; `findSemantic` decorates the
 * items in a separate pass via `lookupSessionsByFrameIds`, mirroring
 * the keyword path.
 */
function rowToSemanticEvidenceItem(
  row: ExtractionResult,
  score: number | undefined
): EvidenceItem {
  return {
    frameId: row.frameId,
    appName: row.appName,
    contextLabel: row.contextLabel,
    extractedText: row.extractedText,
    timestamp: row.frameTimestamp,
    matchSource: 'semantic',
    score,
    sourceTypes: row.sourceTypes
  };
}

/**
 * Recovers the numeric frame id from a `RetrievalEvidenceItem` that
 * came back from the vector store.
 *
 * The embedding service (design §5.1, `embedding-service.ts`) writes
 * each row with `id = "extracted:${frameId}"` and stuffs `frameId`
 * into `metadata.frameId`. The current `RetrievalEvidenceItem` shape
 * does NOT surface metadata to read consumers, so we parse the id
 * prefix instead — same source of truth, exactly one parser site.
 *
 * Returns `null` for any id that does not match the expected prefix
 * or whose suffix is not a finite integer; the caller drops such
 * hits silently rather than fabricating a frame id.
 */
function extractFrameId(hit: RetrievalEvidenceItem): number | null {
  const id = hit.id;
  if (typeof id !== 'string' || !id.startsWith('extracted:')) return null;
  const suffix = id.slice('extracted:'.length);
  if (suffix.length === 0) return null;
  const parsed = Number(suffix);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return parsed;
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
 * Defensive `JSON.parse` for the `source_types` column. Same shape
 * as the helper in `extracted-content-store.ts`; duplicated here so
 * `find-service.ts` stays a self-contained read path. The store's
 * version is the authoritative writer-side guard.
 */
function parseSourceTypes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    /* fall through */
  }
  return [];
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


/**
 * Collapse the persisted suppressed-range list to the millisecond
 * intervals that should hide derived rows from `find` / `recall`.
 *
 * Only rows tagged with `reason: 'cascade-failure'` and without
 * `resolvedAt` are returned — the older `pause` and `delete-range`
 * tombstones are treated as audit trace and do NOT gate retrieval
 * (their derived rows were already cleaned at the time the
 * tombstone was written).
 *
 * Unparseable timestamps are dropped silently rather than collapsed
 * to NaN — the worst case is a malformed tombstone fails to suppress
 * the rows it was supposed to, which is recoverable on the next
 * reconciliation pass.
 */
export function collectActiveCascadeFailureIntervals(
  ranges: readonly { from: string; to: string; reason?: string; resolvedAt?: string }[] | undefined
): Array<{ from: number; to: number }> {
  if (!ranges || ranges.length === 0) return [];
  const intervals: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    if (range.reason !== 'cascade-failure') continue;
    if (range.resolvedAt !== undefined) continue;
    const from = Date.parse(range.from);
    const to = Date.parse(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    intervals.push({ from: Math.min(from, to), to: Math.max(from, to) });
  }
  return intervals;
}
