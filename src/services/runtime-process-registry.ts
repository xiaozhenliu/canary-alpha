import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile, link } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { resolveRebuildLockPath, resolveRuntimeRegistryPath } from '../config/paths.js';
import type { AppConfig, ServerMode } from '../types/app-config.js';

const execFileAsync = promisify(execFile);
const PROCESS_IDENTITY_TOLERANCE_MS = 2_000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

interface RuntimeProcessRecord {
  pid: number;
  mode: ServerMode;
  configFile: string;
  registeredAt: string;
  processStartedAt?: string;
}

interface RebuildLockPayload {
  pid: number;
  configFile: string;
  lockedAt: string;
  processStartedAt?: string;
}

function parseRecord(raw: string): RuntimeProcessRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid runtime process marker payload.');
  }

  if (!('pid' in parsed) || typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    throw new Error('Invalid runtime process marker pid.');
  }

  if (!('mode' in parsed) || (parsed.mode !== 'stdio' && parsed.mode !== 'http')) {
    throw new Error('Invalid runtime process marker mode.');
  }

  if (!('configFile' in parsed) || typeof parsed.configFile !== 'string') {
    throw new Error('Invalid runtime process marker config file.');
  }

  if (!('registeredAt' in parsed) || typeof parsed.registeredAt !== 'string') {
    throw new Error('Invalid runtime process marker registration time.');
  }

  const processStartedAt = 'processStartedAt' in parsed && typeof parsed.processStartedAt === 'string'
    ? parsed.processStartedAt
    : undefined;

  if ('processStartedAt' in parsed && parsed.processStartedAt !== undefined && typeof parsed.processStartedAt !== 'string') {
    throw new Error('Invalid runtime process marker process start time.');
  }

  return {
    pid: parsed.pid,
    mode: parsed.mode,
    configFile: parsed.configFile,
    registeredAt: parsed.registeredAt,
    processStartedAt
  };
}

function parseRebuildLock(raw: string): RebuildLockPayload {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid rebuild lock payload.');
  }

  if (!('pid' in parsed) || typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    throw new Error('Invalid rebuild lock pid.');
  }

  if (!('configFile' in parsed) || typeof parsed.configFile !== 'string') {
    throw new Error('Invalid rebuild lock config file.');
  }

  if (!('lockedAt' in parsed) || typeof parsed.lockedAt !== 'string') {
    throw new Error('Invalid rebuild lock timestamp.');
  }

  const processStartedAt = 'processStartedAt' in parsed && typeof parsed.processStartedAt === 'string'
    ? parsed.processStartedAt
    : undefined;

  if ('processStartedAt' in parsed && parsed.processStartedAt !== undefined && typeof parsed.processStartedAt !== 'string') {
    throw new Error('Invalid rebuild lock process start time.');
  }

  return {
    pid: parsed.pid,
    configFile: parsed.configFile,
    lockedAt: parsed.lockedAt,
    processStartedAt
  };
}

async function readProcessStartedAt(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=']);
    const startedAt = stdout.trim();
    return startedAt.length > 0 ? startedAt : null;
  } catch {
    return null;
  }
}

function parseElapsedTimeMs(rawElapsed: string): number | null {
  const elapsed = rawElapsed.trim();
  if (elapsed.length === 0) {
    return null;
  }

  const [dayPart, timePart] = elapsed.includes('-')
    ? elapsed.split('-', 2)
    : [undefined, elapsed];
  const segments = timePart.split(':').map((segment) => Number(segment));
  if (segments.some((segment) => !Number.isInteger(segment) || segment < 0)) {
    return null;
  }

  const days = dayPart === undefined ? 0 : Number(dayPart);
  if (!Number.isInteger(days) || days < 0 || segments.length < 2 || segments.length > 3) {
    return null;
  }

  const [hours, minutes, seconds] = segments.length === 3
    ? segments
    : [0, segments[0], segments[1]];
  if (minutes >= 60 || seconds >= 60) {
    return null;
  }

  return ((((days * 24) + hours) * 60 + minutes) * 60 + seconds) * 1_000;
}

async function readProcessElapsedTimeMs(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'etime=']);
    return parseElapsedTimeMs(stdout);
  } catch {
    return null;
  }
}

async function isRecordedProcessAlive(
  pid: number,
  recordedAt: string,
  expectedProcessStartedAt?: string
): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'EPERM') {
      return true;
    }
    return false;
  }

  if (expectedProcessStartedAt) {
    const startedAt = await readProcessStartedAt(pid);
    if (startedAt === null) {
      return true;
    }

    return startedAt === expectedProcessStartedAt;
  }

  const recordedAtMs = Date.parse(recordedAt);
  if (Number.isNaN(recordedAtMs)) {
    return true;
  }

  const elapsedTimeMs = await readProcessElapsedTimeMs(pid);
  if (elapsedTimeMs === null) {
    return true;
  }

  const ageSinceRecordedMs = Math.max(0, Date.now() - recordedAtMs);
  return elapsedTimeMs + PROCESS_IDENTITY_TOLERANCE_MS >= ageSinceRecordedMs;
}

