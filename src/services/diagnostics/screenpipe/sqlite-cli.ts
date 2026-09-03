import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ScreenpipeStorageTableUsage } from '../../../types/app-config.js';

export const execFileAsync = promisify(execFile);
export const SQLITE3_BINARY = 'sqlite3';
export const SCREENPIPE_STORAGE_BOOTSTRAP_TIMEOUT_MS = 250;
export const SCREENPIPE_STORAGE_DIAGNOSTIC_TIMEOUT_MS = 30_000;
export const SCREENPIPE_STORAGE_DOMINANT_TABLE_LIMIT = 3;
export const SCREENPIPE_STORAGE_HOTSPOT_LIMIT = 5;
export const SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES = 60;
export const SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH = 24;
export const SCREENPIPE_RECENT_TEXT_DUPLICATION_GROUP_LIMIT = 5;
export const SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT = 1000;
export const SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS = 5_000;

export const SQLITE_DBSTAT_QUERY = [
  'CREATE VIRTUAL TABLE temp.stat USING dbstat(main);',
  'SELECT name || char(9) || SUM(pgsize)',
  'FROM temp.stat',
  "WHERE aggregate = FALSE AND name NOT LIKE 'sqlite_%'",
  'GROUP BY name',
  'ORDER BY SUM(pgsize) DESC, name ASC;'
].join(' ');

export function parseTabSeparatedRow(stdout: string): string[] | null {
  const line = stdout
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);

  if (!line) {
    return null;
  }

  return line.split('\t');
}

export function parseDominantTableRows(stdout: string): ScreenpipeStorageTableUsage[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([name, estimatedBytes]) => ({
      name,
      estimatedBytes: Number.parseInt(estimatedBytes, 10)
    }))
    .filter((table) => Number.isInteger(table.estimatedBytes) && table.estimatedBytes >= 0);
}
