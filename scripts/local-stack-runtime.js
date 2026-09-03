import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProcessAlive, readRecorderPid } from './recorder-runtime.js';

export const DEFAULT_SCREENPIPE_URL = 'http://localhost:3030';
const SCREENPIPE_READY_TIMEOUT_MS = 30_000;
const SCREENPIPE_POLL_INTERVAL_MS = 500;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);

export function runNpmScript(name, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', '--silent', name], {
      cwd: repositoryRoot,
      stdio: options.quiet ? 'ignore' : 'inherit'
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${name} failed${code === null ? ` with signal ${signal ?? 'unknown'}` : ` with exit code ${code}`}.`
      ));
    });
  });
}

export async function isScreenpipeHealthy(baseUrl) {
  try {
    const response = await fetch(new URL('health', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), {
      signal: AbortSignal.timeout(2_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForScreenpipe(baseUrl, timeoutMs = SCREENPIPE_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isScreenpipeHealthy(baseUrl)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, SCREENPIPE_POLL_INTERVAL_MS));
  }
  throw new Error(`Screenpipe did not become healthy at ${baseUrl} within ${timeoutMs}ms.`);
}

export async function ensureRecorderStarted(log) {
  const recorderPid = await readRecorderPid();
  if (recorderPid !== undefined && isProcessAlive(recorderPid)) {
    log(`Recorder process ${recorderPid} is already starting; waiting for health.`);
    return;
  }
  await runNpmScript('recorder:start');
}
