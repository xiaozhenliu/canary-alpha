/**
 * Derived-database adapter for the `sessions` table.
 *
 * Task 4.1 (work-activity-analysis): wraps the SQLite operations the
 * Session_Aggregator, SummaryWorker, observability service, and
 * Cascade_Delete coordinator need against the `derived.sqlite` database
 * initialised by {@link ../derived-database.ts}. The schema is defined in
 * design §1 "Components and Interfaces — 派生存储 schema":
 *
 *   CREATE TABLE sessions (
 *     session_id             TEXT PRIMARY KEY,
 *     app_name               TEXT NOT NULL,
 *     context_key            TEXT NOT NULL,
 *     context_label          TEXT NOT NULL,
 *     started_at             TEXT NOT NULL,
 *     ended_at               TEXT NOT NULL,
 *     active_seconds         INTEGER NOT NULL DEFAULT 0,
 *     source_types           TEXT NOT NULL,           -- JSON array string
 *     evidence_frame_ids     TEXT NOT NULL,           -- JSON array of numbers
 *     is_open                INTEGER NOT NULL DEFAULT 1,
 *     summary_text           TEXT,
 *     summary_status         TEXT,
 *     summary_provider_kind  TEXT,
 *     summary_generated_at   TEXT,
 *     embedding_id           TEXT,
 *     closed_at              TEXT
 *   );
 *
 * The store is a thin synchronous wrapper exposed through `Promise`
 * methods so consumers can compose with the rest of the work-activity
 * pipeline (which is `Promise`-based for symmetry with the embedding
 * provider's network calls). All SQL goes through `node:sqlite`'s
 * `DatabaseSync`, matching the convention used by
 * {@link ../extraction/extracted-content-store.ts} and the rest of the
 * package.
 *
 * Lifetime: callers own the underlying `DerivedDatabase` (open it,
 * `initDerivedSchema`, eventually `close`). The store does not retain
 * any state outside of the database handle.
 *
 * **Validates: Requirements 3.1, 3.2**
 */

import type { DerivedDatabase } from '../derived-database.js';
import type { ExtractionResult } from '../extraction/types.js';
import type { SummaryStatus } from '../summary/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The `summary_status` enum stored on the `sessions` table.
 *
 * Canonical declaration lives in {@link ../summary/types.ts} (task 7.1)
 * — that module is the single source of truth for the five summary
 * types defined in design §6.1. We re-export the type here so existing
 * consumers (notably the session-store unit tests and the observability
 * service) keep a stable import path while the rest of the summary
 * subsystem (provider classes, registry, worker) imports from the
 * summary package directly.
 *
 * The literal values match what the SQL writer stores in the
 * `sessions.summary_status` column (`'pending'` | `'ready'` |
 * `'failed'` | `'degraded'` | `'not_applicable'`). See the canonical
 * definition for the per-state semantics.
 */
export type { SummaryStatus };

/**
 * The provider kind recorded on a generated summary, mirroring
 * `SummaryProvider.kind` in design §6.1. Stored as a plain string column
 * but constrained to this union at the TypeScript boundary.
 */
export type SummaryProviderKind = 'template' | 'remote-llm';

/**
 * In-memory representation of a `sessions` row.
 *
 * Field names use snake_case to match the SQL schema verbatim — the
 * aggregator and observability code already addresses columns by their
 * stored name (see design §4 `canExtend` reads `open.app_name`,
 * `open.context_key`, `open.ended_at`). Keeping the JS shape identical
 * avoids an extra mapping layer.
 *
 * `evidence_frame_ids` is decoded into `number[]` for ergonomics; the
 * raw column stores a JSON-encoded array per design §1. `source_types`
 * stays as a `string[]` for the same reason.
 */
export interface SessionRow {
  session_id: string;
  app_name: string;
  context_key: string;
  context_label: string;
  started_at: string;
  ended_at: string;
  active_seconds: number;
  source_types: string[];
  evidence_frame_ids: number[];
  is_open: boolean;
  summary_text: string | null;
  summary_status: SummaryStatus | null;
  summary_provider_kind: SummaryProviderKind | null;
  summary_generated_at: string | null;
  embedding_id: string | null;
  closed_at: string | null;
}

