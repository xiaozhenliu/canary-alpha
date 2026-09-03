#!/usr/bin/env node
// scripts/start-daily.js
//
// One-command daily bring-up for real use:
//   npm run up
//
// Brings the whole local stack up so a connected agent (Hermes, Claude, …)
// can retrieve screen memory:
//   1. build      — compile current source so the managed service runs HEAD
//                   (service:start launches the prebuilt dist/ and never rebuilds)
//   2. service    — start the launchd-managed MCP HTTP service and WAIT until
//                   it is reachable (service:start blocks until ready or fails)
//   3. capture    — ensure Screenpipe is recording: reuse an already-healthy
//                   instance, otherwise start the safe-record recorder in the
//                   foreground (Ctrl-C stops recording; the MCP service, being
//                   launchd-managed, keeps running for past-data queries)
//
// Pass `--detach` (alias `--background`) to start the recorder detached from the
// terminal instead, so the launching window can be closed. In that mode capture
// output goes to ~/.computer-history-mcp/logs/recorder.log; stop it gracefully with
// `npm run recorder:stop`.
//
// Tear down with `npm run down` (stops the managed service). Stop the recorder
// with Ctrl-C (foreground) or `npm run recorder:stop` (detached).

import { spawnSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const configPath = join(homedir(), '.computer-history-mcp', 'config.yaml');
const DEFAULT_SCREENPIPE_URL = 'http://localhost:3030';

function log(step, message) {
  console.log(`[up:${step}] ${message}`);
}

/** Run a command inheriting stdio; return its exit code (0 on success). */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: 'inherit' });
  return result.status ?? 1;
}

/** Resolve the configured Screenpipe base URL, falling back to the default. */
async function resolveScreenpipeUrl() {
  try {
    const { default: YAML } = await import('yaml');
    const raw = YAML.parse(await readFile(configPath, 'utf8')) ?? {};
    const url = raw?.screenpipe?.url;
    return typeof url === 'string' && url.length > 0 ? url : DEFAULT_SCREENPIPE_URL;
  } catch {
    return DEFAULT_SCREENPIPE_URL;
  }
}

async function isScreenpipeHealthy(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stop whatever process is currently recording on the Screenpipe port.
 *
 * Used only by `--restart-capture`: a reused Screenpipe may have been started
 * by something else (an earlier run, the desktop app, a different flag set),
 * so a forced restart guarantees the recorder runs with THIS script's intended
 * options. Sends SIGTERM (Screenpipe shuts down gracefully), waits for the port
 * to go quiet, then escalates to SIGKILL as a backstop.
 */
async function stopRunningScreenpipe(baseUrl) {
  const port = new URL(baseUrl).port || '3030';
  const findListeners = () => {
    const result = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return (result.stdout ?? '')
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  };

  const pids = findListeners();
  if (pids.length === 0) {
    log('capture', `No listener found on port ${port}; nothing to stop.`);
    return;
  }
  log('capture', `Force-restart: stopping Screenpipe listener(s) on port ${port} (pid ${pids.join(', ')}).`);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(1_000);
    if (!(await isScreenpipeHealthy(baseUrl)) && findListeners().length === 0) {
      log('capture', 'Previous Screenpipe stopped.');
      return;
    }
  }
  for (const pid of findListeners()) {
    log('capture', `Screenpipe pid ${pid} did not exit gracefully; sending SIGKILL.`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await sleep(1_000);
}

/** Start the safe-record recorder in the foreground and mirror its exit code. */
function startRecorderForeground() {
  log('capture', 'Starting the recorder in the foreground.');
  log('capture', 'Press Ctrl-C to stop recording; the MCP service keeps running for past-data queries.');
  console.log('');
  // The recorder owns its own SIGINT/SIGTERM handling (graceful stop + a final
  // DB-maintenance pass), so we simply mirror its exit.
  const recorder = spawn(
    process.execPath,
    [join(scriptDirectory, 'screenpipe-safe-record.js'), '--use-all-monitors'],
    { cwd: repositoryRoot, stdio: 'inherit' }
  );
  recorder.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

/**
 * Start the safe-record recorder detached from the terminal via recorder:start,
 * then return so the launching window can be closed. recorder:start itself
 * spawns the recorder detached, redirects output to a log file, and exits.
 */
function startRecorderBackground() {
  log('capture', 'Starting the recorder in the background (the terminal will be free).');
  const code = run('npm', ['run', 'recorder:start']);
  if (code !== 0) {
    log('capture', 'recorder:start failed — inspect with `npm run recorder:logs`.');
    process.exit(code);
  }
  console.log('');
  console.log('Stack is up in the background. The MCP service and the recorder are both detached.');
  console.log('Stop the service with `npm run down`; stop the recorder with `npm run recorder:stop`.');
}

async function main() {
  const argv = process.argv.slice(2);
  // Opt-in: stop any running Screenpipe and start a fresh recorder, so the
  // capture process is guaranteed to use this script's flags rather than
  // whatever an already-running (possibly differently-configured) instance had.
  const forceRestartCapture = argv.includes('--restart-capture') || argv.includes('--force-capture');
  // Opt-in: run the recorder detached from the terminal (background) instead of
  // in the foreground, so the launching window can be closed.
  const detachRecorder = argv.includes('--detach') || argv.includes('--background');

  // Step 1: build current source.
  log('build', 'Compiling current source (npm run build)…');
  if (run('npm', ['run', 'build']) !== 0) {
    log('build', 'Build failed — fix the TypeScript errors above, then re-run `npm run up`.');
    process.exit(1);
  }

  // Step 2: start the managed MCP service (blocks until reachable or fails).
  log('service', 'Starting the managed MCP service (waits until reachable)…');
  if (run('npm', ['run', 'service:start']) !== 0) {
    log('service', 'service:start failed — inspect with `npm run service:logs`.');
    process.exit(1);
  }

  // Step 3: ensure Screenpipe is capturing.
  const screenpipeUrl = await resolveScreenpipeUrl();
  const healthy = await isScreenpipeHealthy(screenpipeUrl);

  if (healthy && !forceRestartCapture) {
    log('capture', `Reusing the already-running Screenpipe at ${screenpipeUrl}.`);
    log('capture', 'Pass `--restart-capture` if you want a guaranteed-fresh recorder instead.');
    console.log('');
    console.log('Stack is up. The MCP service is serving and Screenpipe is recording.');
    console.log('Your agent (Hermes) can now retrieve screen memory. Stop the service with `npm run down`.');
    return;
  }

  if (healthy && forceRestartCapture) {
    await stopRunningScreenpipe(screenpipeUrl);
  } else {
    log('capture', 'Screenpipe is not running.');
  }

  if (detachRecorder) {
    startRecorderBackground();
    return;
  }

  startRecorderForeground();
}

await main();
