import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { collectStorageDiagnostics } from '../diagnostics/storage-diagnostics.js';
import { resolveScreenpipeDirectory } from '../../config/paths.js';
import type { Logger } from '../../types/app-config.js';
import type {
  PrivacyAction,
  PrivacyControlRequest,
  PrivacyControlResult,
  PrivacyControlService,
  PrivacyDeleteRange,
  PrivacyState,
  PrivacyStore,
  PrivacySuppressedRange
} from './types.js';
import type { CascadeDeleteCoordinator } from '../work-activity/cascade-delete-coordinator.js';

const ALLOWED_DELETE_RANGES: PrivacyDeleteRange[] = ['last_1h', 'last_1d', 'all'];
const CONFIRMATION_HINT = 'Set confirm=true to request delete-range actions.';
/**
 * Defensive guard so a malformed Screenpipe DB never wedges privacy
 * control. The CLI subprocess this code used to spawn had a 30s
 * timeout; the in-process `node:sqlite` driver does not support a
 * SQL-side timeout, so we lean on the `PRAGMA busy_timeout` knob set
 * on the connection plus the prepared-statement design (which keeps
 * each round-trip O(BATCH)).
 */
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
/**
 * Frame batch size for the chunked delete loop. Matches the previous
 * sqlite3-CLI implementation so the upstream user-visible behaviour
 * (latency, deletion order) is preserved.
 */
const DELETE_BATCH_SIZE = 200;
/** ISO floor used for `range='all'` so the SQL bind parameter is well-formed. */
const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

/**
 * Translate a `PrivacyDeleteRange` to the inclusive ISO `from`
 * timestamp used as the cascade window's lower bound. The "to" bound
 * is always `now` — there is no future-frame deletion.
 *
 * Custom-range strings are rejected by the surrounding switch
 * (`ALLOWED_DELETE_RANGES`), but the function defaults a malformed
 * value to the epoch so a programming error fails open ("delete
 * everything from epoch") rather than fails closed ("delete
 * nothing"). The SQL layer always uses parameter binding, so even a
 * pathologically crafted custom range cannot smuggle SQL.
 */
export function rangeToIsoFrom(range: PrivacyDeleteRange, now: Date): string {
  if (range === 'last_1h') return new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  if (range === 'last_1d') return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  return EPOCH_ISO;
}

/**
 * Run the upstream Screenpipe deletion in-process via `node:sqlite`.
 *
 * Two correctness changes relative to the previous shell-out
 * implementation:
 *
 *   1. The window predicate is `WHERE datetime(timestamp) >= datetime(?)`
 *      with an ISO `from` bind value. This avoids the prior
 *      lexicographic comparison against TEXT timestamps, which was
 *      unsafe in the face of `+HH:MM` offsets and pre-1970
 *      timestamps. The `datetime()` SQL function normalises both
 *      sides to UTC before comparing.
 *   2. The `from` value flows through a parameter binding instead of
 *      being string-interpolated into the SQL. A custom-range string
 *      can no longer smuggle SQL into the statement.
 *
 * The function returns the chunked delete totals (frames + elements)
 * AND the set of frame ids that were actually removed, so the
 * caller can drive the derived-data cascade off the same set rather
 * than re-scanning the now-empty range.
 */
