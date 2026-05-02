#!/usr/bin/env node

import { spawn, execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCREENPIPE_DB_PATH = join(homedir(), '.screenpipe', 'db.sqlite');
const TRIM_INTERVAL_MS = 10 * 60 * 1000;
const TRIM_BATCH_SIZE = 100;
const TRIM_BATCH_TIMEOUT_MS = 10_000;

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

async function runTrimBatch() {
  const sql = [
    `CREATE INDEX IF NOT EXISTS idx_frames_content_hash ON frames(content_hash) WHERE content_hash IS NOT NULL;`,
    `DELETE FROM frames WHERE id IN (SELECT id FROM frames WHERE content_hash IS NOT NULL AND id NOT IN (SELECT MIN(id) FROM frames WHERE content_hash IS NOT NULL GROUP BY content_hash) LIMIT ${TRIM_BATCH_SIZE});`,
    `UPDATE frames SET accessibility_tree_json = NULL WHERE accessibility_tree_json IS NOT NULL AND EXISTS (SELECT 1 FROM elements WHERE elements.frame_id = frames.id);`
  ].join('\n');
  try {
    await execFileAsync('sqlite3', [SCREENPIPE_DB_PATH, sql], { timeout: TRIM_BATCH_TIMEOUT_MS });
  } catch {
    // degrade silently
  }
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
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit'
    });

    const trimTimer = setInterval(() => { void runTrimBatch(); }, TRIM_INTERVAL_MS);

    child.on('error', (err) => { clearInterval(trimTimer); reject(err); });
    child.on('exit', (code, signal) => {
      clearInterval(trimTimer);
      if (signal) {
        reject(new Error(`screenpipe record exited via signal ${signal}.`));
        return;
      }

      if ((code ?? 1) !== 0) {
        reject(new Error(`screenpipe record exited with code ${code ?? 1}.`));
        return;
      }

      resolve(undefined);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
