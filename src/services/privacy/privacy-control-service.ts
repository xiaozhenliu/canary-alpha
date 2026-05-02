import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { collectStorageDiagnostics } from '../diagnostics/storage-diagnostics.js';
import { resolveScreenpipeDirectory } from '../../config/paths.js';
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

const ALLOWED_DELETE_RANGES: PrivacyDeleteRange[] = ['last_1h', 'last_1d', 'all'];
const CONFIRMATION_HINT = 'Set confirm=true to request delete-range actions.';
const DELETE_TIMEOUT_MS = 30_000;
const DELETE_BATCH_SIZE = 200;

const execFileAsync = promisify(execFile);

function rangeToFromClause(range: PrivacyDeleteRange): string {
  if (range === 'last_1h') return `datetime('now', '-1 hour')`;
  if (range === 'last_1d') return `datetime('now', '-1 day')`;
  return `'1970-01-01'`;
}

async function deleteScreenpipeRange(
  screenpipeDirectory: string,
  range: PrivacyDeleteRange
): Promise<{ framesDeleted: number; elementsDeleted: number }> {
  const dbPath = join(screenpipeDirectory, 'db.sqlite');
  const from = rangeToFromClause(range);
  let totalFrames = 0;
  let totalElements = 0;

  while (true) {
    const sql = [
      `DELETE FROM elements WHERE frame_id IN (SELECT id FROM frames WHERE timestamp >= ${from} LIMIT ${DELETE_BATCH_SIZE});`,
      `SELECT changes();`,
      `DELETE FROM frames WHERE id IN (SELECT id FROM frames WHERE timestamp >= ${from} LIMIT ${DELETE_BATCH_SIZE});`,
      `SELECT changes();`
    ].join('\n');
    const { stdout } = await execFileAsync('sqlite3', [dbPath, sql], { timeout: DELETE_TIMEOUT_MS });
    const counts = stdout.trim().split('\n').map(Number).filter((n) => !Number.isNaN(n));
    totalElements += counts[0] ?? 0;
    totalFrames += counts[1] ?? 0;
    if ((counts[1] ?? 0) === 0) break;
  }

  return { framesDeleted: totalFrames, elementsDeleted: totalElements };
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
      to: from
    };
  }

  return {
    from,
    to
  };
}

function createLastHourSuppressedRange(now: Date): PrivacySuppressedRange {
  const to = now.toISOString();
  const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  return {
    from,
    to
  };
}

export class DefaultPrivacyControlService implements PrivacyControlService {
  constructor(
    private readonly store: PrivacyStore,
    private readonly now: () => Date = () => new Date(),
    private readonly diagnostics: PrivacyDiagnosticsOptions = {}
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
      case 'delete-range':
        return this.deleteRange(state, request);
    }
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
      const { framesDeleted, elementsDeleted } = await deleteScreenpipeRange(screenpipeDirectory, request.range);
      const updatedState = request.range === 'last_1h'
        ? await this.store.read()
        : state;

      return {
        ...createResult('delete-range', updatedState),
        requestedRange: request.range,
        confirmed: true,
        deletedFrames: framesDeleted,
        deletedElements: elementsDeleted
      };
    } catch {
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