async function deleteScreenpipeRange(
  screenpipeDirectory: string,
  range: PrivacyDeleteRange,
  now: Date
): Promise<{ framesDeleted: number; elementsDeleted: number; deletedFrameIds: number[] }> {
  const dbPath = join(screenpipeDirectory, 'db.sqlite');
  if (!existsSync(dbPath)) {
    // The CLI version surfaced a `spawn ENOENT` here; preserve that
    // semantic so the caller's catch block keeps mapping the absence
    // to `PRIVACY_DELETE_UNAVAILABLE`.
    throw Object.assign(new Error(`Screenpipe database not found at ${dbPath}`), {
      code: 'ENOENT'
    });
  }

  const fromIso = rangeToIsoFrom(range, now);
  const toIso = now.toISOString();

  const db = new DatabaseSync(dbPath);
  let totalFrames = 0;
  let totalElements = 0;
  const deletedFrameIds: number[] = [];

  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);

    // Pre-prepare every statement once. The `selectIds` query is the
    // single source of truth for the window predicate — the chunked
    // delete loop reuses it on every iteration so a row that arrives
    // mid-loop is picked up as long as its timestamp falls in
    // `[from, to]`.
    const selectIds = db.prepare(
      `SELECT id FROM frames
       WHERE datetime(timestamp) >= datetime(?)
         AND datetime(timestamp) <= datetime(?)
       ORDER BY id ASC
       LIMIT ${DELETE_BATCH_SIZE}`
    );

    while (true) {
      const rows = selectIds.all(fromIso, toIso) as Array<{ id: number | bigint }>;
      if (rows.length === 0) break;
      const ids = rows.map((row) => Number(row.id));
      const placeholders = ids.map(() => '?').join(', ');

      // Both child tables and the parent table are deleted by
      // explicit id IN (?, ?, ...) lists so the subsequent
      // `changes()` count is exact and the cascade caller receives
      // the precise deleted-frame set. Each delete uses the same
      // parameter-bound id list — never a string-interpolated value.
      const elementsResult = db
        .prepare(`DELETE FROM elements WHERE frame_id IN (${placeholders})`)
        .run(...ids);
      const framesResult = db
        .prepare(`DELETE FROM frames WHERE id IN (${placeholders})`)
        .run(...ids);

      totalElements += Number(elementsResult.changes);
      totalFrames += Number(framesResult.changes);
      deletedFrameIds.push(...ids);

      // Defensive: if a concurrent writer keeps re-inserting rows
      // into the window faster than we can drain them, the loop
      // would never terminate. The previous implementation relied
      // on the same heuristic ("changes==0 means stop"); preserve
      // it here. Because the next `selectIds.all(...)` returning
      // zero rows already exits the loop, this branch is reached
      // only when frames were selected but the corresponding
      // delete did not affect any rows (rare; e.g. another writer
      // beat us to the deletion).
      if (Number(framesResult.changes) === 0) break;
    }
  } finally {
    db.close();
  }

  return { framesDeleted: totalFrames, elementsDeleted: totalElements, deletedFrameIds };
}

function normalizeAppName(appName: string): string {
  return appName.toLowerCase();
}

function createResult(action: PrivacyAction, state: PrivacyState): PrivacyControlResult {
  return {
    action,
    paused: state.paused,
    excludedApps: state.excludedApps,
    allowedDeleteRanges: ALLOWED_DELETE_RANGES,
    confirmationHint: CONFIRMATION_HINT
  };
}

interface PrivacyDiagnosticsOptions {
  appDirectory?: string;
  retrievalArtifactsDirectory?: string;
  screenpipeDirectory?: string;
}

function appendSuppressedRange(state: PrivacyState, range: PrivacySuppressedRange): PrivacyState {
  return {
    ...state,
    pauseStartedAt: undefined,
    suppressedRanges: [...(state.suppressedRanges ?? []), range]
  };
}

function toExclusiveSuppressedRangeEnd(timestamp: string): string {
  const millis = Date.parse(timestamp);
  if (Number.isNaN(millis)) {
    return timestamp;
  }

  return new Date(millis - 1).toISOString();
}

function createSuppressedRange(pauseStartedAt: string, resumedAt: string): PrivacySuppressedRange {
  const from = pauseStartedAt;
  const to = toExclusiveSuppressedRangeEnd(resumedAt);
  const fromMillis = Date.parse(from);
  const toMillis = Date.parse(to);

  if (!Number.isNaN(fromMillis) && !Number.isNaN(toMillis) && toMillis < fromMillis) {
    return {
      from,
      to: from,
      reason: 'pause'
    };
  }

  return {
    from,
    to,
    reason: 'pause'
  };
}

function createLastHourSuppressedRange(now: Date): PrivacySuppressedRange {
  const to = now.toISOString();
  const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  return {
    from,
    to,
    reason: 'delete-range'
  };
}