/**
 * Filter passed to {@link SessionStore.listSessions}. All fields are
 * optional; when a field is omitted the corresponding predicate is not
 * applied.
 *
 *   - `from` / `to` — inclusive bounds matched against `started_at`. The
 *     `recall` tool filters by session start time (design §8.3), so this
 *     is the canonical comparison column for listing sessions in a
 *     window. Open-ended ranges are supported (provide only `from` or
 *     only `to`).
 *   - `appName` — exact-match filter on the `app_name` column. The
 *     stored value is `extraction.appName ?? ''`, so callers wanting
 *     "no app" should pass an empty string.
 *   - `isOpen` — `true` matches `is_open = 1`, `false` matches
 *     `is_open = 0`; omit to include both.
 *   - `limit` / `offset` — standard pagination knobs. Offset without a
 *     limit is allowed but uncommon; the query orders by `started_at`
 *     descending (most recent first) so that callers get the same
 *     ordering as the `recall` tool surfaces.
 */
export interface SessionListFilter {
  from?: string;
  to?: string;
  appName?: string;
  isOpen?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Partial update for the four `summary_*` columns. Any field set to
 * `undefined` is left untouched; explicitly passing `null` clears the
 * column. The split between "leave alone" and "clear" matters because
 * `SummaryWorker` (design §6.5) needs to write `summary_text` + status +
 * provider_kind + generated_at as a single atomic update on success,
 * but separately mark a session as `'failed'` without overwriting the
 * stored text.
 */
export interface SummaryUpdate {
  summaryText?: string | null;
  summaryStatus?: SummaryStatus | null;
  summaryProviderKind?: SummaryProviderKind | null;
  summaryGeneratedAt?: string | null;
}

/**
 * Options governing the {@link SessionStore.appendFrame} call.
 *
 * The `activeSecondsDelta` field is computed by the aggregator (it owns
 * the `idleThresholdSeconds` constant; see design §4 — `canExtend` /
 * Idle_Closure logic). The store stays agnostic of the threshold so that
 * future scheduling tweaks do not have to bleed into the SQL layer.
 *
 * Implementations MUST:
 *
 *   - Append `extraction.frameId` to the `evidence_frame_ids` JSON
 *     array (preserving insertion order — frames arrive in time order).
 *   - Set `ended_at = extraction.frameTimestamp`.
 *   - Increment `active_seconds` by `activeSecondsDelta` (callers pass
 *     a non-negative integer; rounding/clamping is the aggregator's
 *     responsibility).
 */
export interface AppendFrameOptions {
  activeSecondsDelta: number;
}

/**
 * The `SessionStore` interface used by the aggregator, summary worker,
 * observability service, recall tool, and cascade-delete coordinator.
 *
 * The shape is taken from design §4 with one refinement: `appendFrame`
 * receives an explicit `activeSecondsDelta` rather than re-computing it
 * from the row — this keeps the `idleThresholdSeconds` constant inside
 * the aggregator (where the rest of the threshold logic lives) and
 * makes the store deterministic regardless of clock state.
 */
export interface SessionStore {
  // -----------------------------------------------------------------------
  // Aggregator path
  // -----------------------------------------------------------------------
  findOpenSessionFor(
    appName: string | undefined,
    contextKey: string
  ): Promise<SessionRow | null>;
  appendFrame(
    sessionId: string,
    extraction: ExtractionResult,
    options: AppendFrameOptions
  ): Promise<void>;
  createSession(
    init: { session_id: string } & ExtractionResult
  ): Promise<void>;
  closeSession(sessionId: string, closedAt: string): Promise<void>;
  closeOpenSessionsEndedBefore(
    cutoff: string,
    closedAt: string
  ): Promise<number>;

  // -----------------------------------------------------------------------
  // Cascade_Delete (R9)
  // -----------------------------------------------------------------------
  deleteSessionsTouchingFrames(frameIds: number[]): Promise<number>;

  // -----------------------------------------------------------------------
  // Observability (R4 / R8)
  // -----------------------------------------------------------------------
  countOpenSessions(): Promise<number>;
  findLastClosedAt(): Promise<string | null>;
  countSessionsStartedSince(since: string): Promise<number>;
  countSessionsByStatus(status: SummaryStatus): Promise<number>;

  // -----------------------------------------------------------------------
  // Recall / inspect read paths
  // -----------------------------------------------------------------------
  listSessions(filter: SessionListFilter): Promise<SessionRow[]>;
  getSession(sessionId: string): Promise<SessionRow | null>;

