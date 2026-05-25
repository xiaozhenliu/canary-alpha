#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import readline from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import YAML from 'yaml';

import {
  backupConfigIfPresent,
  createHostedEmbeddingsConfig,
  createOllamaEmbeddingsConfig,
  DEFAULT_HOSTED_BASE_URL,
  DEFAULT_HOSTED_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_SCREENPIPE_URL,
  ensureAppDirectories,
  ensureDependenciesInstalled,
  ensureSupportedNodeVersion,
  resolveAppPaths,
  resolveHermesPaths,
  writeConfigYamlFile,
  writeHermesConfigFile
} from './onboarding-config.js';

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const paths = resolveAppPaths();
const serviceStartScript = new URL('./service-start.js', import.meta.url);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function createClient() {
  return new Client({
    name: 'canary-alpha-mcp-onboard',
    version: '1.0.0'
  });
}

function buildJsonHeaders(apiKey) {
  return {
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  };
}

function buildScreenpipeUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function probeJson(url, options = {}) {
  try {
    const response = await fetch(url, options);
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text()
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function probeScreenpipeHealth(baseUrl, apiKey) {
  return probeJson(buildScreenpipeUrl(baseUrl, 'health'), {
    headers: buildJsonHeaders(apiKey)
  });
}

async function probeScreenpipeSearch(baseUrl, apiKey) {
  const url = new URL(buildScreenpipeUrl(baseUrl, 'search'));
  url.searchParams.set('content_type', 'ocr');
  url.searchParams.set('limit', '1');
  url.searchParams.set('offset', '0');

  return probeJson(url.toString(), {
    headers: buildJsonHeaders(apiKey)
  });
}

async function probeOllama(baseUrl) {
  const modelsUrl = new URL('models', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
  return probeJson(modelsUrl);
}

export function summarizeOllamaModelProbe(probe, model) {
  if (!probe.ok) {
    return {
      available: false,
      reason: 'unreachable'
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(probe.body);
  } catch {
    return {
      available: false,
      reason: `Ollama responded, but ${model} could not be verified because /api/models returned invalid JSON.`
    };
  }

  const models = Array.isArray(parsed?.data)
    ? parsed.data
    : Array.isArray(parsed?.models)
      ? parsed.models
      : [];
  const modelNames = models
    .map((entry) => typeof entry?.id === 'string' ? entry.id : entry?.name)
    .filter((value) => typeof value === 'string');

  if (modelNames.includes(model)) {
    return {
      available: true,
      reason: 'available'
    };
  }

  return {
    available: false,
    reason: `Ollama is reachable at ${DEFAULT_OLLAMA_BASE_URL}, but embedding model ${model} is not installed. Install it with \`ollama pull ${model}\` or choose hosted embeddings.`
  };
}

async function ask(question, fallback = '') {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim();
    return answer.length > 0 ? answer : fallback;
  } finally {
    rl.close();
  }
}

export async function askSecret(question, fallback = '', options = {}) {
  const visiblePrompt = options.visiblePrompt ?? ask;
  const inputIsTTY = options.inputIsTTY ?? input.isTTY;
  const outputIsTTY = options.outputIsTTY ?? output.isTTY;

  if (!inputIsTTY || !outputIsTTY) {
    return visiblePrompt(question, fallback);
  }

  return new Promise((resolve, reject) => {
    const mutableOutput = {
      muted: false,
      write(chunk) {
        if (!this.muted) {
          output.write(chunk);
        }
      }
    };
    const rl = readline.createInterface({
      input,
      output: mutableOutput,
      terminal: true
    });

    output.write(question);
    mutableOutput.muted = true;

    rl.question('', (answer) => {
      mutableOutput.muted = false;
      output.write('\n');
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed.length > 0 ? trimmed : fallback);
    });

    rl.on('SIGINT', () => {
      mutableOutput.muted = false;
      output.write('\n');
      rl.close();
      reject(new Error('Input cancelled.'));
    });

    rl.on('close', () => {
      mutableOutput.muted = false;
    });
  });
}

async function askForHostedEmbeddings() {
  const apiKey = await askSecret('Embedding API key: ');
  if (!apiKey) {
    throw new Error('Hosted embeddings require an API key.');
  }

  const baseUrl = await ask(`Embedding base URL [${DEFAULT_HOSTED_BASE_URL}]: `, DEFAULT_HOSTED_BASE_URL);
  const model = await ask(`Embedding model [${DEFAULT_HOSTED_MODEL}]: `, DEFAULT_HOSTED_MODEL);

  return createHostedEmbeddingsConfig({
    baseUrl,
    model,
    apiKey
  });
}

async function chooseEmbeddings(screenpipeUrl) {
  const ollamaProbe = await probeOllama(DEFAULT_OLLAMA_BASE_URL);
  const modelProbe = summarizeOllamaModelProbe(ollamaProbe, DEFAULT_OLLAMA_MODEL);
  if (modelProbe.available) {
    console.log(`- Ollama reachable at ${DEFAULT_OLLAMA_BASE_URL}; using local model ${DEFAULT_OLLAMA_MODEL}.`);
    return {
      embeddings: createOllamaEmbeddingsConfig(),
      providerSummary: `ollama (${DEFAULT_OLLAMA_MODEL})`
    };
  }

  if (modelProbe.reason !== 'unreachable') {
    console.log(`- ${modelProbe.reason}`);
  } else {
    console.log(`- Ollama not reachable at ${DEFAULT_OLLAMA_BASE_URL}; falling back to hosted embeddings.`);
  }
  console.log(`  Screenpipe probe succeeded at ${screenpipeUrl}; hosted embedding fields will be requested.`);

  const embeddings = await askForHostedEmbeddings();
  return {
    embeddings,
    providerSummary: `${embeddings.kind} (${embeddings.model})`
  };
}

export async function detectScreenpipeApiKey() {
  try {
    const result = await execFileAsync('npx', ['screenpipe@latest', 'auth', 'token'], {
      cwd: repositoryRoot,
      env: process.env,
      maxBuffer: 1024 * 1024
    });
    const token = result.stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export async function resolveScreenpipeConnection(baseUrl) {
  const healthProbe = await probeScreenpipeHealth(baseUrl);
  if (!healthProbe.ok && healthProbe.status !== 403) {
    const detail = 'error' in healthProbe
      ? healthProbe.error
      : `HTTP ${healthProbe.status}`;
    fail(`Screenpipe is not reachable at ${baseUrl}. Start your local Screenpipe service first, then re-run npm run onboard. Use npm run screenpipe:safe-record for the repo-supported terminal path. (${detail})`);
  }

  const anonymousSearchProbe = await probeScreenpipeSearch(baseUrl);
  if (anonymousSearchProbe.ok) {
    return {
      apiKey: undefined,
      authSummary: 'disabled'
    };
  }

  if (anonymousSearchProbe.status !== 403) {
    fail(`Screenpipe responded at ${baseUrl}, but the search probe failed. Expected the local search API at /search to be available. (HTTP ${anonymousSearchProbe.status ?? 'unknown'})`);
  }

  const detectedApiKey = await detectScreenpipeApiKey();
  const apiKey = detectedApiKey ?? await ask('Screenpipe API token: ');
  if (!apiKey) {
    fail('Screenpipe authentication is enabled, but no API token was provided. Re-run npm run onboard and enter a valid token.');
  }

  const authenticatedSearchProbe = await probeScreenpipeSearch(baseUrl, apiKey);
  if (!authenticatedSearchProbe.ok) {
    fail(`Screenpipe authentication is enabled, but the supplied token did not pass the /search probe at ${baseUrl}. (HTTP ${authenticatedSearchProbe.status ?? 'unknown'})`);
  }

  return {
    apiKey,
    authSummary: detectedApiKey ? 'enabled (auto-detected token)' : 'enabled (prompted token)'
  };
}

async function runBuildIfNeeded() {
  console.log('\nBuilding the project...');
  await execFileAsync('npm', ['run', 'build'], {
    cwd: repositoryRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
    stdio: 'inherit'
  });
}

async function startManagedService() {
  console.log('\nStarting the managed HTTP service...');
  await execFileAsync(process.execPath, [fileURLToPath(serviceStartScript)], {
    cwd: repositoryRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });
}

export function createSearchScreenWindow(now = new Date()) {
  const to = now.toISOString();
  const from = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

  return { from, to };
}

export function summarizeRecentActivityValidation(structuredContent) {
  const raw = Array.isArray(structuredContent?.raw) ? structuredContent.raw : [];

  return {
    resultCount: raw.length,
    itemIds: raw.map((item) => item.id).filter((value) => typeof value === 'string')
  };
}

export function summarizeSearchScreenValidation(structuredContent) {
  const evidence = Array.isArray(structuredContent?.evidence) ? structuredContent.evidence : [];
  const itemIds = evidence.map((item) => item.id).filter((value) => typeof value === 'string');
  const degradedReason = typeof structuredContent?.degraded?.reason === 'string'
    ? structuredContent.degraded.reason
    : undefined;
  const fallbackMode = typeof structuredContent?.degraded?.fallbackMode === 'string'
    ? structuredContent.degraded.fallbackMode
    : undefined;
  const errorMessage = typeof structuredContent?.error?.message === 'string'
    ? structuredContent.error.message
    : undefined;
  const status = errorMessage
    ?? degradedReason
    ?? (fallbackMode ? `fallback: ${fallbackMode}` : undefined)
    ?? 'ok';

  return {
    searchResultCount: evidence.length,
    searchItemIds: itemIds,
    searchStatus: status
  };
}

export async function runValidationToolCalls(client, now = new Date()) {
  const statusResult = await client.callTool({
    name: 'internal-status',
    arguments: {}
  });
  const recentResult = await client.callTool({
    name: 'recent-activity',
    arguments: {
      minutes: 10,
      format: 'raw'
    }
  });
  const searchWindow = createSearchScreenWindow(now);
  const searchResult = await client.callTool({
    name: 'search-screen',
    arguments: {
      query: 'screenpipe',
      mode: 'keyword',
      from: searchWindow.from,
      to: searchWindow.to
    }
  });

  return {
    status: statusResult.structuredContent,
    ...summarizeRecentActivityValidation(recentResult.structuredContent),
    ...summarizeSearchScreenValidation(searchResult.structuredContent)
  };
}

async function runFirstValidation(configPath) {
  const parsed = YAML.parse(await readFile(configPath, 'utf8')) ?? {};
  const host = parsed?.server?.host ?? '127.0.0.1';
  const port = parsed?.server?.port ?? 18765;
  const endpoint = `http://${host}:${port}/mcp`;
  const client = createClient();
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));

  try {
    await client.connect(transport);
    const validation = await runValidationToolCalls(client);

    return {
      endpoint,
      ...validation
    };
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}


async function main() {
  ensureSupportedNodeVersion();
  console.log('canary-alpha-mcp onboarding');
  console.log('================================');

  const installedDependencies = ensureDependenciesInstalled(repositoryRoot);
  await ensureAppDirectories(paths);

  const screenpipe = await resolveScreenpipeConnection(DEFAULT_SCREENPIPE_URL);

  console.log(`- Screenpipe reachable at ${DEFAULT_SCREENPIPE_URL}.`);
  console.log(`- Screenpipe auth: ${screenpipe.authSummary}.`);
  console.log(`- Dependencies: ${installedDependencies ? 'installed with npm install' : 'already present'}.`);

  const { embeddings, providerSummary } = await chooseEmbeddings(DEFAULT_SCREENPIPE_URL);
  const backupPath = await backupConfigIfPresent(paths.configPath, paths.appDirectory);
  await writeConfigYamlFile(paths.configPath, {
    screenpipeUrl: DEFAULT_SCREENPIPE_URL,
    screenpipeApiKey: screenpipe.apiKey,
    embeddings
  });

  await runBuildIfNeeded();
  await startManagedService();

  const validation = await runFirstValidation(paths.configPath);
  const hermesPaths = resolveHermesPaths();
  const hermesConfig = await writeHermesConfigFile(hermesPaths.configPath, validation.endpoint);

  console.log('\nOnboarding complete.');
  console.log(`- config: ${paths.configPath}${backupPath ? ` (previous config backed up to ${backupPath})` : ''}`);
  console.log(`- logs: ${paths.logDirectory}`);
  console.log(`- screenpipe auth: ${screenpipe.authSummary}`);
  console.log(`- embeddings: ${providerSummary}`);
  console.log(`- endpoint: ${validation.endpoint}`);
  console.log(`- Hermes MCP config: ${hermesConfig.configPath}`);
  console.log(`- Hermes MCP server: ${hermesConfig.serverName}`);
  console.log(`- service status: ${validation.status?.status ?? 'unknown'}`);
  console.log(`- retrieval recovery: ${validation.status?.retrieval?.recoveryStatus ?? 'unknown'}`);
  console.log(`- live recent-activity items (10m): ${validation.resultCount}`);
  console.log(`- search-screen validation items (keyword, 10m): ${validation.searchResultCount} (${validation.searchStatus})`);
  if (validation.searchItemIds.length > 0) {
    console.log(`- search-screen sample item ids: ${validation.searchItemIds.join(', ')}`);
  }
  if (validation.itemIds.length > 0) {
    console.log(`- sample item ids: ${validation.itemIds.join(', ')}`);
  }

  console.log('\nNext commands:');
  console.log('1. npm run service:status');
  console.log('2. hermes mcp list');
  console.log('3. hermes mcp test screenpipe-memory');
  console.log('4. hermes chat --toolsets screenpipe-memory --query "Call recent-activity with minutes 10 and summarize what you find."');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
