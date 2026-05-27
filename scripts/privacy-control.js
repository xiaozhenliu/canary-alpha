#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import YAML from 'yaml';

import { getPackageVersion } from './version.js';

const execFileAsync = promisify(execFile);
const APP_DIRECTORY_NAME = '.canary-alpha-mcp';
const CONFIG_FILE_NAME = 'config.yaml';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const HOTSPOT_LIMIT = 2;
const ALLOWED_DELETE_RANGES = new Set(['last_1h', 'last_1d', 'all']);
const SUPPORTED_ACTIONS = new Set(['status', 'pause', 'resume', 'exclude-app', 'delete-range']);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  return [
    'Usage:',
    '  npm run privacy-control -- status',
    '  npm run privacy-control -- pause',
    '  npm run privacy-control -- resume',
    '  npm run privacy-control -- exclude-app --app <name> [--rebuild]',
    '  npm run privacy-control -- delete-range --range <last_1h|last_1d|all> --confirm'
  ].join('\n');
}

function createClient() {
  return new Client({
    name: 'canary-alpha-mcp-privacy-control-cli',
    version: getPackageVersion()
  });
}

async function loadServerConfig() {
  const configPath = join(homedir(), APP_DIRECTORY_NAME, CONFIG_FILE_NAME);

  try {
    const raw = YAML.parse(await readFile(configPath, 'utf8')) ?? {};
    const server = raw?.server;
    return {
      host: typeof server?.host === 'string' && server.host.length > 0 ? server.host : DEFAULT_HOST,
      port: Number.isInteger(server?.port) && server.port > 0 ? server.port : DEFAULT_PORT
    };
  } catch (error) {
    const nodeError = error;
    if (nodeError && typeof nodeError === 'object' && 'code' in nodeError && nodeError.code === 'ENOENT') {
      return { host: DEFAULT_HOST, port: DEFAULT_PORT };
    }

    throw error;
  }
}

function toNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function formatCommandFailure(error) {
  if (error && typeof error === 'object') {
    const nodeError = error;
    const stderr = toNonEmptyString(typeof nodeError.stderr === 'string' ? nodeError.stderr.trim() : undefined);
    if (stderr) {
      return stderr;
    }

    const stdout = toNonEmptyString(typeof nodeError.stdout === 'string' ? nodeError.stdout.trim() : undefined);
    if (stdout) {
      return stdout;
    }
  }

  return error instanceof Error ? error.message : String(error);
}

function toToolArguments(parsed) {
  if (parsed.action === 'exclude-app') {
    return {
      action: parsed.action,
      appName: parsed.appName
    };
  }

  if (parsed.action === 'delete-range') {
    return {
      action: parsed.action,
      range: parsed.range,
      confirm: parsed.confirm
    };
  }

  return {
    action: parsed.action
  };
}

async function runNpmScript(scriptName) {
  await execFileAsync('npm', ['run', '--silent', scriptName], {
    cwd: repositoryRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });
}

async function runRebuildWorkflow(summary) {
  try {
    await runNpmScript('service:stop');
  } catch (error) {
    throw new Error(`${summary}\nManaged service stop failed: ${formatCommandFailure(error)}`);
  }

  let rebuildError;

  try {
    await runNpmScript('rebuild-index');
  } catch (error) {
    rebuildError = formatCommandFailure(error);
  }

  try {
    await runNpmScript('service:start');
  } catch (error) {
    const restartError = formatCommandFailure(error);
    if (rebuildError) {
      throw new Error(`${summary}\nRebuild failed: ${rebuildError}\nManaged service restart failed: ${restartError}`);
    }

    throw new Error(`${summary}\nRebuild completed, but managed service restart failed: ${restartError}`);
  }

  if (rebuildError) {
    throw new Error(`${summary}\nRebuild failed: ${rebuildError}`);
  }

  return `${summary}\nRebuild complete.`;
}

export function parseArgs(argv) {
  const [action, ...rest] = argv;

  if (!action || !SUPPORTED_ACTIONS.has(action)) {
    throw new Error(usage());
  }

  if (action === 'status' || action === 'pause' || action === 'resume') {
    if (rest.length > 0) {
      throw new Error(usage());
    }

    return { action };
  }

  if (action === 'delete-range') {
    let range;
    let confirm = false;

    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === '--range') {
        range = rest[index + 1];
        index += 1;
        continue;
      }

      if (token === '--confirm') {
        confirm = true;
        continue;
      }

      throw new Error(usage());
    }

    if (range === undefined) {
      throw new Error('Usage: npm run privacy-control -- delete-range --range <last_1h|last_1d|all> --confirm');
    }

    if (!ALLOWED_DELETE_RANGES.has(range)) {
      throw new Error(`Unsupported delete range: ${range}.`);
    }

    return {
      action: 'delete-range',
      range,
      confirm
    };
  }

  let appName;
  let rebuild = false;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--app') {
      appName = rest[index + 1];
      index += 1;
      continue;
    }

    if (token === '--rebuild') {
      rebuild = true;
      continue;
    }

    throw new Error(usage());
  }

  if (appName === undefined) {
    throw new Error('Usage: npm run privacy-control -- exclude-app --app <name> [--rebuild]');
  }

  return {
    action: 'exclude-app',
    appName,
    rebuild
  };
}

