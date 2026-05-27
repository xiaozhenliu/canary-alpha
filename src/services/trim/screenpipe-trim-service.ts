import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import type { ScreenpipeTrimResult, Logger } from '../../types/app-config.js';
import type { CascadeDeleteCoordinator } from '../work-activity/cascade-delete-coordinator.js';
import type { PrivacyStore } from '../privacy/types.js';

const execFileAsync = promisify(execFile);
const SQLITE3_BINARY = 'sqlite3';
const TRIM_BATCH_SIZE = 100;
const TRIM_BATCH_TIMEOUT_MS = 10_000;
const TRIM_NULL_TIMEOUT_MS = 30_000;
const RETENTION_BATCH_SIZE = 100;
/**
 * Maximum `?` placeholders used when emitting a parameterised
 * `IN (?, ?, ...)` for the deterministic id-list delete. SQLite's
 * default `SQLITE_MAX_VARIABLE_NUMBER` is 999, so we play safe at
 * 500 — same convention used by the derived-database stores.
 */
const RETENTION_DELETE_CHUNK = 500;

export interface RetentionResult {
  framesDeleted: number;
  elementsDeleted: number;
  reachedFloor: boolean;
}

export interface TrimOptions {
  budgetBytes?: number | null;
  retentionDays?: number;
  /** Optional cascade coordinator; when provided, derived data is cleaned up after each retention batch. */
  cascadeDeleteCoordinator?: CascadeDeleteCoordinator;
  /**
   * Optional privacy store used to persist a `cascade-failure`
   * tombstone when the retention cascade throws. The tombstone is
   * the same shape as the one written by privacy `delete-range`:
   * `find` / `recall` filter against unresolved cascade-failure
   * rows so orphaned derived data does not surface to the user.
   * Without this hook, cascade failures are still logged but the
   * retrieval-side gate cannot kick in.
   */
  privacyStore?: PrivacyStore;
  /**
   * Optional logger; when provided, cascade failures are emitted
   * as `warn` log entries with the failed frame-id count and the
   * underlying error message.
   */
  logger?: Logger;
  /**
   * Optional clock for deterministic tombstone `createdAt`. Defaults
   * to `() => new Date()`.
   */
  now?: () => Date;
}

const ENSURE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_frames_content_hash ON frames(content_hash) WHERE content_hash IS NOT NULL;`;

const DUPLICATE_FRAME_IDS_SQL = `
SELECT id FROM frames
WHERE content_hash IS NOT NULL
  AND id NOT IN (SELECT MIN(id) FROM frames WHERE content_hash IS NOT NULL GROUP BY content_hash)
LIMIT ${TRIM_BATCH_SIZE};`.trim();

function buildBatchDeleteSql(batchSize: number): string {
  return `
DELETE FROM elements WHERE frame_id IN (
  SELECT id FROM frames
  WHERE content_hash IS NOT NULL
    AND id NOT IN (SELECT MIN(id) FROM frames WHERE content_hash IS NOT NULL GROUP BY content_hash)
  LIMIT ${batchSize}
);
SELECT changes();
DELETE FROM frames WHERE id IN (
  SELECT id FROM frames
  WHERE content_hash IS NOT NULL
    AND id NOT IN (SELECT MIN(id) FROM frames WHERE content_hash IS NOT NULL GROUP BY content_hash)
  LIMIT ${batchSize}
);
SELECT changes();`.trim();
}

const NULL_JSON_SQL = `
UPDATE frames SET accessibility_tree_json = NULL
WHERE accessibility_tree_json IS NOT NULL
  AND EXISTS (SELECT 1 FROM elements WHERE elements.frame_id = frames.id);
