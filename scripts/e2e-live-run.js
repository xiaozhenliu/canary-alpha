#!/usr/bin/env node
// scripts/e2e-live-run.js
//
// One-command live verification on this machine:
//   npm run e2e:live -- --duration 10m [--index-timeout 120s]
//
// Phase 0  preflight (hermes CLI, app config, args)
// Phase 1  Screenpipe: reuse healthy instance or start CLI daemon
// Phase 2  MCP service: reuse reachable endpoint or `npm run service:start`
// Phase 3  recording window with frame-count progress
// Phase 4  conditional wait for index readiness (no fixed sleep)
// Phase 5  hermes chat content verification over the recorded window
// Phase 6  cleanup (only what we started) + Pass_Fail_Summary

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { detectHermes, HERMES_INSTALL_URL } from './hermes-detector.js';
import {
  applyServerEnvironmentOverrides,
  parseManagedServiceEnvironmentFromPlist,
  readServerConfig,
  resolveManagedServiceServer
} from './service-runtime-config.js';
import {
  buildCleanupPlan,
  classifyHermesOutcome,
  evaluateIndexReadiness,
  parseLiveRunArgs
} from './e2e-live-run-lib.js';

const execFileAsync = promisify(execFile);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const appDirectory = join(homedir(), '.canary-alpha-mcp');
const installedPlistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.canary-alpha-mcp.plist');

const SCREENPIPE_BASE_URL = 'http://localhost:3030';
const SCREENPIPE_START_TIMEOUT_MS = 60_000;
const MCP_START_TIMEOUT_MS = 60_000;
const PROGRESS_INTERVAL_MS = 30_000;
const INDEX_POLL_INTERVAL_MS = 10_000;

