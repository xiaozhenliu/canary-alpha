import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ScreenpipeStorageDiagnostics } from '../../../types/app-config.js';

import {
  execFileAsync,
  parseDominantTableRows,
  SQLITE3_BINARY,
  SQLITE_DBSTAT_QUERY,
  SCREENPIPE_STORAGE_BOOTSTRAP_TIMEOUT_MS,
  SCREENPIPE_STORAGE_DIAGNOSTIC_TIMEOUT_MS,
  SCREENPIPE_STORAGE_DOMINANT_TABLE_LIMIT,
  SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH,
  SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES
} from './sqlite-cli.js';
import { inspectRecentCaptureReuse, buildRecentCaptureReuseUnavailable } from './capture-reuse.js';
import { inspectRecentTextDuplication, inspectRecentElementDuplication, buildRecentElementDuplicationUnavailable } from './duplication.js';
import { inspectRecentHeavyGrowth, buildRecentHeavyGrowthUnavailable } from './heavy-growth.js';
import { inspectScreenpipeHotspots, buildSqliteByteAttribution } from './hotspots.js';

async function inspectScreenpipeSqliteWithTimeout(
  screenpipeDirectory: string,
  timeout: number,
  includeByteAttribution: boolean
): Promise<ScreenpipeStorageDiagnostics> {
  const databasePath = join(screenpipeDirectory, 'db.sqlite');

  let totalBytes = 0;
  try {
    totalBytes = (await stat(databasePath)).size;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return {
        inspectionStatus: 'unavailable',
        reason: 'Screenpipe db.sqlite is missing.',
        databasePath,
        totalBytes: 0,
        dominantTables: [],
        hotspots: {
          inspectionStatus: 'unavailable',
          reason: 'Screenpipe db.sqlite is missing.',
          dominantFields: [],
          dominantApps: [],
          dominantAccessibilityRoles: []
        },
        recentTextDuplication: {
          inspectionStatus: 'unavailable',
          reason: 'Screenpipe db.sqlite is missing.',
          windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
          minTextLength: SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH,
          analyzedAt: new Date().toISOString(),
          sources: []
        },
        recentElementDuplication: buildRecentElementDuplicationUnavailable('unavailable', 'Screenpipe db.sqlite is missing.'),
        recentCaptureReuse: buildRecentCaptureReuseUnavailable('unavailable', 'unsupported', 'Screenpipe db.sqlite is missing.'),
        recentHeavyGrowth: buildRecentHeavyGrowthUnavailable('unavailable', 'Screenpipe db.sqlite is missing.')
      };
    }

    return {
      inspectionStatus: 'degraded',
      reason: 'Screenpipe db.sqlite size could not be read.',
      databasePath,
      totalBytes: 0,
      dominantTables: [],
      hotspots: {
        inspectionStatus: 'degraded',
        reason: 'Screenpipe db.sqlite size could not be read.',
        dominantFields: [],
        dominantApps: [],
        dominantAccessibilityRoles: []
      },
      recentTextDuplication: {
        inspectionStatus: 'degraded',
        reason: 'Screenpipe db.sqlite size could not be read.',
        windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
        minTextLength: SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH,
        analyzedAt: new Date().toISOString(),
        sources: []
      },
      recentElementDuplication: buildRecentElementDuplicationUnavailable('degraded', 'Screenpipe db.sqlite size could not be read.'),
      recentCaptureReuse: buildRecentCaptureReuseUnavailable('degraded', 'unsupported', 'Screenpipe db.sqlite size could not be read.'),
      recentHeavyGrowth: buildRecentHeavyGrowthUnavailable('degraded', 'Screenpipe db.sqlite size could not be read.')
    };
  }

  try {
    const { stdout } = await execFileAsync(SQLITE3_BINARY, [databasePath, SQLITE_DBSTAT_QUERY], {
      timeout
    });
    const tables = parseDominantTableRows(stdout);
    const hotspots = await inspectScreenpipeHotspots(databasePath);
    const recentTextDuplication = await inspectRecentTextDuplication(databasePath);
    const recentElementDuplication = await inspectRecentElementDuplication(databasePath);
    const recentCaptureReuse = await inspectRecentCaptureReuse(databasePath);
    const recentHeavyGrowth = await inspectRecentHeavyGrowth(databasePath);

    return {
      inspectionStatus: 'ready',
      databasePath,
      totalBytes,
      dominantTables: tables.slice(0, SCREENPIPE_STORAGE_DOMINANT_TABLE_LIMIT),
      byteAttribution: includeByteAttribution ? buildSqliteByteAttribution(totalBytes, tables) : undefined,
      hotspots: includeByteAttribution ? hotspots : undefined,
      recentTextDuplication,
      recentElementDuplication,
      recentCaptureReuse,
      recentHeavyGrowth
    };
  } catch {
    return {
      inspectionStatus: 'degraded',
      reason: includeByteAttribution
        ? 'Screenpipe SQLite table inspection is unavailable.'
        : 'Screenpipe SQLite table inspection exceeded the bootstrap probe budget.',
      databasePath,
      totalBytes,
      dominantTables: [],
      hotspots: includeByteAttribution
        ? {
            inspectionStatus: 'degraded',
            reason: 'Screenpipe storage hotspot inspection is unavailable.',
            dominantFields: [],
            dominantApps: [],
            dominantAccessibilityRoles: []
          }
        : undefined,
      recentTextDuplication: {
        inspectionStatus: 'degraded',
        reason: 'Recent-window text duplication inspection is unavailable.',
        windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
        minTextLength: SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH,
        analyzedAt: new Date().toISOString(),
        sources: []
      },
      recentElementDuplication: buildRecentElementDuplicationUnavailable('degraded', 'Recent accessibility element duplication inspection is unavailable.'),
      recentCaptureReuse: buildRecentCaptureReuseUnavailable('degraded', 'unsupported', 'Recent capture/reuse inspection is unavailable.'),
      recentHeavyGrowth: buildRecentHeavyGrowthUnavailable('degraded', 'Recent heavy-growth inspection is unavailable.')
    };
  }
}

export async function inspectScreenpipeSqlite(screenpipeDirectory: string): Promise<ScreenpipeStorageDiagnostics> {
  return inspectScreenpipeSqliteWithTimeout(screenpipeDirectory, SCREENPIPE_STORAGE_BOOTSTRAP_TIMEOUT_MS, false);
}

export async function inspectScreenpipeSqliteDeep(screenpipeDirectory: string): Promise<ScreenpipeStorageDiagnostics> {
  return inspectScreenpipeSqliteWithTimeout(screenpipeDirectory, SCREENPIPE_STORAGE_DIAGNOSTIC_TIMEOUT_MS, true);
}
