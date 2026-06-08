import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { RoutineDefinition, RoutineRunRecord, RoutineStore } from './types.js';

const ROUTINE_NAME_PATTERN = /[^a-z0-9]+/g;
const ROUTINE_TRIM_PATTERN = /^-+|-+$/g;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function normalizeDefinitionName(value: unknown): string | undefined {
  const name = normalizeString(value);
  if (!name) {
    return undefined;
  }

  return normalizeRoutineName(name);
}

function isRoutineKind(value: unknown): value is RoutineDefinition['kind'] {
  return value === 'daily_summary';
}

function isRoutineRunStatus(value: unknown): value is RoutineRunRecord['status'] {
  return value === 'success' || value === 'failed' || value === 'skipped';
}

function parseJson(text: string, filePath: string, kind: 'definition' | 'history'): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid routine ${kind} at ${filePath}`);
  }
}

function parseDefinition(value: unknown, filePath: string): RoutineDefinition {
  if (!isObject(value)) {
    throw new Error(`Invalid routine definition at ${filePath}`);
  }

  const name = normalizeDefinitionName(value.name);
  const schedule = normalizeString(value.schedule);
  const enabled = normalizeBoolean(value.enabled);
  const kind = value.kind;
  const prompt = normalizeString(value.prompt);
  const recentActivityMinutes = normalizeNumber(value.recentActivityMinutes);
  const createdAt = normalizeTimestamp(value.createdAt);
  const updatedAt = normalizeTimestamp(value.updatedAt);

  if (!name || !schedule || typeof enabled === 'undefined' || !isRoutineKind(kind) || !prompt || typeof recentActivityMinutes === 'undefined' || !createdAt || !updatedAt) {
    throw new Error(`Invalid routine definition at ${filePath}`);
  }

  return {
    name,
    schedule,
    enabled,
    kind,
    prompt,
    recentActivityMinutes,
    createdAt,
    updatedAt
  };
}

function parseRunRecord(value: unknown, filePath: string): RoutineRunRecord {
  if (!isObject(value)) {
    throw new Error(`Invalid routine history at ${filePath}`);
  }

  const runId = normalizeString(value.runId);
  const name = normalizeDefinitionName(value.name);
  const startedAt = normalizeTimestamp(value.startedAt);
  const completedAt = normalizeTimestamp(value.completedAt);
  const status = value.status;
  const summary = normalizeString(value.summary);
  const output = normalizeString(value.output);
  const error = value.error;

  if (!runId || !name || !startedAt || !completedAt || !isRoutineRunStatus(status) || !summary || !output) {
    throw new Error(`Invalid routine history at ${filePath}`);
  }

  if (typeof error !== 'undefined') {
    if (!isObject(error) || typeof error.message !== 'string') {
      throw new Error(`Invalid routine history at ${filePath}`);
    }

    return {
      runId,
      name,
      startedAt,
      completedAt,
      status,
      summary,
      output,
      error: {
        message: error.message
      }
    };
  }

  return {
    runId,
    name,
    startedAt,
    completedAt,
    status,
    summary,
    output
  };
}

function parseDefinitionFile(filePath: string, text: string): RoutineDefinition {
  return parseDefinition(parseJson(text, filePath, 'definition'), filePath);
}

function parseHistoryFile(filePath: string, text: string): RoutineRunRecord[] {
  const parsed = parseJson(text, filePath, 'history');
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid routine history at ${filePath}`);
  }

  return parsed.map((item) => parseRunRecord(item, filePath));
}

async function writeJsonAtomic(filePath: string, content: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(content, null, 2), { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  await rename(tempPath, filePath);
}

export function normalizeRoutineName(name: string): string {
  return name.trim().toLowerCase().replace(ROUTINE_NAME_PATTERN, '-').replace(ROUTINE_TRIM_PATTERN, '');
}

export class FileRoutineStore implements RoutineStore {
  constructor(private readonly paths: { definitionsDirectory: string; historyDirectory: string }) {}

  private definitionPath(name: string): string {
    return join(this.paths.definitionsDirectory, `${name}.json`);
  }

  private historyPath(name: string): string {
    return join(this.paths.historyDirectory, `${name}.json`);
  }

  async listDefinitions(): Promise<RoutineDefinition[]> {
    await mkdir(this.paths.definitionsDirectory, { recursive: true, mode: PRIVATE_DIR_MODE });
    const entries = await readdir(this.paths.definitionsDirectory, { withFileTypes: true });
    const definitions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          const filePath = join(this.paths.definitionsDirectory, entry.name);
          return parseDefinitionFile(filePath, await readFile(filePath, 'utf8'));
        })
    );

    return definitions.sort((left, right) => left.name.localeCompare(right.name));
  }

  async readDefinition(name: string): Promise<RoutineDefinition | undefined> {
    const normalizedName = normalizeRoutineName(name);
    if (!normalizedName) {
      return undefined;
    }

    const filePath = this.definitionPath(normalizedName);

    try {
      return parseDefinitionFile(filePath, await readFile(filePath, 'utf8'));
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  async writeDefinition(definition: RoutineDefinition): Promise<boolean> {
    const normalizedName = normalizeRoutineName(definition.name);
    if (!normalizedName) {
      throw new Error('Routine name must contain at least one letter or number.');
    }

    const filePath = this.definitionPath(normalizedName);
    const existing = await this.readDefinition(normalizedName);
    const record: RoutineDefinition = {
      name: normalizedName,
      schedule: definition.schedule,
      enabled: definition.enabled,
      kind: definition.kind,
      prompt: definition.prompt,
      recentActivityMinutes: definition.recentActivityMinutes,
      createdAt: existing?.createdAt ?? definition.createdAt,
      updatedAt: definition.updatedAt
    };

    await writeJsonAtomic(filePath, record);
    return !existing;
  }

  async appendRun(record: RoutineRunRecord): Promise<void> {
    const normalizedName = normalizeRoutineName(record.name);
    if (!normalizedName) {
      throw new Error('Routine name must contain at least one letter or number.');
    }

    const filePath = this.historyPath(normalizedName);
    const existing = await this.listRuns(normalizedName, Number.POSITIVE_INFINITY);

    await writeJsonAtomic(filePath, [
      {
        runId: record.runId,
        name: normalizedName,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        status: record.status,
        summary: record.summary,
        output: record.output,
        ...(record.error ? { error: { message: record.error.message } } : {})
      },
      ...existing
    ]);
  }

  async listRuns(name: string, limit: number): Promise<RoutineRunRecord[]> {
    const normalizedName = normalizeRoutineName(name);
    if (!normalizedName) {
      return [];
    }

    const filePath = this.historyPath(normalizedName);

    try {
      return parseHistoryFile(filePath, await readFile(filePath, 'utf8')).slice(0, limit);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }
}