function summarizeHotspotEntries(items, formatter) {
  if (!Array.isArray(items) || items.length === 0) {
    return 'none';
  }

  return items
    .slice(0, HOTSPOT_LIMIT)
    .map(formatter)
    .join('; ');
}

function formatStatusHotspots(structured) {
  const hotspots = structured?.screenpipeStorage?.hotspots;
  if (!hotspots || typeof hotspots !== 'object') {
    return [];
  }

  const inspectionStatus = typeof hotspots.inspectionStatus === 'string'
    ? hotspots.inspectionStatus
    : 'unavailable';

  if (inspectionStatus !== 'ready') {
    const reason = toNonEmptyString(hotspots.reason);
    return [`Plaintext hotspots: ${reason ? `${inspectionStatus} (${reason})` : inspectionStatus}`];
  }

  const dominantFields = summarizeHotspotEntries(
    hotspots.dominantFields,
    (field) => `${field.key} (${field.estimatedBytes}B)`
  );
  const dominantApps = summarizeHotspotEntries(
    hotspots.dominantApps,
    (app) => `${app.appName} (${app.estimatedBytes}B)`
  );

  return [
    `Plaintext hotspots: ${inspectionStatus}`,
    `Hotspot fields: ${dominantFields}`,
    `Hotspot apps: ${dominantApps}`
  ];
}

function formatDeleteRangeResult(structured) {
  const requestedRange = toNonEmptyString(structured.requestedRange) ?? 'requested range';

  if (structured.error?.code === 'PRIVACY_CONFIRM_REQUIRED') {
    return `Delete range (${requestedRange}) requires confirmation. Re-run with --confirm.`;
  }

  if (structured.error?.code === 'PRIVACY_DELETE_UNAVAILABLE') {
    return `Delete range (${requestedRange}) is unavailable in the current backend.`;
  }

  if (structured.confirmed === true) {
    return `Delete range applied: ${requestedRange}.`;
  }

  return `Delete range requested: ${requestedRange}.`;
}

export function formatResult(result) {
  const structured = result?.structuredContent;
  if (!structured || typeof structured !== 'object') {
    return 'Privacy control request completed.';
  }

  const paused = structured.paused === true;
  const excludedApps = Array.isArray(structured.excludedApps)
    ? structured.excludedApps.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : [];

  switch (structured.action) {
    case 'status':
      return [
        `Paused: ${paused ? 'yes' : 'no'}`,
        `Excluded apps: ${excludedApps.length > 0 ? excludedApps.join(', ') : 'none'}`,
        ...formatStatusHotspots(structured)
      ].join('\n');
    case 'pause':
      return paused ? 'Collection paused.' : 'Collection pause request applied.';
    case 'resume':
      return paused ? 'Collection resume request applied.' : 'Collection resumed.';
    case 'exclude-app': {
      const excludedApp = toNonEmptyString(excludedApps.at(-1));
      return excludedApp ? `Excluded app: ${excludedApp}` : 'Excluded app updated.';
    }
    case 'delete-range':
      return formatDeleteRangeResult(structured);
    default:
      return 'Privacy control request completed.';
  }
}

export function formatError(result) {
  const structured = result?.structuredContent;
  if (structured && typeof structured === 'object' && structured.error && typeof structured.error === 'object') {
    if (structured.action === 'delete-range') {
      return formatDeleteRangeResult(structured);
    }

    const message = toNonEmptyString(structured.error.message);
    if (message) {
      return message;
    }
  }

  const content = Array.isArray(result?.content) ? result.content : [];
  const textPart = content.find((entry) => entry && typeof entry === 'object' && entry.type === 'text' && typeof entry.text === 'string');
  return toNonEmptyString(textPart?.text) ?? 'Privacy control request failed.';
}

export async function run(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const configuredServer = await loadServerConfig();
  const host = DEFAULT_HOST;
  const requestedPort = Number(process.env.MCP_PORT);
  const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : configuredServer.port;
  const client = createClient();
  const transport = new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`));

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'privacy-control',
      arguments: toToolArguments(parsed)
    });

    if (result.isError) {
      fail(formatError(result));
    }

    const summary = formatResult(result);
    if (parsed.action === 'exclude-app' && parsed.rebuild) {
      console.log(await runRebuildWorkflow(summary));
      return;
    }

    console.log(summary);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
