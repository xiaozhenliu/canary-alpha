#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const MAINTAIN_INTERVAL_MS = 10 * 60 * 1000;
const MAINTAIN_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAINTAIN_LOG_MAX_BYTES = 1_000_000;
const MAINTAIN_LOG_MAX_CAPTURE_BYTES = 64_000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const DEFAULT_RETENTION_DAYS = '7';
const DEFAULT_IGNORED_WINDOWS = [
  'Control Center',
  'Notification Center'
];
const AUDIO_INTENT_OPTIONS = [
  '--audio-device',
  '--use-system-default-audio',
  '--experimental-coreaudio-system-audio'
];
const AUDIO_TRANSCRIPTION_OPTIONS = [
  '--audio-transcription-engine'
];
const VISION_INTENT_OPTIONS = [
  '--monitor-id',
  '--use-all-monitors',
  '--included-windows'
];
const SCREENPIPE_RECORD_COMMAND = 'record';
const DEFAULT_SCREENPIPE_BINARY_PATH = 'screenpipe';
const DEFAULT_SCREENPIPE_DATA_DIRECTORY = join(homedir(), '.screenpipe');
const DEFAULT_SCREENPIPE_URL = 'http://localhost:3030';

const CONFIG_PATH = join(homedir(), '.computer-history-mcp', 'config.yaml');
// Schema default for capture.ocrLanguages. MUST stay in sync with
// DEFAULT_OCR_LANGUAGES in src/config/schema.ts (a consistency test guards drift).
export const DEFAULT_OCR_LANGUAGES = ['english'];
// MUST stay in sync with ocrLanguageSchema in src/config/schema.ts
// (a consistency test guards drift).
export const OCR_LANGUAGE_ALLOWLIST = new Set([
  'english', 'chinese', 'japanese', 'korean', 'french', 'german',
  'spanish', 'russian', 'portuguese', 'italian', 'arabic'
]);
const CONFIG_MAX_BYTES = 1_000_000;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const MAINTAIN_SCRIPT = join(scriptDirectory, 'screenpipe-db-maintain.ts');
const MAINTAIN_LOG_PATH = join(homedir(), '.computer-history-mcp', 'logs', 'screenpipe-maintenance.jsonl');
const pendingMaintenanceLogWrites = new Map();

function truncateText(value) {
  if (value.length <= MAINTAIN_LOG_MAX_CAPTURE_BYTES) {
    return value;
  }
  return `${value.slice(0, MAINTAIN_LOG_MAX_CAPTURE_BYTES)}...[truncated]`;
}

function appendBufferText(current, chunk) {
  return truncateText(`${current}${String(chunk)}`);
}

function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

async function pruneMaintenanceLog(now = new Date(), logPath = MAINTAIN_LOG_PATH) {
  try {
    const fileStat = await stat(logPath);
    if (fileStat.size > MAINTAIN_LOG_MAX_BYTES) {
      await rename(logPath, `${logPath}.1`);
      return;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    return;
  }

  const cutoff = now.getTime() - MAINTAIN_LOG_RETENTION_MS;
  const content = await readFile(logPath, 'utf8');
  const kept = content
    .split(/\r?\n/)
    .filter((line) => {
      if (!line) {
        return false;
      }
      try {
        const parsed = JSON.parse(line);
        const timestamp = typeof parsed.at === 'string' ? Date.parse(parsed.at) : Number.NaN;
        return Number.isFinite(timestamp) && timestamp >= cutoff;
      } catch {
        return false;
      }
    });
  await writeFile(logPath, kept.length > 0 ? `${kept.join('\n')}\n` : '', { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  await chmod(logPath, PRIVATE_FILE_MODE);
}

export async function writeMaintenanceLogEntry(entry, options = {}) {
  const logPath = options.logPath ?? MAINTAIN_LOG_PATH;
  const now = options.now ?? new Date();
  const previousWrite = pendingMaintenanceLogWrites.get(logPath) ?? Promise.resolve();
  const nextWrite = previousWrite
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(logPath), { recursive: true, mode: PRIVATE_DIR_MODE });
      await pruneMaintenanceLog(now, logPath);
      await appendFile(logPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
      await chmod(logPath, PRIVATE_FILE_MODE);
    });

  pendingMaintenanceLogWrites.set(logPath, nextWrite);

  try {
    await nextWrite;
  } finally {
    if (pendingMaintenanceLogWrites.get(logPath) === nextWrite) {
      pendingMaintenanceLogWrites.delete(logPath);
    }
  }
}

export function killProcessGroup(pid, signal = 'SIGTERM') {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // process already exited
    }
  }
}

