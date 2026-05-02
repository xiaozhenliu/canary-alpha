import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { PrivacyState, PrivacyStore, PrivacySuppressedRange } from './types.js';
import { DEFAULT_PRIVACY_STATE } from './types.js';

const EARLIEST_PRIVACY_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const LATEST_PRIVACY_TIMESTAMP = '9999-12-31T23:59:59.999Z';

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function normalizeSuppressedRanges(value: unknown): PrivacySuppressedRange[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const candidate = item as Partial<PrivacySuppressedRange>;
    if (typeof candidate.from !== 'string' || typeof candidate.to !== 'string') {
      return [];
    }

    const normalizedFrom = normalizeTimestamp(candidate.from) ?? EARLIEST_PRIVACY_TIMESTAMP;
    const normalizedTo = normalizeTimestamp(candidate.to) ?? LATEST_PRIVACY_TIMESTAMP;

    return Date.parse(normalizedFrom) <= Date.parse(normalizedTo)
      ? [{
          from: normalizedFrom,
          to: normalizedTo
        }]
      : [{
          from: normalizedTo,
          to: normalizedFrom
        }];
  });
}

function normalizeExcludedApps(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function normalizePaused(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'undefined') {
    return DEFAULT_PRIVACY_STATE.paused;
  }

  return true;
}

export class FilePrivacyStore implements PrivacyStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<PrivacyState> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PrivacyState>;
      return {
        paused: normalizePaused(parsed.paused),
        excludedApps: normalizeExcludedApps(parsed.excludedApps),
        pauseStartedAt: normalizeTimestamp(parsed.pauseStartedAt),
        suppressedRanges: normalizeSuppressedRanges(parsed.suppressedRanges)
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return DEFAULT_PRIVACY_STATE;
      }

      throw error;
    }
  }

  async write(state: PrivacyState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
    await rename(tempPath, this.filePath);
  }
}
