#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { detectHermes, HERMES_INSTALL_URL } from './hermes-detector.js';
import {
  applyServerEnvironmentOverrides,
  parseManagedServiceEnvironmentFromPlist,
  readServerConfig,
  resolveManagedServiceServer
} from './service-runtime-config.js';

const execFileAsync = promisify(execFile);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const appDirectory = join(homedir(), '.computer-history-mcp');
const installedPlistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.computer-history-mcp.plist');

/**
 * Loads the configured MCP server from the real app config and installed plist overrides.
 *
 * @returns {Promise<{ host: string, port: number }>}
 */
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

/**
 * Probes the MCP endpoint for liveness. Any HTTP response (including 401/406)
 * proves the service is listening. Only connection failures indicate "down".
 *
 * @param {string} host
 * @param {number} port
 * @returns {Promise<{ status: number, body: string }>}
 */
async function probeEndpoint(host, port) {
  const response = await fetch(`http://${host}:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'e2e-health', method: 'ping' })
  });

  return {
    status: response.status,
    body: await response.text()
  };
}

/**
 * Prints the structured Pass_Fail_Summary block to stdout.
 *
 * @param {{ outcome: string, hermesVersion: string, mcpEndpoint: string, toolExercised: string, failureMode: string, transcriptPath?: string }} summary
 */
function printPassFailSummary(summary) {
  console.log('');
  console.log('=== Pass_Fail_Summary ===');
  console.log(`outcome:        ${summary.outcome}`);
  console.log(`hermesVersion:  ${summary.hermesVersion}`);
  console.log(`mcpEndpoint:    ${summary.mcpEndpoint}`);
  console.log(`toolExercised:  ${summary.toolExercised}`);
  console.log(`failureMode:    ${summary.failureMode}`);
  if (summary.transcriptPath !== undefined) {
    console.log(`transcriptPath: ${summary.transcriptPath}`);
  }
  console.log('=========================');
}

async function main() {
  // ── Step 1: Detect Hermes ────────────────────────────────────────────────
  const detection = await detectHermes();

  if (!detection.present) {
    console.error('');
    console.error(`[hermes-missing] Hermes CLI is not available.`);
    console.error(`Install instructions: ${HERMES_INSTALL_URL}`);
    console.error(`npm run hermes:verify will not be runnable until 'hermes' is on PATH.`);

    printPassFailSummary({
      outcome: 'fail:hermes-missing',
      hermesVersion: 'absent',
      mcpEndpoint: 'unknown',
      toolExercised: 'internal-status',
      failureMode: 'hermes-missing'
    });

    process.exit(1);
  }

  const hermesVersion = detection.version;

  // ── Step 2: Load MCP endpoint from real config ──────────────────────────
  let server;
  try {
    server = await loadConfiguredServer();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('');
    console.error(`[mcp-service-down] Could not load MCP service configuration.`);
    console.error(`Check that ~/.computer-history-mcp/config.yaml exists and is valid YAML.`);
    console.error(`Detail: ${detail}`);
    console.error(`Next steps:`);
    console.error(`  npm run setup`);
    console.error(`  npm run service:status`);

    printPassFailSummary({
      outcome: 'fail:mcp-service-down',
      hermesVersion,
      mcpEndpoint: 'unknown',
      toolExercised: 'internal-status',
      failureMode: 'mcp-service-down'
    });

    process.exit(1);
  }

  const endpoint = `http://${server.host}:${server.port}/mcp`;

  if (server.host !== '127.0.0.1') {
    console.error('');
    console.error(`[mcp-service-down] Non-loopback host configuration error.`);
    console.error(`Resolved host: ${server.host} — expected 127.0.0.1.`);
    console.error(`The MCP service must be bound to 127.0.0.1. Check ~/.computer-history-mcp/config.yaml.`);

    printPassFailSummary({
      outcome: 'fail:mcp-service-down',
      hermesVersion,
      mcpEndpoint: endpoint,
      toolExercised: 'internal-status',
      failureMode: 'mcp-service-down'
    });

    process.exit(1);
  }

  // ── Step 3: Probe MCP endpoint ───────────────────────────────────────────
  try {
    await probeEndpoint(server.host, server.port);
  } catch (error) {
    console.error('');
    console.error(`[mcp-service-down] MCP service is not reachable at ${endpoint}.`);
    console.error(`Next steps:`);
    console.error(`  npm run service:start`);
    console.error(`  npm run service:status`);
    console.error(`  npm run service:logs`);

    printPassFailSummary({
      outcome: 'fail:mcp-service-down',
      hermesVersion,
      mcpEndpoint: endpoint,
      toolExercised: 'internal-status',
      failureMode: 'mcp-service-down'
    });

    process.exit(1);
  }
  // ── Step 4: Run Hermes chat against real config ──────────────────────────
  let chatTranscript = '';
  let chatError = null;

  try {
    const chatResult = await execFileAsync('hermes', [
      'chat',
      '--quiet',
      '--max-turns', '3',
      '--toolsets', 'computer-history-mcp',
      '--query', 'Use only the configured MCP server. Call internal-status and report the server mode and retrieval status.'
    ], {
      cwd: repositoryRoot,
      env: process.env,   // real HOME — no override
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024
    });
    chatTranscript = [chatResult.stdout, chatResult.stderr].filter(Boolean).join('\n');
  } catch (error) {
    chatError = error;
    const stdout = typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout ?? '') : '';
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr ?? '') : '';
    const message = error instanceof Error ? error.message : String(error);
    chatTranscript = [stdout, stderr, message].filter(Boolean).join('\n');
  }
  // ── Step 5: Classify failure mode from transcript ────────────────────────
  const transcriptLower = chatTranscript.toLowerCase();

  // Check for llm-not-configured first (before tool-call-failed)
  const LLM_NOT_CONFIGURED_SIGNALS = ['no model', 'provider not configured', 'model not set', 'no provider'];
  const isLlmNotConfigured = LLM_NOT_CONFIGURED_SIGNALS.some(signal => transcriptLower.includes(signal));

  // Check for evidence that internal-status was called. In verbose mode Hermes
  // emits "preparing mcp_computer_history_mcp_internal_status"; in --quiet mode the
  // tool name may appear shortened in reasoning. As a final fallback, check for
  // output fields unique to internal-status (recoveryStatus, checkpointExists)
  // which can only appear if the tool was actually called.
  const TOOL_MARKERS = [
    'preparing mcp_computer_history_mcp_internal_status',
    'mcp_computer_history_mcp_internal_status',
    'internal-status',
    'internal_status'
  ];
  const RESULT_EVIDENCE = ['recoveryStatus', 'checkpointExists'];
  const toolMarkerFound = TOOL_MARKERS.some(marker => chatTranscript.includes(marker))
    || RESULT_EVIDENCE.every(field => chatTranscript.includes(field));

  let outcome;
  let failureMode;
  let transcriptPath;

  if (isLlmNotConfigured) {
    outcome = 'fail:llm-not-configured';
    failureMode = 'llm-not-configured';
    console.error('');
    console.error('[llm-not-configured] Hermes has no working LLM provider configured.');
    console.error('Configure a model/provider in ~/.hermes/config.yaml.');
    console.error('Workspace LLM policy: use DeepSeek (https://api.deepseek.com) for examples.');
    console.error(`See upstream Hermes provider-configuration docs: ${HERMES_INSTALL_URL}`);
    console.error('The script does NOT write provider credentials — that is user responsibility.');
  } else if (toolMarkerFound && chatError === null) {
    // Only pass when the chat command exited successfully AND the tool marker is present.
    outcome = 'pass';
    failureMode = 'none';
  } else {
    outcome = 'fail:tool-call-failed';
    failureMode = 'tool-call-failed';
    // Write transcript to temp file for inspection
    const timestamp = Date.now();
    transcriptPath = join(tmpdir(), `hermes-e2e-transcript-${timestamp}.txt`);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(transcriptPath, chatTranscript, 'utf8');
    console.error('');
    console.error('[tool-call-failed] Hermes connected to the LLM and MCP service but did not call internal-status.');
    console.error(`Transcript saved to: ${transcriptPath}`);
    console.error('See https://xiaozhenliu.github.io/computer-history-mcp/guide/clients/hermes for the walkthrough and troubleshooting steps.');
    console.error('See https://xiaozhenliu.github.io/computer-history-mcp/guide/clients/generic-mcp for the tool surface.');
  }
  // ── Step 6: Print Pass_Fail_Summary and exit ─────────────────────────────
  printPassFailSummary({
    outcome,
    hermesVersion,
    mcpEndpoint: endpoint,
    toolExercised: 'internal-status',
    failureMode,
    ...(transcriptPath !== undefined ? { transcriptPath } : {})
  });

  if (outcome !== 'pass') {
    process.exit(1);
  }

  console.log('');
  console.log('hermes:verify passed.');
  console.log(`- endpoint: ${endpoint}`);
  console.log(`- hermes: ${hermesVersion}`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
