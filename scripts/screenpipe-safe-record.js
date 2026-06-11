#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const SCREENPIPE_PACKAGE = 'screenpipe@latest';
const SCREENPIPE_RECORD_COMMAND = 'record';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const MAINTAIN_SCRIPT = join(scriptDirectory, 'screenpipe-db-maintain.ts');
const MAINTAIN_LOG_PATH = join(homedir(), '.canary-alpha-mcp', 'logs', 'screenpipe-maintenance.jsonl');
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

function spawnMaintainRun({ unref = true, trigger = 'periodic' } = {}) {
  const startedAt = new Date();
  void writeMaintenanceLogEntry({
    at: startedAt.toISOString(),
    event: 'maintenance-run-start',
    trigger
  }).catch(() => undefined);

  const child = spawn(process.execPath, ['--import', 'tsx', MAINTAIN_SCRIPT, 'run'], {
    cwd: repositoryRoot,
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

export function buildScreenpipeSafeRecordArgs(argv = process.argv.slice(2)) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    return [SCREENPIPE_PACKAGE, SCREENPIPE_RECORD_COMMAND, ...argv];
  }

  const args = [SCREENPIPE_PACKAGE, SCREENPIPE_RECORD_COMMAND];

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

  return [...args, ...argv];
}

export async function run(argv = process.argv.slice(2), options = {}) {
  const command = options.command ?? 'npx';
  const cwd = options.cwd ?? repositoryRoot;
  const env = options.env ?? process.env;
  const args = buildScreenpipeSafeRecordArgs(argv);

  await new Promise((resolve, reject) => {
    let settling = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      detached: true
    });

    const maintainTimer = setInterval(() => {
      spawnMaintainRun();
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
      const last = spawnMaintainRun({ unref: false, trigger: 'final' });
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