  // -----------------------------------------------------------------------
  // Summary write path
  // -----------------------------------------------------------------------
  updateSummary(sessionId: string, update: SummaryUpdate): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Maximum number of `?` placeholders expanded into a single SQL
 * statement. SQLite's older builds cap `SQLITE_MAX_VARIABLE_NUMBER` at
 * 999; we play it safe with a smaller chunk so the store works
 * regardless of which limit applies. Bulk methods split larger inputs
 * into multiple round trips. Mirrors the constant in
 * {@link ../extraction/extracted-content-store.ts}.
 */
const MAX_BIND_PARAMS = 500;

/**
 * Concrete `SessionStore` backed by `node:sqlite` (the synchronous core
 * driver used by the rest of the work-activity package).
 *
 * The class holds a reference to a `DerivedDatabase` instance — the
 * caller owns its lifecycle (open, init schema, close). All read and
 * write methods are synchronous SQL wrapped in `Promise.resolve(...)`
 * to keep the interface async-friendly without paying for `await` on
 * every primitive call.
 */
export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: DerivedDatabase) {}

  // -----------------------------------------------------------------------
  // Aggregator path
  // -----------------------------------------------------------------------

  async findOpenSessionFor(
    appName: string | undefined,
    contextKey: string
  ): Promise<SessionRow | null> {
    // The `app_name` column is `NOT NULL`; the aggregator stores
    // `extraction.appName ?? ''` (see design §4 `canExtend`). Mirror
    // that here so a frame with no `appName` matches an open session
    // that was created with the same null/empty appName.
    const storedAppName = appName ?? '';

    const stmt = this.db.prepare(
      `SELECT
          session_id,
          app_name,
          context_key,
          context_label,
          started_at,
          ended_at,
          active_seconds,
          source_types,
          evidence_frame_ids,
          is_open,
          summary_text,
          summary_status,
          summary_provider_kind,
          summary_generated_at,
          embedding_id,
          closed_at
       FROM sessions
       WHERE app_name = ?
         AND context_key = ?
         AND is_open = 1
       ORDER BY ended_at DESC
       LIMIT 1`
    );
    const row = stmt.get(storedAppName, contextKey) as
      | SessionRowRaw
      | undefined;
    return row === undefined ? null : rawToSessionRow(row);
  }

  async appendFrame(
    sessionId: string,
    extraction: ExtractionResult,
    options: AppendFrameOptions
  ): Promise<void> {
    // Read the current `evidence_frame_ids` and `active_seconds` so
    // we can compute the new payload in a single UPDATE. Using
    // `json_insert` would let SQLite handle the array append, but we
    // already need to read `active_seconds` (and validate the row
    // exists), so the round-trip cost is the same and the JS code
    // stays portable to non-JSON1 builds of SQLite.
    const selectStmt = this.db.prepare(
      `SELECT evidence_frame_ids, active_seconds
       FROM sessions
       WHERE session_id = ?`
    );
    const current = selectStmt.get(sessionId) as
      | { evidence_frame_ids: string; active_seconds: number | bigint }
      | undefined;
    if (current === undefined) {
      throw new Error(
        `SessionStore.appendFrame: session ${sessionId} does not exist`
      );
    }

    const ids = parseFrameIds(current.evidence_frame_ids);
    ids.push(extraction.frameId);

    const updateStmt = this.db.prepare(
      `UPDATE sessions
         SET ended_at = ?,
             active_seconds = ?,
             evidence_frame_ids = ?
       WHERE session_id = ?`
    );
    updateStmt.run(
      extraction.frameTimestamp,
      Number(current.active_seconds) + options.activeSecondsDelta,
      JSON.stringify(ids),
      sessionId
    );
  }

  async createSession(
    init: { session_id: string } & ExtractionResult
  ): Promise<void> {
    // Per design §4 the new session opens at `extraction.frameTimestamp`
    // with `active_seconds = 0` and a one-element `evidence_frame_ids`
    // array; `is_open` defaults to 1 by the column DEFAULT but is set
    // explicitly here for readability.
    const stmt = this.db.prepare(
      `INSERT INTO sessions (
        session_id,
        app_name,
        context_key,
        context_label,
        started_at,
        ended_at,
        active_seconds,
        source_types,
        evidence_frame_ids,
        is_open
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1)`
    );
    stmt.run(
      init.session_id,
      init.appName ?? '',
      init.contextKey,
      init.contextLabel,
      init.frameTimestamp,
      init.frameTimestamp,
      JSON.stringify(init.sourceTypes),
      JSON.stringify([init.frameId])
    );
  }