SELECT changes();`.trim();

async function countDuplicates(databasePath: string): Promise<number> {
  const { stdout } = await execFileAsync(SQLITE3_BINARY, [databasePath, DUPLICATE_FRAME_IDS_SQL], {
    timeout: TRIM_BATCH_TIMEOUT_MS
  });
  return stdout.trim() ? stdout.trim().split('\n').length : 0;
}

// ---------------------------------------------------------------------------
// Retention helpers
// ---------------------------------------------------------------------------

async function statBytes(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath);
    return s.size;
  } catch {
    return 0;
  }
}

function retentionFloorIso(retentionDays: number): string {
  const floor = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1_000);
  return floor.toISOString();
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [];
  if (items.length <= size) return [Array.from(items)];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size) as T[]);
  }
  return out;
}

/**
 * Pick the next batch of frame ids eligible for retention deletion
 * AND remove exactly those rows in one transaction.
 *
 * Previous implementation used a SELECT to pick the ids and a
 * second `DELETE ... WHERE id IN (SELECT ... ORDER BY ts ASC LIMIT N)`
 * to remove them. Under tied timestamps or concurrent writers the
 * second query could resolve to a different set of ids — leading
 * to inconsistent counts and, worse, the wrong frame ids being
 * passed to the cascade coordinator.
 *
 * The new shape:
 *
 *   1. SELECT the candidate ids (same query).
 *   2. Run the DELETE statements with a parameterised
 *      `IN (?, ?, ...)` list of those exact ids — no second
 *      SELECT, no possibility of drift. The id list is chunked
 *      to stay below SQLite's `SQLITE_MAX_VARIABLE_NUMBER`.
 *   3. Both deletes (elements + frames) plus the chunked frame
 *      deletes run inside a single `BEGIN IMMEDIATE` / `COMMIT`
 *      transaction so a mid-loop failure leaves the upstream
 *      database unchanged. SQLite's `changes()` is read off each
 *      `RunResult` to confirm the actual deletion count.
 *
 * The function uses the in-process `node:sqlite` driver instead
 * of shelling out to the CLI; this matches the upgrade made to
 * `privacy-control-service.ts` and avoids the string-interpolated
 * SQL the CLI path relied on.
 */
async function deleteOldestBatch(
  databasePath: string,
  retentionDays: number,
  batchSize: number
): Promise<{
  framesDeleted: number;
  elementsDeleted: number;
  deletedFrameIds: number[];
  oldestDeletedTimestamp: string | null;
  newestDeletedTimestamp: string | null;
}> {
  if (!existsSync(databasePath)) {
    return {
      framesDeleted: 0,
      elementsDeleted: 0,
      deletedFrameIds: [],
      oldestDeletedTimestamp: null,
      newestDeletedTimestamp: null
    };
  }
  const floorIso = retentionFloorIso(retentionDays);

  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');

    // Step 1: select the eligible ids with the same `ORDER BY
    // timestamp ASC LIMIT N` predicate as before. We use
    // `datetime(timestamp) < datetime(?)` so the comparison matches
    // the privacy delete-range fix (P0-1) — naive lexicographic
    // string ordering misclassifies `+HH:MM`-offset timestamps near
    // the retention floor.
    const selectStmt = db.prepare(
      `SELECT id, timestamp FROM frames
       WHERE datetime(timestamp) < datetime(?)
       ORDER BY datetime(timestamp) ASC
       LIMIT ?`
    );
    const rows = selectStmt.all(floorIso, batchSize) as Array<{
      id: number | bigint;
      timestamp: string;
    }>;
    const deletedFrameIds = rows.map((row) => Number(row.id));
    if (deletedFrameIds.length === 0) {
      return {
        framesDeleted: 0,
        elementsDeleted: 0,
        deletedFrameIds: [],
        oldestDeletedTimestamp: null,
        newestDeletedTimestamp: null
      };
    }
    // Capture the timestamp envelope of the rows we are about to
    // remove. The retention loop hands these over to the privacy
    // tombstone writer so a cascade failure can persist a
    // suppression range that actually covers the deleted frames'
    // timestamps (rather than the unrelated "retained" window).
    const oldestDeletedTimestamp = rows[0]?.timestamp ?? null;
    const newestDeletedTimestamp = rows[rows.length - 1]?.timestamp ?? null;

    // Step 2: delete by exact id list inside a transaction so the
    // counts and the returned id set are always consistent. We use
    // SQLite's `RETURNING id` clause (SQLite 3.35+) on the frame
    // delete so the rows we report as "deleted" are exactly the
    // rows the SQL engine actually removed in this transaction —
    // including the case where a concurrent writer pruned a row
    // between our SELECT and our DELETE. Without `RETURNING` the
    // post-hoc "survivor" re-query cannot distinguish "we deleted
    // it" from "someone else deleted it before we got there".
    db.exec('BEGIN IMMEDIATE');
    let framesDeleted = 0;
    let elementsDeleted = 0;
    const actuallyDeletedIds: number[] = [];
    try {
      for (const chunk of chunked(deletedFrameIds, RETENTION_DELETE_CHUNK)) {
        const placeholders = chunk.map(() => '?').join(', ');
        const elementsResult = db
          .prepare(`DELETE FROM elements WHERE frame_id IN (${placeholders})`)
          .run(...chunk);
        const framesRows = db
          .prepare(`DELETE FROM frames WHERE id IN (${placeholders}) RETURNING id`)
          .all(...chunk) as Array<{ id: number | bigint }>;
        elementsDeleted += Number(elementsResult.changes);
        framesDeleted += framesRows.length;
        for (const row of framesRows) actuallyDeletedIds.push(Number(row.id));
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    // Build the returned envelope from the rows that
    // `RETURNING id` confirmed we actually removed. Only those ids
    // (and their timestamps) flow into the cascade coordinator and
    // the tombstone writer, so a concurrent writer racing us
    // cannot poison either downstream consumer.
    if (actuallyDeletedIds.length === deletedFrameIds.length) {
      return {
        framesDeleted,
        elementsDeleted,
        deletedFrameIds: actuallyDeletedIds,
        oldestDeletedTimestamp,
        newestDeletedTimestamp
      };
    }
    const actuallyDeletedSet = new Set(actuallyDeletedIds);
    const filteredTimestamps = rows
      .filter((row) => actuallyDeletedSet.has(Number(row.id)))
      .map((row) => row.timestamp);
    return {
      framesDeleted,
      elementsDeleted,
      deletedFrameIds: actuallyDeletedIds,
      oldestDeletedTimestamp: filteredTimestamps[0] ?? null,
      newestDeletedTimestamp: filteredTimestamps[filteredTimestamps.length - 1] ?? null
    };
  } finally {
    db.close();
  }
}