/**
 * Build the cascade-failure tombstone written to `suppressedRanges`
 * when Cascade_Delete partially or fully fails. Retrieval tools
 * MUST treat such rows as exclusion windows (frames inside the
 * `[from, to]` interval are dropped from `find` / `recall`) until
 * a reconciliation entry point retries the cascade and clears the
 * row.
 */
function createCascadeFailureSuppressedRange(
  fromIso: string,
  toIso: string,
  failedFrameIds: number[] | undefined,
  _reason: string,
  createdAt: Date
): PrivacySuppressedRange {
  // The `_reason` argument is intentionally unused at the persistence
  // layer — operator-readable explanations are surfaced through the
  // `cascade.reason` field on the result envelope rather than baked
  // into the on-disk shape, which keeps the persisted suppressed
  // range JSON small and audit-friendly.
  const range: PrivacySuppressedRange = {
    from: fromIso,
    to: toIso,
    reason: 'cascade-failure',
    createdAt: createdAt.toISOString()
  };
  if (failedFrameIds && failedFrameIds.length > 0) {
    range.failedFrameIds = [...failedFrameIds];
  }
  return range;
}

export class DefaultPrivacyControlService implements PrivacyControlService {
  constructor(
    private readonly store: PrivacyStore,
    private readonly now: () => Date = () => new Date(),
    private readonly diagnostics: PrivacyDiagnosticsOptions = {},
    private readonly cascadeDeleteCoordinator?: CascadeDeleteCoordinator,
    private readonly logger?: Logger
  ) {}

  async execute(request: PrivacyControlRequest): Promise<PrivacyControlResult> {
    const state = await this.store.read();

    switch (request.action) {
      case 'status':
        return this.status(state);
      case 'pause':
        return this.pause(state);
      case 'resume':
        return this.resume(state);
      case 'exclude-app':
        return this.excludeApp(state, request);
      case 'remove-excluded-app':
        return this.removeExcludedApp(state, request);
      case 'delete-range':
        return this.deleteRange(state, request);
    }
  }

  /**
   * Reconciliation entry point: walks the persisted `suppressedRanges`
   * looking for unresolved `cascade-failure` rows and retries each
   * one against the cascade coordinator. On success the row is
   * marked `resolvedAt = now` and rewritten so retrieval tools stop
   * filtering against it. Rows that the user manually authored
   * (no `reason: 'cascade-failure'`) are left alone.
   *
   * Returns the number of rows that were resolved on this pass. The
   * caller (a cleanup script / privacy control invocation) can poll
   * the API and observe progress.
   */
  async reconcileCascadeFailures(): Promise<number> {
    if (!this.cascadeDeleteCoordinator) return 0;
    const state = await this.store.read();
    const ranges = state.suppressedRanges ?? [];
    if (ranges.length === 0) return 0;

    let resolved = 0;
    const next: PrivacySuppressedRange[] = [];
    for (const range of ranges) {
      if (range.reason !== 'cascade-failure' || range.resolvedAt !== undefined) {
        next.push(range);
        continue;
      }
      try {
        if (range.failedFrameIds && range.failedFrameIds.length > 0) {
          await this.cascadeDeleteCoordinator.cascadeByFrameIds(range.failedFrameIds);
        } else {
          await this.cascadeDeleteCoordinator.cascadeByTimestampRange(range.from, range.to);
        }
        next.push({ ...range, resolvedAt: this.now().toISOString() });
        resolved += 1;
      } catch (error) {
        this.logger?.warn?.('privacy.reconcileCascadeFailures: retry failed', {
          from: range.from,
          to: range.to,
          message: error instanceof Error ? error.message : String(error)
        });
        next.push(range);
      }
    }
    await this.store.write({ ...state, suppressedRanges: next });
    return resolved;
  }

  private async status(state: PrivacyState): Promise<PrivacyControlResult> {
    const result = createResult('status', state);
    if (!this.diagnostics.appDirectory && !this.diagnostics.retrievalArtifactsDirectory && !this.diagnostics.screenpipeDirectory) {
      return result;
    }

    const diagnostics = await collectStorageDiagnostics(this.diagnostics);
    return {
      ...result,
      screenpipeStorage: diagnostics.screenpipeSqlite
    };
  }