const state = {
  screenpipeChild: null,
  startedScreenpipe: false,
  startedMcpService: false
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(phase, message) {
  console.log(`[${phase}] ${message}`);
}

// ── Pass_Fail_Summary ───────────────────────────────────────────────────────

function printPassFailSummary(summary) {
  console.log('');
  console.log('=== Pass_Fail_Summary ===');
  for (const [key, value] of Object.entries(summary)) {
    console.log(`${key}: ${value}`);
  }
  console.log('=========================');
}

function fail(failureMode, summaryExtras, lines) {
  console.error('');
  console.error(`[${failureMode}]`);
  for (const line of lines) {
    console.error(line);
  }
  printPassFailSummary({ outcome: `fail:${failureMode}`, failureMode, ...summaryExtras });
  process.exitCode = 1;
}

// ── Cleanup ────────────────────────────────────────────────────────────────

let cleanupPromise = null;

function cleanup() {
  cleanupPromise = cleanupPromise ?? performCleanup();
  return cleanupPromise;
}

async function performCleanup() {
  const plan = buildCleanupPlan({
    startedScreenpipe: state.startedScreenpipe,
    startedMcpService: state.startedMcpService
  });
  for (const action of plan) {
    if (action === 'stop-screenpipe' && state.screenpipeChild !== null) {
      log('cleanup', 'Stopping script-started Screenpipe recorder.');
      try {
        process.kill(-state.screenpipeChild.pid, 'SIGTERM');
      } catch {
        state.screenpipeChild.kill('SIGTERM');
      }
    }
    if (action === 'stop-mcp-service') {
      log('cleanup', 'Stopping script-started MCP service.');
      try {
        await execFileAsync('npm', ['run', 'service:stop'], { cwd: repositoryRoot, timeout: 60_000 });
      } catch (error) {
        console.error(`cleanup: service:stop failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (plan.length === 0) {
    log('cleanup', 'Nothing to stop: all dependencies were reused, leaving them running.');
  }
}

process.on('SIGINT', () => {
  void cleanup().catch(() => {}).then(() => process.exit(130));
});
process.on('SIGTERM', () => {
  void cleanup().catch(() => {}).then(() => process.exit(143));
});

// ── Probes ─────────────────────────────────────────────────────────────────

async function isScreenpipeHealthy() {
  try {
    const response = await fetch(`${SCREENPIPE_BASE_URL}/health`, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function countFramesSince(startIso, endIso) {
  const url = new URL(`${SCREENPIPE_BASE_URL}/search`);
  url.searchParams.set('limit', '1');
  url.searchParams.set('start_time', startIso);
  if (endIso !== undefined) {
    url.searchParams.set('end_time', endIso);
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    if (typeof payload?.pagination?.total === 'number') {
      return payload.pagination.total;
    }
    return Array.isArray(payload?.data) ? payload.data.length : null;
  } catch {
    return null;
  }
}

async function loadConfiguredServer() {
  const configPath = join(appDirectory, 'config.yaml');
  const { default: YAML } = await import('yaml');
  const raw = YAML.parse(await readFile(configPath, 'utf8')) ?? {};
  const parsedServer = readServerConfig(raw, configPath);
  const managedEnvironment = existsSync(installedPlistPath)
    ? parseManagedServiceEnvironmentFromPlist(await readFile(installedPlistPath, 'utf8'))
    : {};
  const configuredServer = applyServerEnvironmentOverrides(parsedServer, managedEnvironment);
  return resolveManagedServiceServer(configuredServer, managedEnvironment);
}

async function isMcpReachable(server) {
  try {
    const response = await fetch(`http://${server.host}:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(server.authToken !== undefined ? { authorization: `Bearer ${server.authToken}` } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'e2e-live-health', method: 'ping' }),
      signal: AbortSignal.timeout(5_000)
    });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

async function readExtractionWatermark(server) {
  const client = new Client({ name: 'e2e-live-run', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${server.host}:${server.port}/mcp`),
    server.authToken !== undefined
      ? { authProvider: { token: async () => server.authToken } }
      : undefined
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'internal-status', arguments: {} });
    const text = result?.content?.find((entry) => entry.type === 'text')?.text;
    const parsed = result?.structuredContent ?? (typeof text === 'string' ? JSON.parse(text) : null);
    return parsed?.extraction?.lastExtractedAt ?? null;
  } catch (error) {
    console.warn(`[phase4] readExtractionWatermark failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Phase 0: preflight
  let options;
  try {
    options = parseLiveRunArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const detection = await detectHermes();
  if (!detection.present) {
    fail('hermes-missing', { hermesVersion: 'absent' }, [
      'Hermes CLI is not available on PATH.',
      `Install instructions: ${HERMES_INSTALL_URL}`
    ]);
    return;
  }
  const hermesVersion = detection.version.split('\n')[0].trim();

  const configPath = join(appDirectory, 'config.yaml');
  if (!existsSync(configPath)) {
    fail('config-missing', { hermesVersion }, [
      `${configPath} not found.`,
      'Run first: npm run onboard'
    ]);
    return;
  }

  log('phase0', `duration=${options.durationMs / 1_000}s indexTimeout=${options.indexTimeoutMs / 1_000}s hermes=${hermesVersion}`);

  // Phase 1: Screenpipe (hybrid start)
  if (await isScreenpipeHealthy()) {
    log('phase1', 'Reusing already-healthy Screenpipe at localhost:3030 (will NOT stop it on exit).');
  } else {
    log('phase1', 'Screenpipe not healthy — starting CLI recorder via screenpipe-safe-record with --use-all-monitors.');
    state.screenpipeChild = spawn(
      process.execPath,
      [join(scriptDirectory, 'screenpipe-safe-record.js'), '--use-all-monitors'],
      { cwd: repositoryRoot, stdio: ['ignore', 'inherit', 'inherit'], detached: true }
    );
    state.startedScreenpipe = true;
    const deadline = Date.now() + SCREENPIPE_START_TIMEOUT_MS;
    let healthy = false;
    while (Date.now() < deadline) {
      await sleep(3_000);
      if (await isScreenpipeHealthy()) {
        healthy = true;
        break;
      }
    }
    if (!healthy) {
      fail('screenpipe-unhealthy', { hermesVersion }, [
        `Screenpipe did not become healthy within ${SCREENPIPE_START_TIMEOUT_MS / 1_000}s.`,
        'Check macOS Screen Recording / Accessibility permissions, then retry.',
        'See docs/quickstart.md section 1.'
      ]);
      await cleanup();
      return;
    }
    log('phase1', 'Screenpipe is healthy.');
  }

  // Phase 2: MCP service
  let server;
  try {
    server = await loadConfiguredServer();
  } catch (error) {
    fail('config-missing', { hermesVersion }, [
      `Could not parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      'Run: npm run setup'
    ]);
    await cleanup();
    return;
  }
  const endpoint = `http://${server.host}:${server.port}/mcp`;

  if (await isMcpReachable(server)) {
    log('phase2', `Reusing reachable MCP service at ${endpoint}.`);
  } else {
    log('phase2', `MCP service not reachable — running npm run service:start.`);
    try {
      await execFileAsync('npm', ['run', 'service:start'], {
        cwd: repositoryRoot,
        timeout: MCP_START_TIMEOUT_MS,
        env: {
          ...process.env,
          ...(server.authToken !== undefined ? { CANARY_ALPHA_MCP_AUTH_TOKEN: server.authToken } : {})
        }
      });
    } catch (error) {
      fail('mcp-service-down', { hermesVersion, mcpEndpoint: endpoint }, [
        `service:start failed: ${error instanceof Error ? error.message : String(error)}`,
        'Next: npm run service:status / npm run service:logs'
      ]);
      await cleanup();
      return;
    }
    state.startedMcpService = true;
    const deadline = Date.now() + MCP_START_TIMEOUT_MS;
    let reachable = false;
    while (Date.now() < deadline) {
      await sleep(2_000);
      if (await isMcpReachable(server)) {
        reachable = true;
        break;
      }
    }
    if (!reachable) {
      fail('mcp-service-down', { hermesVersion, mcpEndpoint: endpoint }, [
        `MCP service did not become reachable within ${MCP_START_TIMEOUT_MS / 1_000}s.`,
        'Next: npm run service:status / npm run service:logs'
      ]);
      await cleanup();
      return;
    }
    log('phase2', 'MCP service is reachable.');
  }

  // Phase 3: recording window
  const recordStart = new Date();
  const recordStartIso = recordStart.toISOString();
  log('phase3', `Recording window started at ${recordStartIso} for ${options.durationMs / 1_000}s. Use your machine normally.`);

  let lastFrameCount = 0;
  let stagnantChecks = 0;
  const recordingDeadline = Date.now() + options.durationMs;
  while (Date.now() < recordingDeadline) {
    await sleep(Math.min(PROGRESS_INTERVAL_MS, recordingDeadline - Date.now()));
    const frames = await countFramesSince(recordStartIso);
    const remaining = Math.max(0, Math.round((recordingDeadline - Date.now()) / 1_000));
    log('phase3', `frames captured so far: ${frames ?? 'unknown'} — ${remaining}s remaining`);
    if (frames !== null && frames <= lastFrameCount) {
      stagnantChecks += 1;
      if (stagnantChecks >= 2) {
        console.warn('[phase3] WARNING: frame count is not growing. Check macOS Screen Recording permission for Screenpipe.');
      }
    } else {
      stagnantChecks = 0;
    }
    if (frames !== null) {
      lastFrameCount = frames;
    }
  }
  const recordEnd = new Date();
  const recordEndIso = recordEnd.toISOString();
  const windowFrameCount = await countFramesSince(recordStartIso, recordEndIso);
  log('phase3', `Recording window ended at ${recordEndIso}; frames in window: ${windowFrameCount ?? 'unknown'}.`);

  if (windowFrameCount === 0) {
    fail('no-frames-captured', {
      hermesVersion,
      mcpEndpoint: endpoint,
      recordWindow: `${recordStartIso} .. ${recordEndIso}`
    }, [
      'Screenpipe captured zero frames during the recording window.',
      'Most likely macOS Screen Recording permission is missing for the Screenpipe process.',
      'See docs/quickstart.md Troubleshooting.'
    ]);
    await cleanup();
    return;
  }

  // Phase 4: conditional index readiness wait
  log('phase4', `Waiting for index readiness (poll ${INDEX_POLL_INTERVAL_MS / 1_000}s, timeout ${options.indexTimeoutMs / 1_000}s).`);
  const indexDeadline = Date.now() + options.indexTimeoutMs;
  const indexWaitStart = Date.now();
  let previousWindowCount = 0;
  let indexReady = false;
  let lastWatermark = null;
  while (Date.now() < indexDeadline) {
    const [watermark, currentWindowCount] = await Promise.all([
      readExtractionWatermark(server),
      countFramesSince(recordStartIso, recordEndIso)
    ]);
    lastWatermark = watermark;
    const verdict = evaluateIndexReadiness({
      lastExtractedAt: watermark,
      recordEndIso,
      previousWindowCount,
      currentWindowCount: currentWindowCount ?? 0
    });
    log('phase4', `watermark=${watermark ?? 'null'} windowCount=${currentWindowCount ?? 'unknown'} → ${verdict.reason}`);
    if (verdict.ready) {
      indexReady = true;
      log('phase4', `Index ready after ${Math.round((Date.now() - indexWaitStart) / 1_000)}s (${verdict.reason}).`);
      break;
    }
    previousWindowCount = currentWindowCount ?? previousWindowCount;
    await sleep(INDEX_POLL_INTERVAL_MS);
  }
  if (!indexReady) {
    fail('index-lag', {
      hermesVersion,
      mcpEndpoint: endpoint,
      recordWindow: `${recordStartIso} .. ${recordEndIso}`,
      lastWatermark: lastWatermark ?? 'null'
    }, [
      `Index did not catch up to recordEnd within ${options.indexTimeoutMs / 1_000}s.`,
      'Check indexer and embedding provider health: npm run service:logs / npm run storage:diagnostics.',
      'You can retry with a larger --index-timeout.'
    ]);
    await cleanup();
    return;
  }

  // Phase 5: hermes content verification
  const query = `调用 recall，from=${recordStartIso}，to=${recordEndIso}，granularity 自选，总结这段时间屏幕上实际出现的内容，引用具体的应用或文本。`;
  log('phase5', 'Running hermes chat content verification.');
  let chatTranscript = '';
  let chatFailed = false;
  try {
    const chatResult = await execFileAsync('hermes', [
      'chat',
      '--quiet',
      '--max-turns', '3',
      '--toolsets', 'canary-alpha-mcp',
      '--query', query
    ], {
      cwd: repositoryRoot,
      env: process.env,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024
    });
    chatTranscript = [chatResult.stdout, chatResult.stderr].filter(Boolean).join('\n');
  } catch (error) {
    chatFailed = true;
    const stdout = typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout ?? '') : '';
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr ?? '') : '';
    const message = error instanceof Error ? error.message : String(error);
    chatTranscript = [stdout, stderr, message].filter(Boolean).join('\n');
  }

  const transcriptPath = join(tmpdir(), `e2e-live-run-transcript-${recordEnd.getTime()}.txt`);
  await writeFile(transcriptPath, chatTranscript, 'utf8');

  const verdict = classifyHermesOutcome({ transcript: chatTranscript, chatFailed });

  // Phase 6: cleanup + summary
  await cleanup();

  printPassFailSummary({
    outcome: verdict.outcome,
    failureMode: verdict.failureMode,
    hermesVersion,
    mcpEndpoint: endpoint,
    recordWindow: `${recordStartIso} .. ${recordEndIso}`,
    framesInWindow: windowFrameCount,
    transcriptPath
  });

  if (verdict.outcome !== 'pass') {
    if (verdict.failureMode === 'llm-not-configured') {
      console.error('Configure a model/provider in ~/.hermes/config.yaml (credentials are user responsibility).');
    } else if (verdict.failureMode === 'empty-recall') {
      console.error('Tool ran but returned no content for the window — inspect the transcript and storage diagnostics.');
    } else if (verdict.failureMode === 'tool-call-failed') {
      console.error('Hermes did not call recall successfully — inspect the transcript.');
    }
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('e2e:live passed. Read the transcript to confirm the answer reflects what was on screen:');
  console.log(`  ${transcriptPath}`);
}

await main().catch(async (error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  await cleanup();
  process.exit(1);
});
