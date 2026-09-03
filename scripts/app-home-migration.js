import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isLegacyManagedServiceLoaded, LEGACY_LAUNCHD_LABEL } from './legacy-service.js';

const execFileAsync = promisify(execFile);

export const LEGACY_APP_DIRECTORY_NAME = '.canary-alpha-mcp';
export const APP_DIRECTORY_NAME = '.computer-history-mcp';
const CONFIG_FILE_NAME = 'config.yaml';
const LEGACY_HOME_TOKEN = '~/.canary-alpha-mcp';
const TARGET_HOME_TOKEN = '~/.computer-history-mcp';
const RECORDER_PID_FILE_NAME = 'recorder.pid';

function formatBackupTimestamp(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessStartedAt(pid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=']);
    const startedAt = stdout.trim();
    return startedAt.length > 0 ? startedAt : null;
  } catch {
    return null;
  }
}

async function assertNoActiveLegacyRuntimeWriters(legacyDirectory) {
  const writerRoots = new Set([legacyDirectory]);
  const configPath = join(legacyDirectory, CONFIG_FILE_NAME);
  if (existsSync(configPath)) {
    try {
      const YAML = (await import('yaml')).default;
      const parsed = YAML.parse(await readFile(configPath, 'utf8'));
      const configuredPath = parsed?.vectorStore?.path;
      if (typeof configuredPath === 'string' && configuredPath.length > 0) {
        const resolved = configuredPath.startsWith('~/')
          ? join(homedir(), configuredPath.slice(2))
          : configuredPath;
        writerRoots.add(resolved);
      }
    } catch {
      // Ignore unreadable config and keep checking the legacy home itself.
    }
  }

  for (const root of writerRoots) {
    const recorderPidPath = join(root, RECORDER_PID_FILE_NAME);
    if (existsSync(recorderPidPath)) {
      try {
        const pid = Number((await readFile(recorderPidPath, 'utf8')).trim());
        if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) {
          throw new Error(
            `Refusing to migrate while legacy recorder pid ${pid} is still active. ` +
            'Stop the old recorder (`npm run recorder:stop` from the previous install) before continuing.'
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('Refusing to migrate')) {
          throw error;
        }
      }
    }

    const rebuildLockPath = join(root, 'rebuild-index.lock');
    if (existsSync(rebuildLockPath)) {
      try {
        const lock = JSON.parse(await readFile(rebuildLockPath, 'utf8'));
        if (typeof lock.pid === 'number' && processIsAlive(lock.pid)) {
          if (typeof lock.processStartedAt === 'string' && lock.processStartedAt.length > 0) {
            const liveStartedAt = await readProcessStartedAt(lock.pid);
            if (liveStartedAt === null || liveStartedAt === lock.processStartedAt) {
              throw new Error(
                `Refusing to migrate while rebuild-index pid ${lock.pid} is still active. ` +
                'Wait for rebuild-index to finish or stop it before continuing.'
              );
            }
          } else {
            throw new Error(
              `Refusing to migrate while rebuild-index pid ${lock.pid} is still active. ` +
              'Wait for rebuild-index to finish or stop it before continuing.'
            );
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('Refusing to migrate')) {
          throw error;
        }
      }
    }

    const registryDirectory = join(root, 'runtime-processes');
    if (!existsSync(registryDirectory)) {
      continue;
    }

    const entries = await readdir(registryDirectory);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      try {
        const raw = await readFile(join(registryDirectory, entry), 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.pid !== 'number' || !processIsAlive(parsed.pid)) {
          continue;
        }
        if (typeof parsed.processStartedAt === 'string' && parsed.processStartedAt.length > 0) {
          const liveStartedAt = await readProcessStartedAt(parsed.pid);
          if (liveStartedAt !== null && liveStartedAt !== parsed.processStartedAt) {
            continue;
          }
        }
        throw new Error(
          `Refusing to migrate while legacy runtime process pid ${parsed.pid} is still active. ` +
          'Stop the old MCP server (stdio/HTTP) using ~/.canary-alpha-mcp before continuing.'
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes('Refusing to migrate')) {
          throw error;
        }
      }
    }
  }
}

export function resolveLegacyAppDirectory(homeDirectory = homedir()) {
  return join(homeDirectory, LEGACY_APP_DIRECTORY_NAME);
}

export function resolveTargetAppDirectory(homeDirectory = homedir()) {
  return join(homeDirectory, APP_DIRECTORY_NAME);
}

/**
 * Replace only complete legacy app-home path segments (token followed by `/`, `\`, or end).
 */
export function replaceLegacyAppHomePathSegment(text, from, to) {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const found = text.indexOf(from, index);
    if (found === -1) {
      result += text.slice(index);
      break;
    }

    result += text.slice(index, found);
    const after = found + from.length;
    const next = text[after];
    if (next === undefined || next === '/' || next === '\\') {
      result += to;
    } else {
      result += from;
    }
    index = after;
  }
  return result;
}