  private async pause(state: PrivacyState): Promise<PrivacyControlResult> {
    if (state.paused && state.pauseStartedAt) {
      return createResult('pause', state);
    }

    return this.updateState('pause', {
      ...state,
      paused: true,
      pauseStartedAt: this.now().toISOString()
    });
  }

  private async resume(state: PrivacyState): Promise<PrivacyControlResult> {
    if (!state.paused) {
      return createResult('resume', {
        ...state,
        pauseStartedAt: undefined
      });
    }

    if (!state.pauseStartedAt) {
      return this.updateState('resume', {
        ...state,
        paused: false,
        pauseStartedAt: undefined
      });
    }

    const resumedAt = this.now().toISOString();
    const nextState = appendSuppressedRange(state, createSuppressedRange(state.pauseStartedAt, resumedAt));

    return this.updateState('resume', {
      ...nextState,
      paused: false
    });
  }

  private async updateState(action: PrivacyAction, state: PrivacyState): Promise<PrivacyControlResult> {
    await this.store.write(state);
    return createResult(action, state);
  }

  private async excludeApp(state: PrivacyState, request: PrivacyControlRequest): Promise<PrivacyControlResult> {
    const appName = request.appName?.trim();
    if (!appName) {
      return {
        ...createResult('exclude-app', state),
        error: {
          code: 'PRIVACY_APP_NAME_REQUIRED',
          message: 'App name is required for exclude-app.'
        }
      };
    }

    const normalizedAppName = normalizeAppName(appName);
    const excludedApps = state.excludedApps.some((existingApp) => normalizeAppName(existingApp) === normalizedAppName)
      ? state.excludedApps
      : [...state.excludedApps, appName];

    return this.updateState('exclude-app', {
      ...state,
      excludedApps
    });
  }

  private async removeExcludedApp(state: PrivacyState, request: PrivacyControlRequest): Promise<PrivacyControlResult> {
    const appName = request.appName?.trim();
    if (!appName) {
      return {
        ...createResult('remove-excluded-app', state),
        error: {
          code: 'PRIVACY_APP_NAME_REQUIRED',
          message: 'App name is required for remove-excluded-app.'
        }
      };
    }

    const normalizedAppName = normalizeAppName(appName);
    const filtered = state.excludedApps.filter(
      (existing) => normalizeAppName(existing) !== normalizedAppName
    );

    if (filtered.length === state.excludedApps.length) {
      return {
        ...createResult('remove-excluded-app', state),
        error: {
          code: 'PRIVACY_APP_NOT_EXCLUDED',
          message: `App "${appName}" is not in the excluded list.`
        }
      };
    }

    return this.updateState('remove-excluded-app', {
      ...state,
      excludedApps: filtered
    });
  }