function spawnMaintainRun({ unref = true, trigger = 'periodic', environment = process.env } = {}) {
  const startedAt = new Date();
  void writeMaintenanceLogEntry({
    at: startedAt.toISOString(),
    event: 'maintenance-run-start',
    trigger
  }).catch(() => undefined);

  const child = spawn(process.execPath, ['--import', 'tsx', MAINTAIN_SCRIPT, 'run'], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let resolveLogDone;
  child.maintenanceLogDone = new Promise((resolve) => {
    resolveLogDone = resolve;
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout = appendBufferText(stdout, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = appendBufferText(stderr, chunk);
  });
  child.on('error', (error) => {
    void writeMaintenanceLogEntry({
      at: new Date().toISOString(),
      event: 'maintenance-run-error',
      trigger,
      durationMs: Date.now() - startedAt.getTime(),
      message: error instanceof Error ? error.message : String(error)
    }).catch(() => undefined).finally(resolveLogDone);
  });
  child.on('exit', (code, signal) => {
    const result = parseJsonOutput(stdout);
    void writeMaintenanceLogEntry({
      at: new Date().toISOString(),
      event: 'maintenance-run-exit',
      trigger,
      durationMs: Date.now() - startedAt.getTime(),
      code,
      signal,
      ...(result === undefined ? { stdout: stdout.trim() } : { result }),
      ...(stderr.trim() ? { stderr: stderr.trim() } : {})
    }).catch(() => undefined).finally(resolveLogDone);
  });
  if (unref) {
    child.stdout?.unref?.();
    child.stderr?.unref?.();
    child.unref();
  }
  return child;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function hasOption(argv, option) {
  return argv.some((token) => token === option || token.startsWith(`${option}=`));
}

function hasAudioCaptureIntent(argv) {
  return AUDIO_INTENT_OPTIONS.some((option) => hasOption(argv, option));
}

function hasAudioTranscriptionPreference(argv) {
  return AUDIO_TRANSCRIPTION_OPTIONS.some((option) => hasOption(argv, option));
}

function hasVisionCaptureIntent(argv) {
  return VISION_INTENT_OPTIONS.some((option) => hasOption(argv, option));
}

/**
 * Read capture.ocrLanguages from config.yaml, distinguishing two cases:
 *   - field absent / not an array → schema default (['english'])
 *   - file missing / unreadable / parse error / oversized → fail-open ([])
 *     so we never force --language onto screenpipe when config state is unknown.
 * Any invalid value (not in the allowlist) makes the WHOLE array fall back to
 * the default — we do not silently keep a "valid subset" and never pass an
 * unknown language to screenpipe.
 */
export async function readOcrLanguagesFromConfig(configPath = CONFIG_PATH) {
  let handle;
  try {
    // Open ONCE and stat/read the same file handle (same inode) so the size check
    // cannot be bypassed by swapping the file (or symlink target) between stat and read.
    handle = await open(configPath, 'r');
    const info = await handle.stat();
    if (info.size > CONFIG_MAX_BYTES) return []; // oversized → fail-open
    const doc = parseYaml(await handle.readFile('utf8'));
    const langs = doc?.capture?.ocrLanguages;
    if (langs === undefined) return [...DEFAULT_OCR_LANGUAGES]; // field absent → schema default
    if (!Array.isArray(langs)) return [...DEFAULT_OCR_LANGUAGES];
    if (langs.length === 0) {
      // Empty list is meaningless; treat like a missing field rather than silently disabling OCR.
      console.warn('[safe-record] empty capture.ocrLanguages; falling back to default (english)');
      return [...DEFAULT_OCR_LANGUAGES];
    }
    const allValid = langs.every((l) => typeof l === 'string' && OCR_LANGUAGE_ALLOWLIST.has(l));
    if (!allValid) {
      console.warn('[safe-record] invalid capture.ocrLanguages; falling back to default (english)');
      return [...DEFAULT_OCR_LANGUAGES]; // any invalid → whole-array fallback (no silent subset)
    }
    return langs;
  } catch {
    return []; // missing file / read / parse error / oversized → fail-open, no --language
  } finally {
    await handle?.close();
  }
}

function expandHomePath(value) {
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

export async function readScreenpipeRuntimeConfig(configPath = CONFIG_PATH) {
  try {
    const raw = await readFile(configPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > CONFIG_MAX_BYTES) {
      throw new Error('config file is too large');
    }
    const screenpipe = parseYaml(raw)?.screenpipe;
    return {
      url: typeof screenpipe?.url === 'string' && screenpipe.url.length > 0
        ? screenpipe.url
        : DEFAULT_SCREENPIPE_URL,
      binaryPath: typeof screenpipe?.binaryPath === 'string' && screenpipe.binaryPath.length > 0
        ? expandHomePath(screenpipe.binaryPath)
        : DEFAULT_SCREENPIPE_BINARY_PATH,
      dataDirectory: typeof screenpipe?.dataDirectory === 'string' && screenpipe.dataDirectory.length > 0
        ? expandHomePath(screenpipe.dataDirectory)
        : DEFAULT_SCREENPIPE_DATA_DIRECTORY
    };
  } catch {
    return {
      url: DEFAULT_SCREENPIPE_URL,
      binaryPath: DEFAULT_SCREENPIPE_BINARY_PATH,
      dataDirectory: DEFAULT_SCREENPIPE_DATA_DIRECTORY
    };
  }
}

export function buildScreenpipeSafeRecordArgs(argv = process.argv.slice(2), ocrLanguages = []) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    return [SCREENPIPE_RECORD_COMMAND, ...argv];
  }

  const args = [SCREENPIPE_RECORD_COMMAND];

  if (!hasFlag(argv, '--use-pii-removal')) {
    args.push('--use-pii-removal');
  }

  if (!hasOption(argv, '--retention-days')) {
    args.push('--retention-days', DEFAULT_RETENTION_DAYS);
  }

  if (!hasOption(argv, '--ignored-windows')) {
    for (const ignoredWindow of DEFAULT_IGNORED_WINDOWS) {
      args.push('--ignored-windows', ignoredWindow);
    }
  }

  if (!hasFlag(argv, '--disable-vision') && !hasVisionCaptureIntent(argv)) {
    args.push('--disable-vision');
  }

  const hasExplicitAudioOptOut = hasFlag(argv, '--disable-audio');

  if (!hasExplicitAudioOptOut && !hasAudioCaptureIntent(argv)) {
    args.push('--disable-audio');
  }

  if (!hasExplicitAudioOptOut && hasAudioCaptureIntent(argv) && !hasAudioTranscriptionPreference(argv)) {
    args.push('--audio-transcription-engine', 'disabled');
  }

  // Inject configured OCR languages unless the operator passed --language/-l explicitly
  // (explicit argv always wins). screenpipe accepts repeated --language flags.
  if (!hasOption(argv, '--language') && !hasOption(argv, '-l') && Array.isArray(ocrLanguages)) {
    for (const lang of ocrLanguages) {
      args.push('--language', lang);
    }
  }

  return [...args, ...argv];
}

export function buildScreenpipeRuntimeArgs(argv, dataDirectory, baseUrl) {
  const args = [...argv];
  const separateIndex = args.indexOf('--data-dir');
  if (separateIndex >= 0 && typeof args[separateIndex + 1] === 'string') {
    args[separateIndex + 1] = expandHomePath(args[separateIndex + 1]);
  } else {
    const equalsIndex = args.findIndex((token) => token.startsWith('--data-dir='));
    if (equalsIndex >= 0) {
    const value = args[equalsIndex].slice('--data-dir='.length);
    args[equalsIndex] = `--data-dir=${expandHomePath(value)}`;
    } else {
      args.unshift('--data-dir', dataDirectory);
    }
  }
  const hasShortPort = args.some((token) => /^-p(?:=)?\d+$/u.test(token));
  if (baseUrl && !hasOption(args, '--port') && !hasOption(args, '-p') && !hasShortPort) {
    const port = new URL(baseUrl).port;
    if (port) args.unshift('--port', port);
  }
  return args;
}

export function readScreenpipeDataDirectoryArg(argv) {
  const separateIndex = argv.indexOf('--data-dir');
  if (separateIndex >= 0 && typeof argv[separateIndex + 1] === 'string') {
    return argv[separateIndex + 1];
  }
  const equalsValue = argv.find((token) => token.startsWith('--data-dir='));
  return equalsValue?.slice('--data-dir='.length);
}

export async function run(argv = process.argv.slice(2), options = {}) {
  const runtimeConfig = options.runtimeConfig ?? await readScreenpipeRuntimeConfig();
  const command = options.command ?? runtimeConfig.binaryPath;
  const cwd = options.cwd ?? repositoryRoot;
  const env = options.env ?? process.env;
  const ocrLanguages = options.ocrLanguages ?? await readOcrLanguagesFromConfig();
  const runtimeArgv = buildScreenpipeRuntimeArgs(argv, runtimeConfig.dataDirectory, runtimeConfig.url);
  const args = buildScreenpipeSafeRecordArgs(runtimeArgv, ocrLanguages);
  const effectiveDataDirectory = readScreenpipeDataDirectoryArg(runtimeArgv)
    ?? runtimeConfig.dataDirectory;
  const maintenanceEnvironment = {
    ...env,
    SCREENPIPE_DB_PATH: join(effectiveDataDirectory, 'db.sqlite'),
    SCREENPIPE_BACKUP_DIR: join(effectiveDataDirectory, 'backup')
  };

  await new Promise((resolve, reject) => {
    let settling = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      detached: true
    });

    const maintainTimer = setInterval(() => {
      spawnMaintainRun({ environment: maintenanceEnvironment });
    }, MAINTAIN_INTERVAL_MS);
    maintainTimer.unref?.();

    const cleanup = () => {
      clearInterval(maintainTimer);
      process.off('SIGTERM', onSigterm);
      process.off('SIGINT', onSigint);
    };

    const forward = (signal) => {
      if (child.pid !== undefined) {
        killProcessGroup(child.pid, signal);
      }
    };
    const onSigterm = () => forward('SIGTERM');
    const onSigint = () => forward('SIGINT');
    process.on('SIGTERM', onSigterm);
    process.on('SIGINT', onSigint);

    const runFinalMaintenance = (done) => {
      const last = spawnMaintainRun({
        unref: false,
        trigger: 'final',
        environment: maintenanceEnvironment
      });
      let finalizing = false;
      const finalize = () => {
        if (finalizing) {
          return;
        }
        finalizing = true;
        void last.maintenanceLogDone.finally(done);
      };
      last.on('exit', finalize);
      last.on('error', finalize);
    };

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (settling) return;
      settling = true;
      cleanup();
      const finish = () => {
        if (signal) {
          resolve(undefined);
          return;
        }

        if ((code ?? 1) !== 0) {
          reject(new Error(`screenpipe record exited with code ${code ?? 1}.`));
          return;
        }

        resolve(undefined);
      };
      runFinalMaintenance(finish);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
