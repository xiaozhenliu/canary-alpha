#!/usr/bin/env node
//
// Shared runtime helpers for the background Screenpipe recorder lifecycle
// (recorder:start / recorder:stop / recorder:status / recorder:logs).
//
// Paths mirror the managed MCP service: everything lives under
// ~/.computer-history-mcp/ so the recorder and the launchd-managed service share a
// single private app directory. HOME is resolved via os.homedir() so the
// integration tests can redirect the whole tree by overriding HOME.

import { rm } from 'node:fs/promises';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIRECTORY_NAME = '.computer-history-mcp';
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// Rotate the recorder log once it grows past this size so a long-lived
// background recorder cannot fill the disk. We keep a single rotated copy.
const RECORDER_LOG_MAX_BYTES = 5_000_000;

export const appDirectory = join(homedir(), APP_DIRECTORY_NAME);
export const logDirectory = join(appDirectory, 'logs');
export const recorderLogPath = join(logDirectory, 'recorder.log');
export const rotatedRecorderLogPath = `${recorderLogPath}.1`;
export const recorderPidPath = join(appDirectory, 'recorder.pid');

/** Ensure the private log directory exists with owner-only permissions. */
export async function ensureLogDirectory() {
  await mkdir(logDirectory, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/** Read the recorded background PID, or undefined when no valid PID is stored. */
export async function readRecorderPid() {
  try {
    const raw = (await readFile(recorderPidPath, 'utf8')).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Persist the background recorder PID with owner-only permissions. */
export async function writeRecorderPid(pid) {
  await mkdir(appDirectory, { recursive: true, mode: PRIVATE_DIR_MODE });
  await writeFile(recorderPidPath, `${pid}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
}

/** Remove the PID file; a missing file is treated as success. */
export async function clearRecorderPid() {
  await rm(recorderPidPath, { force: true });
}

/**
 * Return true when a process with the given PID is alive. Signal 0 performs an
 * existence/permission check without delivering a signal: ESRCH means the
 * process is gone, EPERM means it exists but is owned by someone else.
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/** Rotate recorder.log to recorder.log.1 when it exceeds the size cap. */
export async function rotateRecorderLogIfNeeded() {
  try {
    const fileStat = await stat(recorderLogPath);
    if (fileStat.size > RECORDER_LOG_MAX_BYTES) {
      await rename(recorderLogPath, rotatedRecorderLogPath);
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}
