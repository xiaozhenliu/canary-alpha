/**
 * Keyword (SQL) query pipeline for the `find` MCP tool.
 *
 * Extracted from `find-service.ts` (GRO-171) so the service file
 * retains only orchestration. All keyword-specific logic — the
 * keyset-paginated scan, JS-side NFC + locale-aware case folding,
 * and the raw-row → `EvidenceItem` mapping — lives here.
 */

import type { DerivedDatabase } from '../derived-database.js';
import type { EvidenceItem } from './find-service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Page size for the keyset-paginated keyword scan. Sized small
 * enough that JS keyword evaluation per round stays cheap (1k
 * rows ≈ 1k `String.prototype.normalize` + `toLocaleLowerCase`
 * calls), but large enough that the round-trip overhead per page
 * does not dominate. The perf SLA test in task 13.1 (24h × 1Hz
 * × 5 apps ≈ 432k rows) drives the upper bound; smaller windows
 * complete in a single page.
 */
export const SQL_PAGE_SIZE = 1_000;

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
export const SQL_HARD_SCAN_LIMIT = 500_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw row shape returned by the keyword SELECT. Mirrors the column
 * names verbatim. We do not pull `context_key`, `extracted_text_hash`,
 * `extraction_rule_kind`, or `inserted_at` — none of them surface in
 * the `EvidenceItem` schema, so reading less is faster and avoids
 * accidentally leaking the hash through the tool output.
 */
export interface RawExtractedContentRow {
  frame_id: number | bigint;
  frame_timestamp: string;
  app_name: string | null;
  context_label: string;
  extracted_text: string;
  source_types: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
export function normaliseForKeyword(s: string): string {
  return s.normalize('NFC').toLocaleLowerCase('en-US');
}

/**
 * Defensive `JSON.parse` for the `source_types` column. Same shape
 * as the helper in `extracted-content-store.ts`; duplicated here so
 * the keyword query path stays a self-contained read path. The store's
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

export function rowToEvidenceItem(
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

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Single-page SELECT used by {@link collectKeywordMatches}.
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
export function fetchPage(
  db: DerivedDatabase,
  filters: {
    from: string;
    to: string;
    appName: string | null;
    cursorFrameId: number | null;
    pageSize: number;
  }
): RawExtractedContentRow[] {
  if (filters.cursorFrameId === null) {
    const stmt = db.prepare(
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

  const stmt = db.prepare(
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
export async function collectKeywordMatches(
  db: DerivedDatabase,
  filters: {
    query: string;
    from: string;
    to: string;
    appName: string | null;
    limit: number;
  }
): Promise<{ rows: RawExtractedContentRow[]; truncated: boolean }> {
  const normalisedQuery = normaliseForKeyword(filters.query);
  const matched: RawExtractedContentRow[] = [];

  let cursorTimestamp = filters.to;
  let cursorFrameId: number | null = null;
  let scannedRows = 0;
  let truncated = false;

  while (matched.length < filters.limit) {
    const page = fetchPage(db, {
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

    const lastRow = page[page.length - 1];
    cursorTimestamp = lastRow.frame_timestamp;
    cursorFrameId = Number(lastRow.frame_id);

    if (page.length < SQL_PAGE_SIZE) break;
  }

  return { rows: matched, truncated };
}
