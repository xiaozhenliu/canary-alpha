/**
 * Derived-database adapter for the per-frame `extracted_content` table.
 *
 * Task 3.4 (work-activity-analysis): wraps the SQLite operations the rest
 * of the pipeline needs against the `derived.sqlite` database initialised
 * by {@link ../derived-database.ts}. The schema is defined in design §1
 * "Components and Interfaces — 派生存储 schema":
 *
 *   CREATE TABLE extracted_content (
 *     frame_id              INTEGER PRIMARY KEY,
 *     frame_timestamp       TEXT NOT NULL,
 *     app_name              TEXT,
 *     context_label         TEXT NOT NULL,
 *     context_key           TEXT NOT NULL,
 *     extracted_text        TEXT NOT NULL,
 *     extracted_text_hash   TEXT,
 *     extraction_rule_kind  TEXT NOT NULL,
 *     source_types          TEXT NOT NULL,  -- JSON array string
 *     inserted_at           TEXT NOT NULL DEFAULT (...)
 *   );
 *
 * The store is a thin synchronous wrapper exposed through `Promise`
 * methods so consumers can compose with the rest of the pipeline (which
 * is `Promise`-based for symmetry with the embedding provider's network
 * calls). All SQL goes through `node:sqlite`'s `DatabaseSync`, matching
 * the rest of the work-activity package.
 *
 * **Validates: Requirements 1.1, 2.1**
 */

import type { DerivedDatabase } from '../derived-database.js';
import type { ExtractionResult, ExtractionRuleKind } from './types.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Storage adapter for `extracted_content` rows.
 *
 * Operations:
 *
 *   - `upsert(e)` — INSERT OR REPLACE the row keyed by `frameId`.
 *   - `getByFrameIds(ids)` — bulk fetch by primary key. The result order
 *     matches the natural ordering of the IN clause (no client-side sort);
 *     callers that need deterministic ordering should sort on the result.
 *   - `deleteByFrameIds(ids)` — bulk delete by primary key. Returns the
 *     number of rows actually removed (sum of `changes` across chunks).
 *   - `listByTimeWindow(from, to)` — sorted-by-time scan for the
 *     `extraction.lastExtractedAt` / `find` paths; both bounds are
 *     inclusive (R7.4 semantics carry over for time filtering).
 *   - `countByTimeWindow(from, to)` — single-pass count (`total` / `empty`)
 *     used by the observability `extraction.unextractedFrameRatio`.
 *   - `findLastExtractedAt()` — most recent `frame_timestamp` across rows
 *     with non-empty `extracted_text` (R2.1 — Empty_Extraction does not
 *     count as a successful extraction).
 *
 * Empty-input fast paths: every bulk method MUST short-circuit when the
 * input array is empty, returning the zero/empty value without touching
 * the database. SQLite's `IN ()` is a syntax error, and the pipeline
 * frequently passes empty `evidence_frame_ids` during cascade-delete
 * dry runs.
 */
export interface ExtractedContentStore {
  upsert(e: ExtractionResult): Promise<void>;
  getByFrameIds(ids: number[]): Promise<ExtractionResult[]>;
  deleteByFrameIds(ids: number[]): Promise<number>;
  listByTimeWindow(from: string, to: string): Promise<ExtractionResult[]>;
  countByTimeWindow(
    from: string,
    to: string
  ): Promise<{ total: number; empty: number }>;
  findLastExtractedAt(): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Maximum number of `?` placeholders expanded into a single SQL
 * statement. SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 32 766 on
 * Node ≥ 22's bundled SQLite, but older builds use 999 — we play it
 * safe with a smaller chunk so the store works regardless of which
 * limit applies. Bulk methods split larger inputs into multiple round
 * trips.
 */
const MAX_BIND_PARAMS = 500;

/**
 * Concrete `ExtractedContentStore` backed by `node:sqlite` (the
 * synchronous core driver used by the rest of the work-activity
 * package).
 *
 * The class holds a reference to the `DerivedDatabase` instance —
 * lifecycle (open/close) is the caller's responsibility, matching the
 * convention used by other derived-database adapters in this package.
 */
export class SqliteExtractedContentStore implements ExtractedContentStore {
  constructor(private readonly db: DerivedDatabase) {}

  async upsert(e: ExtractionResult): Promise<void> {
    // INSERT OR REPLACE keyed by `frame_id` (PRIMARY KEY) — re-running
    // extraction on the same frame (e.g. after a rule version change,
    // R1.8) overwrites the previous row without raising a uniqueness
    // error. `inserted_at` is populated by the column DEFAULT on every
    // insert/replace, so re-extraction also refreshes the timestamp.
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO extracted_content (
        frame_id,
        frame_timestamp,
        app_name,
        context_label,
        context_key,
        extracted_text,
        extracted_text_hash,
        extraction_rule_kind,
        source_types
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      e.frameId,
      e.frameTimestamp,
      e.appName ?? null,
      e.contextLabel,
      e.contextKey,
      e.extractedText,
      e.extractedTextHash,
      e.extractionRuleKind,
      JSON.stringify(e.sourceTypes)
    );
  }