async function hasRowsOlderThanRetentionFloor(
  databasePath: string,
  retentionDays: number
): Promise<boolean> {
  if (!existsSync(databasePath)) return false;
  const floorIso = retentionFloorIso(retentionDays);
  const db = new DatabaseSync(databasePath);
  try {
    const row = db
      .prepare(`SELECT 1 AS one FROM frames WHERE datetime(timestamp) < datetime(?) LIMIT 1`)
      .get(floorIso) as { one: number } | undefined;
    return row !== undefined;
  } finally {
    db.close();
  }
}

/**
 * Retention pass: if db.sqlite exceeds budgetBytes, delete oldest frames (by
 * timestamp ascending) in batches until the budget is met or no rows older
 * than the retention floor remain.
 *
 * Returns immediately (no-op) when budgetBytes is null.
 *
 * When `cascadeDeleteCoordinator` is provided, derived data (sessions,
 * extracted_content, embeddings) is cleaned up after each batch deletion
 * so the derived layer stays consistent with the upstream frames table (R9.1).
 *
 * The cascade is invoked with the EXACT set of frame ids that
 * `deleteOldestBatch` confirmed it removed (verified via SQLite's
 * `changes()` count + a re-query when counts diverge), so the derived
 * cleanup never references frames that were not actually deleted.
 *
 * Cascade failures are no longer silently swallowed (matches the
 * privacy delete-range behaviour). When `privacyStore` is wired in,
 * a `cascade-failure` suppressed range covering the affected frame
 * window is appended to the privacy state so retrieval tools (`find`,
 * `recall`) skip those rows until reconciliation. The failure is also
 * logged at `warn` level when `logger` is provided.
 */