  private async deleteRange(state: PrivacyState, request: PrivacyControlRequest): Promise<PrivacyControlResult> {
    if (!request.range) {
      return {
        ...createResult('delete-range', state),
        error: {
          code: 'PRIVACY_RANGE_REQUIRED',
          message: 'Range is required for delete-range.'
        }
      };
    }

    if (!ALLOWED_DELETE_RANGES.includes(request.range)) {
      return {
        ...createResult('delete-range', state),
        error: {
          code: 'PRIVACY_UNSUPPORTED_RANGE',
          message: `Unsupported delete range: ${request.range}.`
        }
      };
    }

    if (request.confirm !== true) {
      return {
        ...createResult('delete-range', state),
        requestedRange: request.range,
        confirmed: false,
        error: {
          code: 'PRIVACY_CONFIRM_REQUIRED',
          message: 'Delete-range requires confirm=true before it can proceed.'
        }
      };
    }

    if (request.range === 'last_1h') {
      const nextState = appendSuppressedRange(state, createLastHourSuppressedRange(this.now()));
      await this.updateState('delete-range', nextState);
    }

    try {
      const screenpipeDirectory = this.diagnostics.screenpipeDirectory ?? resolveScreenpipeDirectory();
      const cascadeStartedAt = this.now();
      const { framesDeleted, elementsDeleted, deletedFrameIds } = await deleteScreenpipeRange(
        screenpipeDirectory,
        request.range,
        cascadeStartedAt
      );
      const updatedState = request.range === 'last_1h'
        ? await this.store.read()
        : state;

      // Cascade derived data deletion after the upstream frames are
      // removed (R9.1). The previous implementation swallowed any
      // failure with `.catch(() => null)`, leaving derived rows
      // visible after their parent frames were gone. We now run the
      // cascade by the exact frame-id set we just deleted (so the
      // derived layer cannot drift even if the timestamp range had
      // tied rows), capture failure structurally, and persist a
      // tombstone so retrieval tools skip the affected window
      // until reconciliation.
      let deletedExtractedContent: number | undefined;
      let deletedSessions: number | undefined;
      let deletedEmbeddings: number | undefined;
      let cascadeOutcome: NonNullable<PrivacyControlResult['cascade']> = {
        upstreamDeleted: true,
        cascade: 'ok'
      };
      if (this.cascadeDeleteCoordinator) {
        const cascadeFromIso = rangeToIsoFrom(request.range, cascadeStartedAt);
        const cascadeToIso = cascadeStartedAt.toISOString();
        try {
          const cascadeResult = deletedFrameIds.length > 0
            ? await this.cascadeDeleteCoordinator.cascadeByFrameIds(deletedFrameIds)
            : await this.cascadeDeleteCoordinator.cascadeByTimestampRange(cascadeFromIso, cascadeToIso);
          deletedExtractedContent = cascadeResult.extractedContent;
          deletedSessions = cascadeResult.sessions;
          deletedEmbeddings = cascadeResult.embeddings;
        } catch (cascadeError) {
          const message = cascadeError instanceof Error ? cascadeError.message : String(cascadeError);
          // Persist a tombstone keyed by the same window we just
          // tried to clear. Retrieval tools intersect against this
          // list so the derived rows remain hidden until the
          // reconciliation entry point retries successfully. The
          // upstream ScreenPipe deletion already succeeded, so we
          // do NOT roll back; partial cleanup is preferable to
          // leaving the user's frames undeleted on an LLM bug.
          this.logger?.warn?.('privacy.delete-range: cascade failed', {
            range: request.range,
            framesDeleted,
            failedFrameCount: deletedFrameIds.length,
            message
          });
          const tombstone = createCascadeFailureSuppressedRange(
            cascadeFromIso,
            cascadeToIso,
            deletedFrameIds,
            message,
            cascadeStartedAt
          );
          const persisted = await this.store.read();
          await this.store.write({
            ...persisted,
            suppressedRanges: [...(persisted.suppressedRanges ?? []), tombstone]
          });
          cascadeOutcome = {
            upstreamDeleted: true,
            cascade: 'failed',
            reason: `Cascade_Delete failed: ${message}`,
            ...(deletedFrameIds.length > 0 ? { failedFrameIds: [...deletedFrameIds] } : {})
          };
        }
      }

      const refreshedState = request.range === 'last_1h' || cascadeOutcome.cascade !== 'ok'
        ? await this.store.read()
        : updatedState;

      return {
        ...createResult('delete-range', refreshedState),
        requestedRange: request.range,
        confirmed: true,
        deletedFrames: framesDeleted,
        deletedElements: elementsDeleted,
        deletedExtractedContent,
        deletedSessions,
        deletedEmbeddings,
        cascade: cascadeOutcome
      };
    } catch (error) {
      this.logger?.warn?.('privacy.delete-range: upstream deletion failed', {
        range: request.range,
        message: error instanceof Error ? error.message : String(error)
      });
      return {
        ...createResult('delete-range', state),
        requestedRange: request.range,
        confirmed: true,
        error: {
          code: 'PRIVACY_DELETE_UNAVAILABLE',
          message: 'Delete-range could not complete: Screenpipe database is unavailable.'
        }
      };
    }
  }
}
