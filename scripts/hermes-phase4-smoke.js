#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import YAML from 'yaml';

import { applyServerEnvironmentOverrides, parseManagedServiceEnvironmentFromPlist, readServerConfig, resolveManagedServiceServer } from './service-runtime-config.js';
import { PHASE4_TOOL_INCLUDES } from './hermes-tool-includes.js';
import { detectHermes } from './hermes-detector.js';
import { testTempRoot } from './test-tmp.js';

const execFileAsync = promisify(execFile);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const evidenceDirectory = join(repositoryRoot, '.planning', 'phases', '04-delivery-setup-recovery', 'evidence', 'hermes');
const appDirectory = join(homedir(), '.computer-history-mcp');
const installedPlistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.computer-history-mcp.plist');
const configPath = join(appDirectory, 'config.yaml');
const hermesCommand = 'hermes';
const hermesServerName = 'computer-history-mcp-phase4';

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
}

async function writeEvidenceFile(fileName, content) {
  await ensureDirectory(evidenceDirectory);
  await writeFile(join(evidenceDirectory, fileName), content, 'utf8');
}

async function loadConfiguredServer() {
  const raw = YAML.parse(await readFile(configPath, 'utf8')) ?? {};
  const parsedServer = readServerConfig(raw, configPath);
  const managedEnvironment = existsSync(installedPlistPath)
    ? parseManagedServiceEnvironmentFromPlist(await readFile(installedPlistPath, 'utf8'))
    : {};
  const configuredServer = applyServerEnvironmentOverrides(parsedServer, managedEnvironment);
  return resolveManagedServiceServer(configuredServer, managedEnvironment);
}

async function probeEndpoint(host, port) {
  const response = await fetch(`http://${host}:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'phase4-health', method: 'ping' })
  });

  return {
    status: response.status,
    body: await response.text()
  };
}

async function runHermes(args, options = {}) {
  return execFileAsync(hermesCommand, args, {
    cwd: repositoryRoot,
    env: options.env ?? process.env,
    timeout: options.timeout ?? 120_000,
    maxBuffer: 10 * 1024 * 1024
  });
}

function buildIsolatedHermesConfig(endpoint) {
  return YAML.stringify({
    model: '',
    provider: 'auto',
    mcp_servers: {
      [hermesServerName]: {
        url: endpoint,
        enabled: true,
        tools: {
          include: [...PHASE4_TOOL_INCLUDES]
        }
      }
    }
  });
}

async function createIsolatedHermesHome(endpoint) {
  const tempHome = await mkdtemp(join(testTempRoot(), 'computer-history-mcp-hermes-'));
  await ensureDirectory(join(tempHome, '.hermes'));
  await writeFile(join(tempHome, '.hermes', 'config.yaml'), buildIsolatedHermesConfig(endpoint), 'utf8');
  return tempHome;
}

async function main() {
  await ensureDirectory(evidenceDirectory);

  if (!existsSync(configPath)) {
    fail(`Missing config file at ${configPath}. Run npm run setup first.`);
  }

  const detectionResult = await detectHermes();
  if (!detectionResult.present) {
    throw new Error(`Hermes CLI is not available. Install or expose 'hermes' on PATH before running this smoke gate. See ${detectionResult.installGuidanceUrl}`);
  }
  const hermesVersion = detectionResult.version;
  const server = await loadConfiguredServer();
  const endpoint = `http://${server.host}:${server.port}/mcp`;

  if (server.host !== '127.0.0.1') {
    fail(`Refusing Hermes Phase 4 smoke against non-local host ${server.host}. Expected 127.0.0.1.`);
  }

  const endpointProbe = await probeEndpoint(server.host, server.port).catch((error) => {
    throw new Error(`HTTP service is not reachable at ${endpoint}. Start it with npm run service:start (or npm run dev:http for local debugging). ${error instanceof Error ? error.message : String(error)}`);
  });

  await writeEvidenceFile('endpoint-probe.json', `${JSON.stringify({ endpoint, probe: endpointProbe }, null, 2)}\n`);

  const isolatedHome = await createIsolatedHermesHome(endpoint);
  const hermesEnv = {
    ...process.env,
    HOME: isolatedHome
  };

  try {
    await writeEvidenceFile('hermes-config.yaml', await readFile(join(isolatedHome, '.hermes', 'config.yaml'), 'utf8'));

    const listResult = await runHermes(['mcp', 'list'], { env: hermesEnv });
    await writeEvidenceFile('hermes-mcp-list.txt', listResult.stdout || listResult.stderr || '');

    const testResult = await runHermes(['mcp', 'test', hermesServerName], { env: hermesEnv });
    await writeEvidenceFile('hermes-mcp-test.txt', [testResult.stdout, testResult.stderr].filter(Boolean).join('\n'));

    let statusResult = '';
    let statusError = '';
    try {
      const result = await runHermes(['status', '--all'], { env: hermesEnv });
      statusResult = [result.stdout, result.stderr].filter(Boolean).join('\n');
    } catch (error) {
      statusError = error instanceof Error ? error.message : String(error);
    }
    await writeEvidenceFile('hermes-status.txt', `${statusResult}${statusError ? `\n${statusError}\n` : ''}`);

    let chatOutcome = 'skipped';
    let chatTranscript = '';
    try {
      const chat = await runHermes([
        'chat',
        '--quiet',
        '--max-turns',
        '3',
        '--toolsets',
        hermesServerName,
        '--query',
        'Use the configured MCP server only. First confirm internal-status, then call recall over the last 10 minutes with granularity session and includeSummary false (use to = the current time and from = ten minutes before that), and report the returned session ids.'
      ], {
        env: hermesEnv,
        timeout: 180_000
      });
      chatOutcome = 'passed';
      chatTranscript = [chat.stdout, chat.stderr].filter(Boolean).join('\n');
    } catch (error) {
      chatOutcome = 'blocked';
      const stdout = typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout ?? '') : '';
      const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr ?? '') : '';
      const message = error instanceof Error ? error.message : String(error);
      chatTranscript = [stdout, stderr, message].filter(Boolean).join('\n');
    }
    await writeEvidenceFile('hermes-chat.txt', `${chatTranscript}\n`);

    const summary = {
      hermesVersion,
      endpoint,
      mcpListCaptured: true,
      mcpTestCaptured: true,
      chatOutcome,
      evidenceDirectory
    };
    await writeEvidenceFile('SUMMARY.json', `${JSON.stringify(summary, null, 2)}\n`);

    if (chatOutcome !== 'passed') {
      fail(`Hermes MCP connectivity passed at ${endpoint}, but the bounded chat scenario could not complete in this environment. Check ${join(evidenceDirectory, 'hermes-chat.txt')} and configure a working Hermes model/provider if you want full real-agent proof.`);
    }
  } finally {
    await rm(isolatedHome, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log('Hermes Phase 4 smoke passed.');
  console.log(`- endpoint: ${endpoint}`);
  console.log(`- evidence: ${evidenceDirectory}`);
}

await main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