async function readLiveRecords(directoryPath: string): Promise<RuntimeProcessRecord[]> {
  let fileNames: string[] = [];

  try {
    fileNames = await readdir(directoryPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return [];
    }
    throw new Error(`Failed to read runtime process markers at ${directoryPath}: ${nodeError.message}`);
  }

  const liveRecords: RuntimeProcessRecord[] = [];
  for (const fileName of fileNames) {
    if (fileName.endsWith('.tmp')) {
      continue;
    }

    const markerPath = join(directoryPath, fileName);
    try {
      const raw = await readFile(markerPath, 'utf8');
      const record = parseRecord(raw);
      if (!await isRecordedProcessAlive(record.pid, record.registeredAt, record.processStartedAt)) {
        await rm(markerPath, { force: true }).catch(() => undefined);
        continue;
      }
      liveRecords.push(record);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        await rm(markerPath, { force: true }).catch(() => undefined);
      }
    }
  }

  return liveRecords;
}

export interface RuntimeGuardHandle {
  release(): Promise<void>;
  releaseSync(): void;
}

export interface RebuildLockHandle {
  release(): Promise<void>;
}

export async function registerRuntimeProcess(config: AppConfig): Promise<RuntimeGuardHandle> {
  const directoryPath = resolveRuntimeRegistryPath(config.vectorStore);
  const markerPath = join(directoryPath, `${process.pid}.json`);
  const markerTempPath = `${markerPath}.tmp`;
  const record: RuntimeProcessRecord = {
    pid: process.pid,
    mode: config.server.mode,
    configFile: config.paths.configFile,
    registeredAt: new Date().toISOString(),
    processStartedAt: await readProcessStartedAt(process.pid) ?? undefined
  };

  await mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  await writeFile(markerTempPath, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  await rename(markerTempPath, markerPath);

  let released = false;
  const releaseSync = (): void => {
    if (released) {
      return;
    }
    released = true;
    try {
      rmSync(markerPath, { force: true });
      rmSync(markerTempPath, { force: true });
    } catch {
      // Best-effort sync cleanup during shutdown.
    }
  };

  return {
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      await rm(markerPath, { force: true }).catch(() => undefined);
      await rm(markerTempPath, { force: true }).catch(() => undefined);
    },
    releaseSync
  };
}

export async function findActiveRuntimeProcesses(config: AppConfig): Promise<RuntimeProcessRecord[]> {
  const records = await readLiveRecords(resolveRuntimeRegistryPath(config.vectorStore));
  return records.filter((record) => record.pid !== process.pid);
}

export async function ensureRebuildLockNotHeld(config: AppConfig): Promise<void> {
  const lockPath = resolveRebuildLockPath(config.vectorStore);

  try {
    const raw = await readFile(lockPath, 'utf8');
    const lock = parseRebuildLock(raw);
    if (!await isRecordedProcessAlive(lock.pid, lock.lockedAt, lock.processStartedAt)) {
      await rm(lockPath, { force: true }).catch(() => undefined);
      return;
    }

    throw new Error(
      `Refusing to start MCP server while rebuild-index is active for retrieval artifacts at ${lockPath} (pid ${lock.pid}, config ${lock.configFile}). Wait for rebuild-index to finish first.`
    );
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return;
    }
    if (error instanceof Error && error.message.startsWith('Refusing to start MCP server while rebuild-index is active')) {
      throw error;
    }

    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export async function acquireRebuildLock(config: AppConfig): Promise<RebuildLockHandle> {
  const lockPath = resolveRebuildLockPath(config.vectorStore);
  const lockTempPath = `${lockPath}.${process.pid}.tmp`;
  const payload: RebuildLockPayload = {
    pid: process.pid,
    configFile: config.paths.configFile,
    lockedAt: new Date().toISOString(),
    processStartedAt: await readProcessStartedAt(process.pid) ?? undefined
  };

  await ensureRebuildLockNotHeld(config);
  await mkdir(dirname(lockPath), { recursive: true, mode: PRIVATE_DIR_MODE });
  await writeFile(lockTempPath, JSON.stringify(payload, null, 2), {
    encoding: 'utf8',
    flag: 'wx',
    mode: PRIVATE_FILE_MODE
  });

  try {
    await link(lockTempPath, lockPath);
  } catch (error) {
    await rm(lockTempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  await rm(lockTempPath, { force: true }).catch(() => undefined);

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      await rm(lockPath, { force: true }).catch(() => undefined);
      await rm(lockTempPath, { force: true }).catch(() => undefined);
    }
  };
}