  async getByFrameIds(ids: number[]): Promise<ExtractionResult[]> {
    // Empty input → empty output, no SQL. SQLite rejects `IN ()` as a
    // parse error and the pipeline frequently passes empty arrays
    // (e.g. session with zero evidence frames during cascade-delete).
    if (ids.length === 0) return [];

    // Deduplicate to keep the result set stable when callers pass the
    // same `frameId` twice (the JOIN against `evidence_frame_ids`
    // upstream may produce duplicates after sessions migration).
    const unique = dedupe(ids);

    const rows: ExtractedContentRow[] = [];
    for (const chunk of chunked(unique, MAX_BIND_PARAMS)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const stmt = this.db.prepare(
        `SELECT
            frame_id,
            frame_timestamp,
            app_name,
            context_label,
            context_key,
            extracted_text,
            extracted_text_hash,
            extraction_rule_kind,
            source_types
         FROM extracted_content
         WHERE frame_id IN (${placeholders})`
      );
      // `node:sqlite` returns rows as null-prototype objects keyed by
      // column name; we re-shape them into `ExtractionResult` below.
      // The double cast through `unknown` is required because the
      // driver's typed return is `Record<string, SQLOutputValue>[]`,
      // which TypeScript correctly refuses to narrow to our row shape
      // implicitly.
      const fetched = stmt.all(...chunk) as unknown as ExtractedContentRow[];
      for (const row of fetched) rows.push(row);
    }

    return rows.map(rowToExtractionResult);
  }

  async deleteByFrameIds(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const unique = dedupe(ids);

    let total = 0;
    for (const chunk of chunked(unique, MAX_BIND_PARAMS)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const stmt = this.db.prepare(
        `DELETE FROM extracted_content WHERE frame_id IN (${placeholders})`
      );
      const result = stmt.run(...chunk);
      // `result.changes` is a `number | bigint` per the node:sqlite
      // typings; coerce to number defensively.
      total += Number(result.changes);
    }
    return total;
  }

  async listByTimeWindow(from: string, to: string): Promise<ExtractionResult[]> {
    const stmt = this.db.prepare(
      `SELECT
          frame_id,
          frame_timestamp,
          app_name,
          context_label,
          context_key,
          extracted_text,
          extracted_text_hash,
          extraction_rule_kind,
          source_types
       FROM extracted_content
       WHERE frame_timestamp BETWEEN ? AND ?
       ORDER BY frame_timestamp ASC`
    );
    const rows = stmt.all(from, to) as unknown as ExtractedContentRow[];
    return rows.map(rowToExtractionResult);
  }

  async countByTimeWindow(
    from: string,
    to: string
  ): Promise<{ total: number; empty: number }> {
    // One round trip: SUM(CASE WHEN extracted_text = '' THEN 1 ELSE 0)
    // gives the empty count alongside the total.
    const stmt = this.db.prepare(
      `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN extracted_text = '' THEN 1 ELSE 0 END), 0) AS empty
       FROM extracted_content
       WHERE frame_timestamp BETWEEN ? AND ?`
    );
    const row = stmt.get(from, to) as
      | { total: number | bigint; empty: number | bigint }
      | undefined;
    if (row === undefined) return { total: 0, empty: 0 };
    return {
      total: Number(row.total),
      empty: Number(row.empty)
    };
  }

  async findLastExtractedAt(): Promise<string | null> {
    // R2.1: Empty_Extraction rows MUST NOT count as a successful
    // extraction — only rows with non-empty `extracted_text` are
    // candidates. The `idx_extracted_content_keyword` partial index
    // (defined in derived-database.ts) makes this lookup cheap.
    const stmt = this.db.prepare(
      `SELECT MAX(frame_timestamp) AS last
       FROM extracted_content
       WHERE extracted_text != ''`
    );
    const row = stmt.get() as { last: string | null } | undefined;
    if (row === undefined || row.last === null) return null;
    return row.last;
  }
}

// ---------------------------------------------------------------------------
// Row → ExtractionResult mapping
// ---------------------------------------------------------------------------

/**
 * Raw shape of a row returned by `node:sqlite` queries against the
 * `extracted_content` table. Columns map 1:1 to the schema; `source_types`
 * is stored as a JSON-encoded string array (per design §1) and parsed
 * here.
 */
interface ExtractedContentRow {
  frame_id: number | bigint;
  frame_timestamp: string;
  app_name: string | null;
  context_label: string;
  context_key: string;
  extracted_text: string;
  extracted_text_hash: string | null;
  extraction_rule_kind: string;
  source_types: string;
}

function rowToExtractionResult(row: ExtractedContentRow): ExtractionResult {
  return {
    frameId: Number(row.frame_id),
    frameTimestamp: row.frame_timestamp,
    // SQL stores `null` for missing appName; the `ExtractionResult`
    // contract uses `undefined` (TypeScript convention), so coerce.
    appName: row.app_name ?? undefined,
    contextLabel: row.context_label,
    contextKey: row.context_key,
    extractedText: row.extracted_text,
    extractedTextHash: row.extracted_text_hash,
    extractionRuleKind: row.extraction_rule_kind as ExtractionRuleKind,
    sourceTypes: parseSourceTypes(row.source_types)
  };
}

/**
 * Defensive `JSON.parse` for the `source_types` column.
 *
 * The column is constrained to JSON-encoded string arrays by the
 * upsert path (see `JSON.stringify(e.sourceTypes)`). If a row with a
 * malformed payload is ever encountered (e.g. a hand-edited database),
 * fall back to an empty array rather than crashing the read path —
 * the rest of the pipeline already treats `sourceTypes` as opaque.
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

// ---------------------------------------------------------------------------
// Generic helpers — kept private to this module
// ---------------------------------------------------------------------------

function dedupe(ids: number[]): number[] {
  return Array.from(new Set(ids));
}

/**
 * Splits `items` into contiguous chunks of at most `size` elements.
 * Yields the original array (wrapped) when it is already small enough.
 */
function* chunked<T>(items: T[], size: number): Generator<T[], void, void> {
  if (items.length <= size) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