export async function rewriteLegacyAppHomePaths(targetDirectory, homeDirectory = homedir()) {
  const configPath = join(targetDirectory, CONFIG_FILE_NAME);
  if (!existsSync(configPath)) {
    return false;
  }

  const original = await readFile(configPath, 'utf8');
  const legacyAbsolute = resolveLegacyAppDirectory(homeDirectory);
  const targetAbsolute = resolveTargetAppDirectory(homeDirectory);
  if (
    !original.includes(LEGACY_HOME_TOKEN)
    && !original.includes(legacyAbsolute)
  ) {
    return false;
  }

  // Only rewrite complete legacy app-home path segments, never longer
  // same-prefix paths such as ~/.canary-alpha-mcp-archive.
  const rewritten = replaceLegacyAppHomePathSegment(
    replaceLegacyAppHomePathSegment(original, LEGACY_HOME_TOKEN, TARGET_HOME_TOKEN),
    legacyAbsolute,
    targetAbsolute
  );

  if (rewritten === original) {
    return false;
  }

  await writeFile(configPath, rewritten, { encoding: 'utf8', mode: 0o600 });
  return true;
}

export function inspectAppHomeMigrationState(homeDirectory = homedir()) {
  const legacyDirectory = resolveLegacyAppDirectory(homeDirectory);
  const targetDirectory = resolveTargetAppDirectory(homeDirectory);
  const legacyExists = existsSync(legacyDirectory);
  const targetExists = existsSync(targetDirectory);

  if (legacyExists && targetExists) {
    return { legacyDirectory, targetDirectory, legacyExists, targetExists, status: 'both-present' };
  }
  if (legacyExists) {
    return { legacyDirectory, targetDirectory, legacyExists, targetExists, status: 'legacy-only' };
  }
  if (targetExists) {
    return { legacyDirectory, targetDirectory, legacyExists, targetExists, status: 'ready' };
  }
  return { legacyDirectory, targetDirectory, legacyExists, targetExists, status: 'missing' };
}

/**
 * Migrate a pre-rename app home directory to the canonical name.
 * Keep behavior aligned with src/config/app-home-migration.ts.
 */
export async function migrateLegacyAppHomeIfNeeded(options = {}) {
  const homeDirectory = options.homeDirectory ?? homedir();
  const now = options.now ?? new Date();
  const legacyDirectory = resolveLegacyAppDirectory(homeDirectory);
  const targetDirectory = resolveTargetAppDirectory(homeDirectory);

  const legacyExists = existsSync(legacyDirectory);
  const targetExists = existsSync(targetDirectory);

  if (!legacyExists) {
    return { status: 'skipped', reason: 'legacy-missing', targetDirectory };
  }

  if (targetExists) {
    return {
      status: 'blocked',
      reason: 'both-present',
      legacyDirectory,
      targetDirectory
    };
  }

  if (isLegacyManagedServiceLoaded(homeDirectory)) {
    throw new Error(
      `Legacy managed service ${LEGACY_LAUNCHD_LABEL} is still loaded. ` +
      'Run `npm start` or `npm run setup` to stop it and migrate safely before starting the server directly.'
    );
  }

  await assertNoActiveLegacyRuntimeWriters(legacyDirectory);

  const legacyStat = await lstat(legacyDirectory);
  const sourceDirectory = legacyStat.isSymbolicLink()
    ? await realpath(legacyDirectory)
    : legacyDirectory;
  const backupDirectory = `${legacyDirectory}.backup-${formatBackupTimestamp(now)}`;
  await cp(sourceDirectory, backupDirectory, { recursive: true, verbatimSymlinks: false });

  if (legacyStat.isSymbolicLink()) {
    await cp(sourceDirectory, targetDirectory, { recursive: true, verbatimSymlinks: false });
    await rm(legacyDirectory);
  } else {
    await rename(legacyDirectory, targetDirectory);
  }

  try {
    await rewriteLegacyAppHomePaths(targetDirectory, homeDirectory);
  } catch (error) {
    if (legacyStat.isSymbolicLink()) {
      await rm(targetDirectory, { recursive: true, force: true }).catch(() => undefined);
      await symlink(sourceDirectory, legacyDirectory).catch(() => undefined);
    } else {
      await rename(targetDirectory, legacyDirectory).catch(() => undefined);
    }
    throw error;
  }

  return {
    status: 'migrated',
    legacyDirectory,
    targetDirectory,
    backupDirectory
  };
}

export async function ensureAppHomeReady(options = {}) {
  const homeDirectory = options.homeDirectory ?? homedir();
  const migration = await migrateLegacyAppHomeIfNeeded({ homeDirectory, now: options.now });
  const failOnConflict = options.failOnConflict === true;

  if (migration.status === 'blocked' && failOnConflict) {
    throw new Error(
      `Both ${migration.legacyDirectory} and ${migration.targetDirectory} exist. Resolve the conflict manually before continuing.`
    );
  }

  const targetDirectory = migration.targetDirectory;
  if (!existsSync(targetDirectory)) {
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  } else if (options.ensurePrivateMode) {
    await stat(targetDirectory);
  }

  return migration;
}
