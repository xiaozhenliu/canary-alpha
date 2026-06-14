import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';
import { testTempRoot } from '../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STOP_SCRIPT = join(PROJECT_ROOT, 'scripts', 'recorder-stop.js');
const STATUS_SCRIPT = join(PROJECT_ROOT, 'scripts', 'recorder-status.js');
const LOGS_SCRIPT = join(PROJECT_ROOT, 'scripts', 'recorder-logs.js');
const START_SCRIPT = join(PROJECT_ROOT, 'scripts', 'recorder-start.js');

const cleanup: Array<() => Promise<void> | void> = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  while (cleanup.length > 0) {
    const close = cleanup.pop();
    if (close) {
      await close();
    }
  }
});

async function makeHome(): Promise<string> {
  const homeDir = await mkdtemp(join(testTempRoot(), 'recorder-'));
  cleanup.push(() => rm(homeDir, { recursive: true, force: true }));
  await mkdir(join(homeDir, '.canary-alpha-mcp'), { recursive: true });
  return homeDir;
}

function pidFilePath(homeDir: string): string {
  return join(homeDir, '.canary-alpha-mcp', 'recorder.pid');
}

function logDir(homeDir: string): string {
  return join(homeDir, '.canary-alpha-mcp', 'logs');
}

function env(homeDir: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: homeDir };
}

/**
 * Spawn a long-lived dummy process that exits cleanly (code 0) on SIGTERM.
 * It writes "ready" once the SIGTERM handler is installed so a test can wait
 * for the handler before signalling — otherwise a signal delivered during the
 * sub-millisecond startup window terminates it via the default action
 * (exitCode null / signalCode SIGTERM), making the graceful-stop assertion
 * flaky under parallel load.
 */
function spawnDummy(): ChildProcess {
  const child = spawn(process.execPath, [
    '-e',
    'process.on("SIGTERM", () => process.exit(0)); process.stdout.write("ready\\n"); setInterval(() => {}, 1_000_000_000);'
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  return child;
}

/** Resolve once the dummy reports that its SIGTERM handler is installed. */
function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      if (buffer.includes('ready')) {
        resolve();
      }
    });
    // Fail fast with a clear message instead of degrading to a Vitest timeout
    // if the dummy dies before reporting ready.
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`dummy exited before ready (code=${code}, signal=${signal})`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}

describe('recorder:status script', () => {
  it('reports stopped when no PID file exists', async () => {
    const homeDir = await makeHome();
    const { stdout } = await execFileAsync(process.execPath, [STATUS_SCRIPT], { env: env(homeDir) });
    expect(stdout).toContain('recorder: stopped');
  });

  it('reports running for a live recorder PID', async () => {
    const homeDir = await makeHome();
    const dummy = spawnDummy();
    await writeFile(pidFilePath(homeDir), `${dummy.pid}\n`, 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [STATUS_SCRIPT], { env: env(homeDir) });
    expect(stdout).toContain('recorder: running');
    expect(stdout).toContain(`pid: ${dummy.pid}`);
  });
});

describe('recorder:stop script', () => {
  it('reports already stopped when no PID file exists', async () => {
    const homeDir = await makeHome();
    const { stdout } = await execFileAsync(process.execPath, [STOP_SCRIPT], { env: env(homeDir) });
    expect(stdout).toContain('already stopped');
  });

  it('gracefully stops a running recorder via SIGTERM and removes the PID file', async () => {
    const homeDir = await makeHome();
    const dummy = spawnDummy();
    await waitForReady(dummy); // ensure the SIGTERM handler is installed before signalling
    await writeFile(pidFilePath(homeDir), `${dummy.pid}\n`, 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [STOP_SCRIPT], { env: env(homeDir) });
    await waitForExit(dummy);

    expect(stdout).toContain('recorder stopped');
    expect(dummy.exitCode).toBe(0); // exited cleanly in response to SIGTERM
    expect(existsSync(pidFilePath(homeDir))).toBe(false);
  });

  it('clears a stale PID file pointing at a dead process', async () => {
    const homeDir = await makeHome();
    const dummy = spawnDummy();
    const stalePid = dummy.pid;
    dummy.kill('SIGKILL');
    await waitForExit(dummy);
    await writeFile(pidFilePath(homeDir), `${stalePid}\n`, 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [STOP_SCRIPT], { env: env(homeDir) });
    expect(stdout).toContain('already stopped');
    expect(existsSync(pidFilePath(homeDir))).toBe(false);
  });
});

describe('recorder:start script', () => {
  it('refuses to start when a live recorder is already running', async () => {
    const homeDir = await makeHome();
    const dummy = spawnDummy();
    await writeFile(pidFilePath(homeDir), `${dummy.pid}\n`, 'utf8');

    await expect(
      execFileAsync(process.execPath, [START_SCRIPT], { env: env(homeDir) })
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('already running')
    });
  });
});

describe('recorder:logs script', () => {
  it('prints the rotated recorder log when recorder.log has been rotated away', async () => {
    const homeDir = await makeHome();
    await mkdir(logDir(homeDir), { recursive: true });
    await writeFile(join(logDir(homeDir), 'recorder.log.1'), [
      '2026-06-14T00:00:00.000Z recorder rotated line 1',
      '2026-06-14T00:00:01.000Z recorder rotated line 2'
    ].join('\n'), 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [LOGS_SCRIPT], { env: env(homeDir) });
    expect(stdout).toContain('== recorder log (rotated):');
    expect(stdout).toContain('recorder rotated line 1');
    expect(stdout).toContain('recorder rotated line 2');
  });
});
