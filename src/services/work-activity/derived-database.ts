import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export { resolveDerivedDatabasePath } from '../../config/paths.js';
export type DerivedDatabase = DatabaseSync;

/**
 * Opens (and creates if missing) the derived SQLite database at the given
 * filesystem path. Parent directories are created on demand. Use the special
 * literal `':memory:'` for transient in-memory databases (used by tests and
 * the CI evaluation harness).
 *
 * The database is opened with the `node:sqlite` synchronous driver, which is
 * shipped as a stable Node.js core module (Node 24+). The function is
 * intentionally narrow: it does not init the schema – call
 * {@link initDerivedSchema} afterwards.
 */
export function openDerivedDatabase(path: string): DerivedDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);

  // WAL improves concurrent read throughput against ScreenPipe-style ingest
  // patterns. Skipped for in-memory databases where it is not applicable.
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');

  return db;
}

/**
 * Bulk delete entry point used by the Cascade_Delete coordinator
 * (R9.1) to drop both `sessions` rows and `extracted_content` rows
 * atomically. Both deletes run inside a single `BEGIN IMMEDIATE` /
 * `COMMIT` transaction so a mid-cascade failure (e.g. the second
 * delete crashes) leaves the derived database fully unchanged
 * rather than dropping `sessions` while leaving orphan
 * `extracted_content` rows (or vice versa).
 *
 * The vector store deletion is intentionally OUTSIDE this
 * transaction — the vector backend is a separate storage engine
 * with its own consistency boundary, and we want to delete
 * vectors only after the SQL commit succeeds. The coordinator
 * (`cascade-delete-coordinator.ts`) sequences the two phases.
 *
 * The derived database location is intentionally separate from
 * ScreenPipe's own `db.sqlite` (see design §1) so that manual
 * `sqlite3` interactions on ScreenPipe's database do not
 * accidentally drop derived tables.
 */
export function deleteDerivedByFrameIds(
  db: DerivedDatabase,
  frameIds: number[]
): { extractedContent: number; sessions: number } {
  if (frameIds.length === 0) {
    return { extractedContent: 0, sessions: 0 };
  }

  const unique = Array.from(new Set(frameIds));

  // `BEGIN IMMEDIATE` acquires a RESERVED lock up front so a
  // concurrent writer cannot land between the sessions delete and
  // the extracted_content delete. `node:sqlite` does not expose a
  // first-class `Database.prototype.transaction` API the way
  // better-sqlite3 does, so we drive the transaction with raw SQL
  // — same effect, just less syntactic sugar.
  db.exec('BEGIN IMMEDIATE');
  try {
    let sessionsDeleted = 0;
    let extractedDeleted = 0;
    for (const chunk of chunked(unique, MAX_BIND_PARAMS)) {
      const placeholders = chunk.map(() => '?').join(', ');
      // Sessions first — removing the session row before the
      // per-frame extraction matches the original cascade order
      // (sessions → extracted_content → vector store).
      const sessionsResult = db
        .prepare(
          `DELETE FROM sessions
           WHERE EXISTS (
             SELECT 1
             FROM json_each(sessions.evidence_frame_ids) je
             WHERE je.value IN (${placeholders})
           )`
        )
        .run(...chunk);
      sessionsDeleted += Number(sessionsResult.changes);

      const extractedResult = db
        .prepare(`DELETE FROM extracted_content WHERE frame_id IN (${placeholders})`)
        .run(...chunk);
      extractedDeleted += Number(extractedResult.changes);
    }
    db.exec('COMMIT');
    return { extractedContent: extractedDeleted, sessions: sessionsDeleted };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function* chunked<T>(items: T[], size: number): Generator<T[], void, void> {
  if (items.length <= size) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

/**
 * Maximum number of `?` placeholders expanded into a single SQL
 * statement; matches the constants used by the individual stores.
 */
const MAX_BIND_PARAMS = 500;

/**
 * Creates (idempotently) the three derived tables and their indexes.
 *
 * Schema definitions are taken verbatim from the work-activity-analysis
 * design document, §1 "Components and Interfaces":
 *
 *   - `extracted_content`: per-frame extraction result (R1).
 *   - `sessions`: continuous work units (R3).
 *   - `embedding_hash_index`: SHA256 → embedding cache (R5).
 *
 * The function uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT
 * EXISTS`, so calling it on an already-initialized database is a no-op.
 */
export function initDerivedSchema(db: DerivedDatabase): void {
  db.exec(EXTRACTED_CONTENT_DDL);
  db.exec(SESSIONS_DDL);
  db.exec(EMBEDDING_HASH_INDEX_DDL);
}

const EXTRACTED_CONTENT_DDL = /* sql */ `
  CREATE TABLE IF NOT EXISTS extracted_content (
    frame_id              INTEGER PRIMARY KEY,
    frame_timestamp       TEXT NOT NULL,
    app_name              TEXT,
    context_label         TEXT NOT NULL,
    context_key           TEXT NOT NULL,
    extracted_text        TEXT NOT NULL,
    extracted_text_hash   TEXT,
    extraction_rule_kind  TEXT NOT NULL,
    source_types          TEXT NOT NULL,
    inserted_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_extracted_content_timestamp
    ON extracted_content(frame_timestamp);

  CREATE INDEX IF NOT EXISTS idx_extracted_content_app_ts
    ON extracted_content(app_name, frame_timestamp);

  CREATE INDEX IF NOT EXISTS idx_extracted_content_hash
    ON extracted_content(extracted_text_hash)
    WHERE extracted_text_hash IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_extracted_content_keyword
    ON extracted_content(extracted_text)
    WHERE extracted_text != '';
`;

const SESSIONS_DDL = /* sql */ `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id             TEXT PRIMARY KEY,
    app_name               TEXT NOT NULL,
    context_key            TEXT NOT NULL,
    context_label          TEXT NOT NULL,
    started_at             TEXT NOT NULL,
    ended_at               TEXT NOT NULL,
    active_seconds         INTEGER NOT NULL DEFAULT 0,
    source_types           TEXT NOT NULL,
    evidence_frame_ids     TEXT NOT NULL,
    is_open                INTEGER NOT NULL DEFAULT 1,
    summary_text           TEXT,
    summary_status         TEXT,
    summary_provider_kind  TEXT,
    summary_generated_at   TEXT,
    embedding_id           TEXT,
    closed_at              TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_started_at
    ON sessions(started_at);

  CREATE INDEX IF NOT EXISTS idx_sessions_ended_at
    ON sessions(ended_at);

  CREATE INDEX IF NOT EXISTS idx_sessions_open
    ON sessions(is_open) WHERE is_open = 1;

  CREATE INDEX IF NOT EXISTS idx_sessions_app_started
    ON sessions(app_name, started_at);
`;

const EMBEDDING_HASH_INDEX_DDL = /* sql */ `
  CREATE TABLE IF NOT EXISTS embedding_hash_index (
    extracted_text_hash  TEXT PRIMARY KEY,
    embedding            BLOB NOT NULL,
    inserted_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`;
