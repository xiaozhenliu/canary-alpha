/**
 * Read-only adapter for the upstream ScreenPipe `frames` table.
 *
 * Task 8.5 (work-activity-analysis) introduces the `inspect` MCP tool
 * which, when targeting a `frameId`, must return the raw five-column
 * row from `~/.screenpipe/db.sqlite::frames`:
 *
 *   SELECT id, timestamp, app_name, window_name, accessibility_tree_json
 *   FROM frames WHERE id = ?
 *
 * This adapter encapsulates that read so the rest of the work-activity
 * package never touches ScreenPipe's database directly. The interface
 * is minimal (`getFrame`) and never throws on the documented failure
 * modes — design §8.4 / §"Failure modes & degraded paths" call out
 * three cases that must collapse to a `null` result:
 *
 *   1. ScreenPipe `db.sqlite` does not exist (dev machines without
 *      ScreenPipe installed, fresh installs, or after a manual reset).
 *   2. The `frames` table is missing (incompatible ScreenPipe schema
 *      or partially-initialised database).
 *   3. The supplied `frameId` does not exist in the table.
 *
 * In all three cases callers see `Promise<null>` rather than an error,
 * letting the tool layer print a friendly "原始 AX 树不可访问" narrative
 * while still returning the derived `extracted_content` row (if any).
 *
 * Implementation notes:
 *
 *   - We use `node:sqlite` (`DatabaseSync`) directly. The class is
 *     long-lived: callers construct one instance per app and reuse
 *     the same connection across tool calls. The connection is
 *     opened lazily on the first call so a missing file does not
 *     prevent the rest of the app from booting.
 *   - The connection is opened **read-only** (`open: true, readOnly:
 *     true` via `DatabaseSync` constructor flag). We never write back
 *     to ScreenPipe's database — accidental writes to ScreenPipe's
 *     schema would risk corrupting the upstream's WAL/SHM accounting.
 *   - SQLite WAL: ScreenPipe runs in WAL mode. A read-only connection
 *     opened from a separate process sees a WAL snapshot up to the
 *     last `wal_checkpoint`; this is acceptable for `inspect` (a
 *     few-second lag is invisible to the user) and avoids the file
 *     lock contention a write-mode connection would hit.
 */

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { CaptureFrameDetailPort, CaptureFrameRow } from '../../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Re-export the neutral CaptureFrameRow under the legacy name so existing
 * callers that import ScreenpipeFrameRow keep compiling without changes.
 * @deprecated Use CaptureFrameRow from services/capture/types.js instead.
 */
export type { CaptureFrameRow as ScreenpipeFrameRow } from '../../types.js';

/**
 * Deprecated alias for the neutral CaptureFrameDetailPort. New code should
 * depend on CaptureFrameDetailPort directly.
 * @deprecated Use CaptureFrameDetailPort from services/capture/types.js instead.
 */
export type ScreenpipeFramesReader = CaptureFrameDetailPort;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * `node:sqlite`-backed implementation that reads ScreenPipe's
 * `db.sqlite` directly. Connection is opened lazily and cached for
 * the life of the process; tests that need a fresh handle should
 * construct a new instance per case.
 */
export class SqliteScreenpipeFramesReader implements CaptureFrameDetailPort {
  /**
   * Cached connection. `null` means "not yet opened or known to be
   * unavailable"; a non-null value means the connection is live and
   * the `frames` table existed at open time. We do NOT re-open after
   * a failed read — if ScreenPipe's database disappears mid-process,
   * callers see `null` until the process is restarted, matching the
   * coarse-grained recovery model the rest of the trim/observability
   * code uses.
   */
  private cachedDb: DatabaseSync | null = null;

  /**
   * Whether we have already attempted to open the database. Combined
   * with `cachedDb` this tracks the three states:
   *
   *   - `attempted=false, cachedDb=null`  — never opened yet.
   *   - `attempted=true,  cachedDb=null`  — open failed (file missing,
   *                                         schema invalid, ...).
   *   - `attempted=true,  cachedDb=Database` — usable connection.
   *
   * The flag prevents repeated `existsSync` + `new DatabaseSync`
   * thrashing when the file is permanently missing.
   */
  private attempted = false;

  constructor(private readonly screenpipeDbPath: string) {}

