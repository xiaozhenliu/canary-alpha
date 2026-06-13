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
// Tear down with `npm run down` (stops the managed service; Ctrl-C the
// recorder separately).

import { spawnSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const configPath = join(homedir(), '.canary-alpha-mcp', 'config.yaml');
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

async function main() {
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
  if (await isScreenpipeHealthy(screenpipeUrl)) {
    log('capture', `Reusing the already-running Screenpipe at ${screenpipeUrl}.`);
    console.log('');
    console.log('Stack is up. The MCP service is serving and Screenpipe is recording.');
    console.log('Your agent (Hermes) can now retrieve screen memory. Stop the service with `npm run down`.');
    return;
  }

  log('capture', 'Screenpipe is not running — starting the recorder in the foreground.');
  log('capture', 'Press Ctrl-C to stop recording; the MCP service keeps running for past-data queries.');
  console.log('');
  // Hand the terminal to the recorder. It owns its own SIGINT/SIGTERM handling
  // (graceful stop + a final DB-maintenance pass), so we simply mirror its exit.
  const recorder = spawn(
    process.execPath,
    [join(scriptDirectory, 'screenpipe-safe-record.js'), '--use-all-monitors'],
    { cwd: repositoryRoot, stdio: 'inherit' }
  );
  recorder.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

await main();
