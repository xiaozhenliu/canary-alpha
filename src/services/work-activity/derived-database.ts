import { existsSync, mkdirSync, readFileSync, renameSync as fsRenameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeToUtc } from '../../lib/time.js';
import { float32ArrayToBlob } from '../../lib/blob.js';

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
 * Creates (idempotently) the derived tables and their indexes, then
 * runs any pending schema migrations gated by `PRAGMA user_version`.
 */
export function initDerivedSchema(db: DerivedDatabase): void {
  db.exec(EXTRACTED_CONTENT_DDL);
  db.exec(SESSIONS_DDL);
  db.exec(EMBEDDING_HASH_INDEX_DDL);
  db.exec(VECTORS_DDL);
  migrateDerivedSchemaV1(db);
}

/**
 * Returns the current `PRAGMA user_version` value. Useful for tests
 * and diagnostics.
 */
export function getDerivedSchemaVersion(db: DerivedDatabase): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/**
 * V1 migration: normalize all timestamps in extracted_content and sessions
 * to canonical UTC (Z-suffix). Gated by `PRAGMA user_version < 1`.
 */
function migrateDerivedSchemaV1(db: DerivedDatabase): void {
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version >= 1) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    const ecRows = db.prepare(
      `SELECT frame_id, frame_timestamp FROM extracted_content WHERE frame_timestamp NOT LIKE '%Z'`
    ).all() as Array<{ frame_id: number; frame_timestamp: string }>;
    const ecUpdate = db.prepare('UPDATE extracted_content SET frame_timestamp = ? WHERE frame_id = ?');
    for (const row of ecRows) {
      ecUpdate.run(normalizeToUtc(row.frame_timestamp), row.frame_id);
    }

    const sessRows = db.prepare(
      `SELECT session_id, started_at, ended_at FROM sessions
       WHERE started_at NOT LIKE '%Z' OR ended_at NOT LIKE '%Z'`
    ).all() as Array<{ session_id: string; started_at: string; ended_at: string }>;
    const sessUpdate = db.prepare('UPDATE sessions SET started_at = ?, ended_at = ? WHERE session_id = ?');
    for (const row of sessRows) {
      sessUpdate.run(normalizeToUtc(row.started_at), normalizeToUtc(row.ended_at), row.session_id);
    }

    db.exec('PRAGMA user_version = 1');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
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

const VECTORS_DDL = /* sql */ `
  CREATE TABLE IF NOT EXISTS vectors (
    id              TEXT PRIMARY KEY,
    text            TEXT NOT NULL,
    timestamp       TEXT NOT NULL,
    app_name        TEXT,
    window_name     TEXT,
    embedding       BLOB NOT NULL,
    source_types    TEXT NOT NULL,
    metadata        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_vectors_ts_id
    ON vectors(timestamp, id);

  CREATE INDEX IF NOT EXISTS idx_vectors_app_ts_id
    ON vectors(app_name, timestamp, id);
`;

interface JsonVectorRecord {
  id: string;
  text: string;
  timestamp: string;
  appName?: string;
  windowName?: string;
  embedding?: number[];
  sourceTypes?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * One-time migration from vector-store.json to the SQLite vectors table.
 * Gated by `PRAGMA user_version < 2`. After migration, the JSON file is
 * renamed to `.migrated` as a backup.
 */
export function migrateVectorStoreJsonToSqlite(
  db: DerivedDatabase,
  jsonPath: string,
  logger?: { info: (msg: string, ctx?: Record<string, unknown>) => void }
): void {
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version >= 2) return;
  if (!existsSync(jsonPath)) {
    db.exec('PRAGMA user_version = 2');
    return;
  }

  let records: JsonVectorRecord[];
  try {
    const raw = readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { records?: unknown[] };
    if (!Array.isArray(parsed.records)) {
      db.exec('PRAGMA user_version = 2');
      return;
    }
    records = parsed.records as JsonVectorRecord[];
  } catch {
    db.exec('PRAGMA user_version = 2');
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO vectors (id, text, timestamp, app_name, window_name, embedding, source_types, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let migrated = 0;
    for (const r of records) {
      if (!r.embedding || r.embedding.length === 0) continue;

      let ts = r.timestamp;
      try { ts = normalizeToUtc(r.timestamp); } catch { /* keep original if unparseable */ }

      if (r.metadata?.frameTimestamp && typeof r.metadata.frameTimestamp === 'string') {
        try { r.metadata.frameTimestamp = normalizeToUtc(r.metadata.frameTimestamp as string); } catch { /* keep original */ }
      }

      stmt.run(
        r.id,
        r.text,
        ts,
        r.appName ?? null,
        r.windowName ?? null,
        float32ArrayToBlob(r.embedding),
        JSON.stringify(r.sourceTypes ?? []),
        r.metadata ? JSON.stringify(r.metadata) : null
      );
      migrated++;
    }

    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
    logger?.info('Migrated vector store from JSON to SQLite', { migrated, total: records.length });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  // Rename the JSON file to .migrated as a backup
  try {
    fsRenameSync(jsonPath, `${jsonPath}.migrated`);
  } catch {
    // Non-fatal: the file might be locked or read-only
  }
}
