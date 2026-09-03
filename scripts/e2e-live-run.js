#!/usr/bin/env node
// scripts/e2e-live-run.js
//
// One-command live verification on this machine:
//   npm run e2e:live -- --duration 10m [--index-timeout 120s]
//
// Phase 0  preflight (build current source, hermes CLI, app config, args)
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
const appDirectory = join(homedir(), '.computer-history-mcp');
const installedPlistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.computer-history-mcp.plist');

const SCREENPIPE_BASE_URL = 'http://localhost:3030';
const BUILD_TIMEOUT_MS = 180_000;
const SCREENPIPE_START_TIMEOUT_MS = 60_000;
const MCP_START_TIMEOUT_MS = 60_000;
const PROGRESS_INTERVAL_MS = 30_000;
const INDEX_POLL_INTERVAL_MS = 10_000;

const state = {
  screenpipeChild: null,
  startedScreenpipe: false,
  startedMcpService: false
};

let screenpipeSettings = { baseUrl: SCREENPIPE_BASE_URL, apiKey: undefined };

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

function buildScreenpipeHeaders() {
  return screenpipeSettings.apiKey !== undefined
    ? { authorization: `Bearer ${screenpipeSettings.apiKey}` }
    : {};
}

async function isScreenpipeHealthy() {
  try {
    const response = await fetch(`${screenpipeSettings.baseUrl}/health`, { headers: buildScreenpipeHeaders(), signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function countFramesSince(startIso, endIso) {
  const url = new URL(`${screenpipeSettings.baseUrl}/search`);
  url.searchParams.set('limit', '1');
  url.searchParams.set('start_time', startIso);
  if (endIso !== undefined) {
    url.searchParams.set('end_time', endIso);
  }
  try {
    const response = await fetch(url, { headers: buildScreenpipeHeaders(), signal: AbortSignal.timeout(10_000) });
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

async function loadScreenpipeSettings() {
  const configPath = join(appDirectory, 'config.yaml');
  const { default: YAML } = await import('yaml');
  const raw = YAML.parse(await readFile(configPath, 'utf8')) ?? {};
  const screenpipe = raw?.screenpipe ?? {};
  return {
    baseUrl: typeof screenpipe.url === 'string' && screenpipe.url.length > 0 ? screenpipe.url : SCREENPIPE_BASE_URL,
    apiKey: typeof screenpipe.apiKey === 'string' && screenpipe.apiKey.length > 0 ? screenpipe.apiKey : undefined
  };
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
        accept: 'application/json, text/event-stream',
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

/**
 * Ground-truth retrieval probe over the recorded window.
 *
 * Calls the `recall` tool directly (session granularity) so the harness has
 * an objective count of how much of the window is actually retrievable,
 * independent of how the hermes agent phrases its answer or whether it falls
 * back to other tools' metadata. `recall` is used rather than `find` because
 * it is query-independent — a `find` keyword returning zero does not prove
 * the window is empty, whereas a session count is a direct measure.
 *
 * Returns `{ ok, recallSessions }`. `ok` is false when the probe itself could
 * not run (connection/tool error); callers must treat `ok === false` as
 * "no ground truth available" and fall back to transcript heuristics rather
 * than as an empty window.
 */
async function probeRetrieval(server, fromIso, toIso) {
  const client = new Client({ name: 'e2e-live-run-probe', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${server.host}:${server.port}/mcp`),
    server.authToken !== undefined
      ? { authProvider: { token: async () => server.authToken } }
      : undefined
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'recall',
      arguments: { from: fromIso, to: toIso, granularity: 'session', includeSummary: false }
    });
    const text = result?.content?.find((entry) => entry.type === 'text')?.text;
    if (result?.isError === true) {
      // The recall tool itself errored (e.g. output-schema validation). That
      // is a real failure, not "no ground truth" — report it as a failed probe
      // with the detail so it is not silently swallowed.
      const detail = typeof text === 'string' ? text.slice(0, 200) : 'unknown error';
      console.warn(`[phase5] retrieval probe: recall returned an error result: ${detail}`);
      return { ok: false, recallSessions: null };
    }
    const parsed = result?.structuredContent ?? (typeof text === 'string' ? JSON.parse(text) : null);
    const recallSessions = Array.isArray(parsed?.sessions) ? parsed.sessions.length : 0;
    // `hasContent` is what classifyHermesOutcome gates on; derive it here so a
    // non-empty window is recognised as a pass (and an empty one as a fail).
    return { ok: true, recallSessions, hasContent: recallSessions > 0 };
  } catch (error) {
    console.warn(`[phase5] retrieval probe failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, recallSessions: null };
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
      'Run first: npm start'
    ]);
    return;
  }

  log('phase0', `duration=${options.durationMs / 1_000}s indexTimeout=${options.indexTimeoutMs / 1_000}s hermes=${hermesVersion}`);

  // Build the current source before anything runs the service. `service:start`
  // launches the prebuilt `dist/` entrypoint and never rebuilds, so without
  // this step e2e:live can validate a stale build — silently defeating the
  // point of a live end-to-end check (the harness would "pass" code that is
  // not what is on disk). Building here guarantees a service WE start reflects
  // HEAD; the reuse branch in phase 2 warns when it cannot make that promise.
  log('phase0', 'Building current source (npm run build) so the service under test reflects HEAD.');
  try {
    await execFileAsync('npm', ['run', 'build'], { cwd: repositoryRoot, timeout: BUILD_TIMEOUT_MS });
  } catch (error) {
    fail('build-failed', { hermesVersion }, [
      `npm run build failed: ${error instanceof Error ? error.message : String(error)}`,
      'Fix the TypeScript build before running e2e:live.'
    ]);
    return;
  }

  screenpipeSettings = await loadScreenpipeSettings();

  // Phase 1: Screenpipe (hybrid start)
  if (await isScreenpipeHealthy()) {
    log('phase1', `Reusing already-healthy Screenpipe at ${screenpipeSettings.baseUrl} (will NOT stop it on exit).`);
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
        'See https://xiaozhenliu.github.io/computer-history-mcp/guide/quickstart (Step 1).'
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
    // The phase-0 build refreshed dist/ on disk, but an already-running
    // service loaded its code into memory at its own start time — we cannot
    // prove it is the freshly-built code. Surface this so a "pass" against a
    // stale reused service is never mistaken for validation of HEAD.
    console.warn('[phase2] WARNING: reusing an already-running MCP service; e2e:live cannot guarantee it runs the just-built code. For a guaranteed-fresh run, stop it first: npm run service:stop.');
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

  // Phase 4: conditional index readiness wait
  log('phase4', `Waiting for index readiness (poll ${INDEX_POLL_INTERVAL_MS / 1_000}s, timeout ${options.indexTimeoutMs / 1_000}s).`);
  const indexDeadline = Date.now() + options.indexTimeoutMs;
  const indexWaitStart = Date.now();
  let previousWindowCount = 0;
  let indexReady = false;
  let lastWatermark = null;
  let lastWindowCount = windowFrameCount ?? 0;
  while (Date.now() < indexDeadline) {
    const [watermark, currentWindowCount] = await Promise.all([
      readExtractionWatermark(server),
      countFramesSince(recordStartIso, recordEndIso)
    ]);
    lastWatermark = watermark;
    lastWindowCount = currentWindowCount ?? lastWindowCount;
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
    if (lastWindowCount === 0) {
      fail('no-frames-captured', {
        hermesVersion,
        mcpEndpoint: endpoint,
        recordWindow: `${recordStartIso} .. ${recordEndIso}`
      }, [
        'No frames from the recording window became searchable before the index timeout.',
        'Common causes: macOS Screen Recording permission missing, or the screen was locked during the window (Screenpipe pauses capture while locked).',
        'See https://xiaozhenliu.github.io/computer-history-mcp/guide/troubleshooting for diagnosis.'
      ]);
    } else {
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
    }
    await cleanup();
    return;
  }

  // Phase 5: ground-truth retrieval probe + hermes content verification.
  // The probe runs first so the harness has an objective measure of window
  // retrievability before — and independent of — the model's narrative.
  const retrievalProbe = await probeRetrieval(server, recordStartIso, recordEndIso);
  if (retrievalProbe.ok) {
    log('phase5', `retrieval probe: recall.sessions=${retrievalProbe.recallSessions} over the recorded window.`);
  } else {
    log('phase5', 'retrieval probe could not run; falling back to transcript heuristics for pass/fail.');
  }

  const query = `调用 recall（from=${recordStartIso}，to=${recordEndIso}，granularity 自选）查询这段时间的屏幕活动；如果 recall 没有返回会话，就改用 find 在同一时间窗内检索屏幕内容。最后总结这段时间屏幕上实际出现的内容，引用具体的应用或文本。`;
  log('phase5', 'Running hermes chat content verification.');
  let chatTranscript = '';
  let chatFailed = false;
  try {
    const chatResult = await execFileAsync('hermes', [
      'chat',
      '--max-turns', '5',
      '--toolsets', 'computer-history-mcp',
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

  const verdict = classifyHermesOutcome({ transcript: chatTranscript, chatFailed, retrievalProbe });

  // Phase 6: cleanup + summary
  await cleanup();

  printPassFailSummary({
    outcome: verdict.outcome,
    failureMode: verdict.failureMode,
    hermesVersion,
    mcpEndpoint: endpoint,
    recordWindow: `${recordStartIso} .. ${recordEndIso}`,
    framesInWindow: lastWindowCount,
    // Ground-truth retrieval count over the window (independent of the model's
    // narrative); 'probe-failed' means the harness could not measure it.
    recallSessionsInWindow: retrievalProbe.ok ? retrievalProbe.recallSessions : 'probe-failed',
    transcriptPath
  });

  if (verdict.outcome !== 'pass') {
    if (verdict.failureMode === 'llm-not-configured') {
      console.error('Configure a model/provider in ~/.hermes/config.yaml (credentials are user responsibility).');
    } else if (verdict.failureMode === 'empty-recall') {
      console.error('recall returned no sessions for the recorded window (see recallSessionsInWindow above) — the window was captured but is not retrievable. Inspect the indexer/embedding health: npm run service:logs / npm run storage:diagnostics.');
    } else if (verdict.failureMode === 'tool-call-failed') {
      console.error('Hermes did not call recall/find successfully — inspect the transcript.');
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