  async closeSession(sessionId: string, closedAt: string): Promise<void> {
    const stmt = this.db.prepare(
      `UPDATE sessions
         SET is_open = 0,
             closed_at = ?
       WHERE session_id = ?
         AND is_open = 1`
    );
    stmt.run(closedAt, sessionId);
  }

  async closeOpenSessionsEndedBefore(
    cutoff: string,
    closedAt: string
  ): Promise<number> {
    // Strict `<` so a session with `ended_at == cutoff` is NOT closed.
    // The aggregator computes `cutoff = now - idleThreshold`, so the
    // semantics are "any open session whose last frame is older than
    // the threshold gets closed".
    const stmt = this.db.prepare(
      `UPDATE sessions
         SET is_open = 0,
             closed_at = ?
       WHERE is_open = 1
         AND ended_at < ?`
    );
    const result = stmt.run(closedAt, cutoff);
    return Number(result.changes);
  }

  // -----------------------------------------------------------------------
  // Cascade_Delete (R9 — design §11)
  // -----------------------------------------------------------------------

  async deleteSessionsTouchingFrames(frameIds: number[]): Promise<number> {
    // Empty input → no SQL. SQLite would reject `IN ()` as a parse
    // error, and the cascade coordinator frequently calls this with
    // an empty array during dry runs.
    if (frameIds.length === 0) return 0;

    const unique = Array.from(new Set(frameIds));
    let total = 0;
    // Chunk the IN list so we never blow past `MAX_BIND_PARAMS`. Each
    // chunk runs an EXISTS-against-json_each subquery: for every row
    // in `sessions`, walk its decoded `evidence_frame_ids` array and
    // check whether any element is a member of the chunk's set. The
    // partial index on `evidence_frame_ids` is not feasible (JSON
    // payload column), so the query is a full table scan — acceptable
    // because cascade-delete is a low-frequency path (R9.2) and the
    // session table stays in the hundreds-of-rows-per-day regime.
    for (const chunk of chunked(unique, MAX_BIND_PARAMS)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const stmt = this.db.prepare(
        `DELETE FROM sessions
         WHERE EXISTS (
           SELECT 1
           FROM json_each(sessions.evidence_frame_ids) je
           WHERE je.value IN (${placeholders})
         )`
      );
      const result = stmt.run(...chunk);
      total += Number(result.changes);
    }
    return total;
  }

  // -----------------------------------------------------------------------
  // Observability (R4 / R8)
  // -----------------------------------------------------------------------