  async getFrame(frameId: number | string): Promise<CaptureFrameRow | null> {
    const numericId = coerceFrameId(frameId);
    if (numericId === null) return null;

    const db = this.openDatabaseLazily();
    if (db === null) return null;

    try {
      // Five-column projection per design §8.4. We deliberately do
      // not pull `ocr_text` / `text_json` / etc. — those are out of
      // scope for `inspect({frameId})` and reading them would inflate
      // the response payload.
      const stmt = db.prepare(
        `SELECT id, timestamp, app_name, window_name, accessibility_tree_json
         FROM frames
         WHERE id = ?`
      );
      const row = stmt.get(numericId) as
        | RawScreenpipeFrameRow
        | undefined;
      if (row === undefined) return null;

      return {
        id: Number(row.id),
        timestamp: row.timestamp,
        // Coerce SQL `null` -> JS `undefined` to match the rest of
        // the extraction pipeline's field-shape conventions.
        appName: row.app_name === null ? undefined : row.app_name,
        windowName: row.window_name === null ? undefined : row.window_name,
        accessibilityTreeJson: row.accessibility_tree_json
      };
    } catch {
      // Schema mismatch (e.g. a hypothetical future ScreenPipe drops
      // a column), corrupt page, or any other read-time error —
      // collapse to `null` to keep `inspect` graceful.
      return null;
    }
  }

  /**
   * Opens (or returns the cached) read-only handle to ScreenPipe's
   * database. Returns `null` whenever the database is unavailable —
   * the file is missing, the connection cannot be opened, or the
   * `frames` table does not exist.
   *
   * The method is synchronous because `DatabaseSync` is synchronous;
   * the surrounding `getFrame` is async only to keep the port
   * uniform with the rest of the work-activity adapters.
   */
  private openDatabaseLazily(): DatabaseSync | null {
    if (this.attempted) return this.cachedDb;
    this.attempted = true;

    if (!existsSync(this.screenpipeDbPath)) {
      return null;
    }

    let db: DatabaseSync;
    try {
      // `readOnly` keeps the connection from competing with
      // ScreenPipe's writer — design intent is that this adapter is
      // strictly a reader. The flag is supported in `node:sqlite`
      // v22+. We do NOT enable WAL here (we cannot from a read-only
      // connection anyway) — ScreenPipe's writer keeps the database
      // in WAL mode and our reads see committed snapshots.
      db = new DatabaseSync(this.screenpipeDbPath, { readOnly: true });
    } catch {
      return null;
    }

    // Sanity-check the schema. ScreenPipe versions older than the
    // accessibility-capture-ingestion baseline lack
    // `accessibility_tree_json`; a SELECT against a missing column
    // would throw on every call rather than degrading once. Probe
    // up front so we can permanently mark the connection unusable.
    try {
      db.prepare(
        `SELECT id, timestamp, app_name, window_name, accessibility_tree_json
         FROM frames LIMIT 0`
      ).all();
    } catch {
      // Schema mismatch — close the handle and return `null`. The
      // outer `getFrame` will yield `null` for every subsequent
      // call until the process restarts.
      try {
        db.close();
      } catch {
        /* swallow */
      }
      return null;
    }

    this.cachedDb = db;
    return db;
  }

  /**
   * Closes the cached database handle if one is open. Tests use this
   * to release the file lock between cases when running against an
   * on-disk fixture; production code never calls `close` because the
   * adapter lives for the life of the process.
   */
  close(): void {
    if (this.cachedDb !== null) {
      try {
        this.cachedDb.close();
      } catch {
        /* swallow — best-effort cleanup */
      }
      this.cachedDb = null;
    }
    // Leave `attempted` set to `true` so a subsequent `getFrame`
    // call does not silently re-open. Tests that want a re-open
    // should construct a new reader instance.
  }
}

// ---------------------------------------------------------------------------
// Helpers — kept private to this module
// ---------------------------------------------------------------------------

/**
 * Raw row shape returned by `node:sqlite` for the five-column
 * SELECT. SQLite INTEGER columns can come back as `number | bigint`;
 * we coerce to `number` in {@link SqliteScreenpipeFramesReader.getFrame}.
 */
interface RawScreenpipeFrameRow {
  id: number | bigint;
  timestamp: string;
  app_name: string | null;
  window_name: string | null;
  accessibility_tree_json: string | null;
}

/**
 * Coerces the `frameId` parameter (which the MCP schema accepts as
 * `string | number`) to a finite integer suitable for binding against
 * the `frames.id` INTEGER PRIMARY KEY. Returns `null` for inputs that
 * cannot represent a valid integer (NaN, Infinity, fractional values,
 * non-numeric strings) — the caller then surfaces a uniform "frame
 * not found" narrative.
 */
function coerceFrameId(input: number | string): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isInteger(input)) return null;
    return input;
  }
  // String input: allow optional whitespace, decimal-only, no scientific notation.
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return parsed;
}
