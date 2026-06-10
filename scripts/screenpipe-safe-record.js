#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAINTAIN_INTERVAL_MS = 10 * 60 * 1000;

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

function spawnMaintainRun({ unref = true } = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', MAINTAIN_SCRIPT, 'run'], {
    cwd: repositoryRoot,
    stdio: 'ignore'
  });
  child.on('error', () => {
    // maintenance degrades silently; recorder lifecycle remains primary
  });
  if (unref) {
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
      const last = spawnMaintainRun({ unref: false });
      last.on('exit', () => done());
      last.on('error', () => done());
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