  async countOpenSessions(): Promise<number> {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) AS c FROM sessions WHERE is_open = 1`
    );
    const row = stmt.get() as { c: number | bigint } | undefined;
    return row === undefined ? 0 : Number(row.c);
  }

  async findLastClosedAt(): Promise<string | null> {
    // Closed sessions populate `closed_at`; pull the most recent so
    // observability can answer "when did the indexer last advance a
    // session boundary".
    const stmt = this.db.prepare(
      `SELECT MAX(closed_at) AS last
       FROM sessions
       WHERE is_open = 0
         AND closed_at IS NOT NULL`
    );
    const row = stmt.get() as { last: string | null } | undefined;
    if (row === undefined || row.last === null) return null;
    return row.last;
  }

  async countSessionsStartedSince(since: string): Promise<number> {
    // `>=` matches "rolling 24h window" semantics where `since = now -
    // 86400s`. Callers that want a strict-greater-than predicate can
    // bump the timestamp by one millisecond on their side.
    // datetime() normalizes both sides to UTC: stored `started_at` carries a
    // local offset while `since` is a UTC instant, so a raw string compare
    // would under/over-count across the timezone-representation boundary.
    const stmt = this.db.prepare(
      `SELECT COUNT(*) AS c FROM sessions WHERE datetime(started_at) >= datetime(?)`
    );
    const row = stmt.get(since) as { c: number | bigint } | undefined;
    return row === undefined ? 0 : Number(row.c);
  }

  async countSessionsByStatus(status: SummaryStatus): Promise<number> {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) AS c FROM sessions WHERE summary_status = ?`
    );
    const row = stmt.get(status) as { c: number | bigint } | undefined;
    return row === undefined ? 0 : Number(row.c);
  }

  // -----------------------------------------------------------------------
  // Recall / inspect read paths
  // -----------------------------------------------------------------------

  async listSessions(filter: SessionListFilter): Promise<SessionRow[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filter.from !== undefined) {
      // Normalize both sides to UTC via datetime() before comparing. Stored
      // `started_at` carries a local offset (e.g. `+08:00`) while callers
      // (recall tool / agents) pass UTC `Z` bounds; a raw string `>=`/`<=`
      // compares them lexicographically and silently drops in-window rows
      // whenever the two representations differ. datetime() collapses both to
      // canonical UTC so the comparison is chronological. Cost: the
      // `started_at` index is bypassed (acceptable at local-first scale).
      where.push('datetime(started_at) >= datetime(?)');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push('datetime(started_at) <= datetime(?)');
      params.push(filter.to);
    }
    if (filter.appName !== undefined) {
      where.push('app_name = ?');
      params.push(filter.appName);
    }
    if (filter.isOpen !== undefined) {
      where.push('is_open = ?');
      params.push(filter.isOpen ? 1 : 0);
    }

    const whereSql = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
    // `recall(granularity='session')` returns most recent first
    // (design §8.3); offering a single canonical order keeps the
    // tool semantics simple and the `started_at DESC` index is the
    // natural choice given the `idx_sessions_started_at` index.
    const orderSql = 'ORDER BY started_at DESC';
    // SQLite requires `OFFSET` to follow a `LIMIT` clause; emitting
    // `OFFSET n` on its own is a syntax error. When the caller asks
    // for `offset` without `limit`, fall back to `LIMIT -1` (SQLite's
    // sentinel for "unbounded") so the offset pagination still works.
    const hasLimit = filter.limit !== undefined;
    const hasOffset = filter.offset !== undefined;
    const limitValue = hasLimit ? Math.max(0, filter.limit! | 0) : -1;
    const offsetValue = hasOffset ? Math.max(0, filter.offset! | 0) : 0;
    const paginationSql =
      hasLimit || hasOffset
        ? `LIMIT ${limitValue} OFFSET ${offsetValue}`
        : '';

    const stmt = this.db.prepare(
      `SELECT
          session_id,
          app_name,
          context_key,
          context_label,
          started_at,
          ended_at,
          active_seconds,
          source_types,
          evidence_frame_ids,
          is_open,
          summary_text,
          summary_status,
          summary_provider_kind,
          summary_generated_at,
          embedding_id,
          closed_at
       FROM sessions
       ${whereSql}
       ${orderSql}
       ${paginationSql}`.trim()
    );
    const rows = stmt.all(...params) as unknown as SessionRowRaw[];
    return rows.map(rawToSessionRow);
  }

  async getSession(sessionId: string): Promise<SessionRow | null> {
    const stmt = this.db.prepare(
      `SELECT
          session_id,
          app_name,
          context_key,
          context_label,
          started_at,
          ended_at,
          active_seconds,
          source_types,
          evidence_frame_ids,
          is_open,
          summary_text,
          summary_status,
          summary_provider_kind,
          summary_generated_at,
          embedding_id,
          closed_at
       FROM sessions
       WHERE session_id = ?`
    );
    const row = stmt.get(sessionId) as SessionRowRaw | undefined;
    return row === undefined ? null : rawToSessionRow(row);
  }

  // -----------------------------------------------------------------------
  // Summary write path
  // -----------------------------------------------------------------------

  async updateSummary(
    sessionId: string,
    update: SummaryUpdate
  ): Promise<void> {
    // Build a partial UPDATE: only touch the columns the caller
    // mentions (using `undefined` for "leave alone"), so the worker
    // can write `failed` without clobbering an earlier `summary_text`
    // and observability can still surface the last-known text on a
    // degraded session (design §6.5).
    const sets: string[] = [];
    const params: (string | null)[] = [];

    if (update.summaryText !== undefined) {
      sets.push('summary_text = ?');
      params.push(update.summaryText);
    }
    if (update.summaryStatus !== undefined) {
      sets.push('summary_status = ?');
      params.push(update.summaryStatus);
    }
    if (update.summaryProviderKind !== undefined) {
      sets.push('summary_provider_kind = ?');
      params.push(update.summaryProviderKind);
    }
    if (update.summaryGeneratedAt !== undefined) {
      sets.push('summary_generated_at = ?');
      params.push(update.summaryGeneratedAt);
    }

    if (sets.length === 0) return;

    const stmt = this.db.prepare(
      `UPDATE sessions SET ${sets.join(', ')} WHERE session_id = ?`
    );
    stmt.run(...params, sessionId);
  }
}

// ---------------------------------------------------------------------------
// Row → SessionRow mapping
// ---------------------------------------------------------------------------

/**
 * Raw shape of a `sessions` row returned by `node:sqlite`. The driver
 * surfaces TEXT columns as strings, INTEGER as `number | bigint`, and
 * NULL as `null`. We re-shape into {@link SessionRow} here so callers
 * see the documented field types.
 */
interface SessionRowRaw {
  session_id: string;
  app_name: string;
  context_key: string;
  context_label: string;
  started_at: string;
  ended_at: string;
  active_seconds: number | bigint;
  source_types: string;
  evidence_frame_ids: string;
  is_open: number | bigint;
  summary_text: string | null;
  summary_status: string | null;
  summary_provider_kind: string | null;
  summary_generated_at: string | null;
  embedding_id: string | null;
  closed_at: string | null;
}

function rawToSessionRow(raw: SessionRowRaw): SessionRow {
  return {
    session_id: raw.session_id,
    app_name: raw.app_name,
    context_key: raw.context_key,
    context_label: raw.context_label,
    started_at: raw.started_at,
    ended_at: raw.ended_at,
    active_seconds: Number(raw.active_seconds),
    source_types: parseStringArray(raw.source_types),
    evidence_frame_ids: parseFrameIds(raw.evidence_frame_ids),
    is_open: Number(raw.is_open) === 1,
    summary_text: raw.summary_text,
    summary_status: coerceSummaryStatus(raw.summary_status),
    summary_provider_kind: coerceSummaryProviderKind(raw.summary_provider_kind),
    summary_generated_at: raw.summary_generated_at,
    embedding_id: raw.embedding_id,
    closed_at: raw.closed_at
  };
}

/**
 * Set of valid `SummaryStatus` literals (mirrors the type union). Used
 * by the row mapper to refuse anything stored in `summary_status` that
 * is not a known value — a hand-edited database, a future migration
 * that has not yet shipped, or a bug in a writer would otherwise leak
 * invalid status strings into observability counts and tool output.
 */
const VALID_SUMMARY_STATUSES: ReadonlySet<SummaryStatus> = new Set<SummaryStatus>([
  'pending',
  'ready',
  'failed',
  'degraded',
  'not_applicable'
]);

const VALID_SUMMARY_PROVIDER_KINDS: ReadonlySet<SummaryProviderKind> =
  new Set<SummaryProviderKind>(['template', 'remote-llm']);

/**
 * Narrows the raw `summary_status` column value to the documented
 * `SummaryStatus` union. Unknown values collapse to `null` rather
 * than being silently surfaced as if they were valid — downstream
 * counters (`countSessionsByStatus`) already treat unknown statuses
 * as "no match", so this keeps the contract honest.
 */
function coerceSummaryStatus(raw: string | null): SummaryStatus | null {
  if (raw === null) return null;
  return VALID_SUMMARY_STATUSES.has(raw as SummaryStatus)
    ? (raw as SummaryStatus)
    : null;
}

function coerceSummaryProviderKind(
  raw: string | null
): SummaryProviderKind | null {
  if (raw === null) return null;
  return VALID_SUMMARY_PROVIDER_KINDS.has(raw as SummaryProviderKind)
    ? (raw as SummaryProviderKind)
    : null;
}

/**
 * Defensive `JSON.parse` for the `evidence_frame_ids` column.
 *
 * The column is constrained to JSON-encoded number arrays by the
 * `createSession` / `appendFrame` paths. If a row with a malformed
 * payload is ever encountered (hand-edited database, future schema
 * change), fall back to an empty array rather than crashing the read
 * path — Cascade_Delete will eventually GC the orphaned row.
 */
function parseFrameIds(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => (typeof v === 'number' ? v : Number(v)))
        .filter((v) => Number.isFinite(v));
    }
  } catch {
    /* fall through */
  }
  return [];
}

function parseStringArray(raw: string): string[] {
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

function* chunked<T>(items: T[], size: number): Generator<T[], void, void> {
  if (items.length <= size) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