export async function runRetentionIfOverBudget(
  databasePath: string,
  budgetBytes: number | null,
  retentionDays: number,
  cascadeDeleteCoordinator?: CascadeDeleteCoordinator,
  options: { privacyStore?: PrivacyStore; logger?: Logger; now?: () => Date } = {}
): Promise<RetentionResult> {
  if (budgetBytes === null) {
    return { framesDeleted: 0, elementsDeleted: 0, reachedFloor: false };
  }

  let totalFramesDeleted = 0;
  let totalElementsDeleted = 0;

  try {
    while (true) {
      const size = await statBytes(databasePath);
      if (size <= budgetBytes) {
        return { framesDeleted: totalFramesDeleted, elementsDeleted: totalElementsDeleted, reachedFloor: false };
      }

      const hasOlder = await hasRowsOlderThanRetentionFloor(databasePath, retentionDays);
      if (!hasOlder) {
        return { framesDeleted: totalFramesDeleted, elementsDeleted: totalElementsDeleted, reachedFloor: true };
      }

      const batchResult = await deleteOldestBatch(databasePath, retentionDays, RETENTION_BATCH_SIZE);
      totalFramesDeleted += batchResult.framesDeleted;
      totalElementsDeleted += batchResult.elementsDeleted;

      // Cascade derived data deletion after each batch (R9.1).
      // Failures are surfaced through the logger and persisted as a
      // `cascade-failure` suppressed range so retrieval tools cannot
      // surface orphaned derived rows. If the cascade keeps failing,
      // the reconciliation entry point on the privacy service
      // (`reconcileCascadeFailures`) retries on the next opportunity.
      if (cascadeDeleteCoordinator && batchResult.deletedFrameIds.length > 0) {
        try {
          await cascadeDeleteCoordinator.cascadeByFrameIds(batchResult.deletedFrameIds);
        } catch (cascadeError) {
          const message = cascadeError instanceof Error ? cascadeError.message : String(cascadeError);
          options.logger?.warn?.('retention.cascadeByFrameIds failed; persisting cascade-failure tombstone', {
            framesDeleted: batchResult.framesDeleted,
            failedFrameIdCount: batchResult.deletedFrameIds.length,
            message
          });
          if (options.privacyStore) {
            try {
              const now = (options.now ?? (() => new Date()))();
              const persisted = await options.privacyStore.read();
              // The deleted frames live in the window
              // `[oldestDeletedTimestamp, retention_floor)` —
              // retention only touches rows older than the floor
              // and the SELECT inside `deleteOldestBatch`
              // captured the exact timestamps it picked. We anchor
              // the tombstone there so retrieval tools (`find` /
              // `recall`) suppress the right window. Falling back
              // to the epoch when the timestamp is somehow null
              // keeps the on-disk shape valid.
              const fromIso = batchResult.oldestDeletedTimestamp ?? '1970-01-01T00:00:00.000Z';
              const toIso = batchResult.newestDeletedTimestamp ?? retentionFloorIso(retentionDays);
              await options.privacyStore.write({
                ...persisted,
                suppressedRanges: [
                  ...(persisted.suppressedRanges ?? []),
                  {
                    from: fromIso,
                    to: toIso,
                    reason: 'cascade-failure',
                    failedFrameIds: [...batchResult.deletedFrameIds],
                    createdAt: now.toISOString()
                  }
                ]
              });
            } catch (persistError) {
              options.logger?.warn?.('retention: failed to persist cascade-failure tombstone', {
                message: persistError instanceof Error ? persistError.message : String(persistError)
              });
            }
          }
        }
      }

      // Guard against infinite loop if delete had no effect
      if (batchResult.framesDeleted === 0) {
        return { framesDeleted: totalFramesDeleted, elementsDeleted: totalElementsDeleted, reachedFloor: true };
      }
    }
  } catch (error) {
    // Degrade gracefully — return whatever was accumulated
    options.logger?.warn?.('retention pass aborted due to fatal error', {
      message: error instanceof Error ? error.message : String(error)
    });
    return { framesDeleted: totalFramesDeleted, elementsDeleted: totalElementsDeleted, reachedFloor: false };
  }
}

export async function runTrimOnce(databasePath: string, options?: TrimOptions): Promise<ScreenpipeTrimResult> {
  const start = Date.now();
  let duplicatesRemoved = 0;
  let elementsRemoved = 0;
  let accessibilityJsonNulled = 0;

  try {
    await execFileAsync(SQLITE3_BINARY, [databasePath, ENSURE_INDEX_SQL], { timeout: TRIM_BATCH_TIMEOUT_MS });

    // Batch-delete duplicates until none remain
    while (true) {
      const remaining = await countDuplicates(databasePath);
      if (remaining === 0) break;

      const { stdout } = await execFileAsync(
        SQLITE3_BINARY,
        [databasePath, buildBatchDeleteSql(TRIM_BATCH_SIZE)],
        { timeout: TRIM_BATCH_TIMEOUT_MS }
      );
      const counts = stdout.trim().split('\n').map(Number).filter((n) => !Number.isNaN(n));
      elementsRemoved += counts[0] ?? 0;
      duplicatesRemoved += counts[1] ?? 0;

      if ((counts[1] ?? 0) === 0) break;
    }

    // Null accessibility_tree_json on kept frames that have elements
    const { stdout: nullOut } = await execFileAsync(
      SQLITE3_BINARY,
      [databasePath, NULL_JSON_SQL],
      { timeout: TRIM_NULL_TIMEOUT_MS }
    );
    const nullCounts = nullOut.trim().split('\n').map(Number).filter((n) => !Number.isNaN(n));
    accessibilityJsonNulled = nullCounts[0] ?? 0;
  } catch {
    // Degrade gracefully — return whatever was accumulated
  }

  // Retention pass: trim oldest rows if db exceeds disk budget
  if (options?.budgetBytes !== undefined) {
    await runRetentionIfOverBudget(
      databasePath,
      options.budgetBytes ?? null,
      options.retentionDays ?? 7,
      options.cascadeDeleteCoordinator,
      {
        privacyStore: options.privacyStore,
        logger: options.logger,
        now: options.now
      }
    ).catch(() => {
      // Degrade gracefully — retention failure does not fail the trim result
    });
  }

  return { duplicatesRemoved, elementsRemoved, accessibilityJsonNulled, durationMs: Date.now() - start };
}
