import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import YAML from 'yaml';

export const APP_DIRECTORY_NAME = '.canary-alpha-mcp';
export const CONFIG_FILE_NAME = 'config.yaml';
export const LOG_DIRECTORY_NAME = 'logs';
export const ROUTINES_DIRECTORY_NAME = 'routines';
export const ROUTINE_DEFINITIONS_DIRECTORY_NAME = 'definitions';
export const ROUTINE_HISTORY_DIRECTORY_NAME = 'history';
export const HERMES_DIRECTORY_NAME = '.hermes';
export const HERMES_CONFIG_FILE_NAME = 'config.yaml';
export const DEFAULT_HERMES_SERVER_NAME = 'screenpipe-memory';
export const DEFAULT_HERMES_TOOL_INCLUDE = [
  'internal-status',
  'search-screen',
  'recent-activity',
  'memory-read',
  'memory-write',
  'file-analyze',
  'privacy-control'
];
export const MINIMUM_NODE_MAJOR = 22;

export const DEFAULT_SERVER_PORT = 18765;
export const DEFAULT_SCREENPIPE_URL = 'http://localhost:3030';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';
export const DEFAULT_HOSTED_BASE_URL = 'https://api.deepseek.com';
// Embeddings model only — the hosted-embeddings onboarding flow asks the
// user to confirm/override before writing it to config. We keep a generic
// placeholder so the example does not nail the user to a vendor that may
// not match `DEFAULT_HOSTED_BASE_URL`.
export const DEFAULT_HOSTED_MODEL = 'text-embedding-3-large';
export const DEFAULT_EMBEDDING_CONCURRENCY = 2;

export function parseNodeMajorVersion(version) {
  return Number(version.split('.')[0]);
}

export function ensureSupportedNodeVersion(version = process.versions.node) {
  const majorVersion = parseNodeMajorVersion(version);
  if (majorVersion < MINIMUM_NODE_MAJOR) {
    throw new Error(`canary-alpha-mcp requires Node ${MINIMUM_NODE_MAJOR}+ (found ${version}).`);
  }
}

export function resolveAppPaths(homeDirectory = homedir()) {
  const appDirectory = join(homeDirectory, APP_DIRECTORY_NAME);
  const routinesDirectory = join(appDirectory, ROUTINES_DIRECTORY_NAME);
  return {
    appDirectory,
    configPath: join(appDirectory, CONFIG_FILE_NAME),
    logDirectory: join(appDirectory, LOG_DIRECTORY_NAME),
    routinesDirectory,
    routinesDefinitionsDirectory: join(routinesDirectory, ROUTINE_DEFINITIONS_DIRECTORY_NAME),
    routinesHistoryDirectory: join(routinesDirectory, ROUTINE_HISTORY_DIRECTORY_NAME)
  };
}


export function resolveHermesPaths(homeDirectory = homedir()) {
  const hermesDirectory = join(homeDirectory, HERMES_DIRECTORY_NAME);
  return {
    hermesDirectory,
    configPath: join(hermesDirectory, HERMES_CONFIG_FILE_NAME)
  };
}

export function buildHermesServerConfig(endpoint, options = {}) {
  const url = new URL(endpoint);
  if (url.hostname !== '127.0.0.1') {
    throw new Error(`Hermes MCP auto-config requires a 127.0.0.1 endpoint, received ${endpoint}.`);
  }

  return {
    url: url.toString(),
    enabled: true,
    tools: {
      include: options.tools ?? DEFAULT_HERMES_TOOL_INCLUDE
    }
  };
}

export function mergeHermesConfig(existingConfig = {}, endpoint, options = {}) {
  const config = existingConfig && typeof existingConfig === 'object' && !Array.isArray(existingConfig)
    ? { ...existingConfig }
    : {};
  const existingServers = config.mcp_servers && typeof config.mcp_servers === 'object' && !Array.isArray(config.mcp_servers)
    ? config.mcp_servers
    : {};

  return {
    ...config,
    mcp_servers: {
      ...existingServers,
      [options.serverName ?? DEFAULT_HERMES_SERVER_NAME]: buildHermesServerConfig(endpoint, options)
    }
  };
}

async function readHermesConfigIfPresent(configPath) {
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = await readFile(configPath, 'utf8');
  try {
    return YAML.parse(raw) ?? {};
  } catch (error) {
    throw new Error(`Could not parse existing Hermes config at ${configPath}; file was not modified. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeHermesConfigFile(configPath, endpoint, options = {}) {
  const existingConfig = await readHermesConfigIfPresent(configPath);
  const merged = mergeHermesConfig(existingConfig, endpoint, options);
  const yaml = YAML.stringify(merged);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, yaml, 'utf8');

  return {
    configPath,
    serverName: options.serverName ?? DEFAULT_HERMES_SERVER_NAME,
    endpoint,
    yaml
  };
}

export function createOllamaEmbeddingsConfig(options = {}) {
  return {
    kind: 'ollama',
    baseUrl: options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    model: options.model ?? DEFAULT_OLLAMA_MODEL,
    concurrency: options.concurrency ?? DEFAULT_EMBEDDING_CONCURRENCY
  };
}

export function createHostedEmbeddingsConfig(options) {
  return {
    kind: options.kind ?? 'openai-compatible',
    baseUrl: options.baseUrl,
    model: options.model,
    concurrency: options.concurrency ?? DEFAULT_EMBEDDING_CONCURRENCY,
    ...(options.apiKey ? { apiKey: options.apiKey } : {})
  };
}

export function buildConfigObject(options = {}) {
  return {
    server: {
      mode: 'http',
      host: '127.0.0.1',
      port: options.port ?? DEFAULT_SERVER_PORT
    },
    logging: {
      level: 'info'
    },
    screenpipe: {
      url: options.screenpipeUrl ?? DEFAULT_SCREENPIPE_URL,
      ...(options.screenpipeApiKey ? { apiKey: options.screenpipeApiKey } : {})
    },
    providers: {
      embeddings: options.embeddings ?? createOllamaEmbeddingsConfig()
    },
    vectorStore: {
      kind: 'chroma',
      ...(options.vectorStorePath ? { path: options.vectorStorePath } : {})
    },
    retrieval: {
      freshnessWindowMinutes: 15,
      pollIntervalSeconds: 30,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 500
    },
    routines: {
      enabled: false
    }
  };
}

export function buildConfigYaml(options = {}) {
  return YAML.stringify(buildConfigObject(options));
}

export async function ensureAppDirectories(paths) {
  await mkdir(paths.appDirectory, { recursive: true });
  await mkdir(paths.logDirectory, { recursive: true });
  await mkdir(paths.routinesDefinitionsDirectory, { recursive: true });
  await mkdir(paths.routinesHistoryDirectory, { recursive: true });
}

function formatBackupTimestamp(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export async function backupConfigIfPresent(configPath, backupDirectory, now = new Date()) {
  if (!existsSync(configPath)) {
    return null;
  }

  const backupPath = join(backupDirectory, `config.backup-${formatBackupTimestamp(now)}.yaml`);
  await copyFile(configPath, backupPath);
  return backupPath;
}

export async function writeConfigYamlFile(configPath, options = {}) {
  const yaml = buildConfigYaml(options);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, yaml, 'utf8');
  return yaml;
}

export function ensureDependenciesInstalled(repositoryRoot) {
  const nodeModulesDirectory = join(repositoryRoot, 'node_modules');
  if (existsSync(nodeModulesDirectory)) {
    return false;
  }

  execFileSync('npm', ['install'], {
    cwd: repositoryRoot,
    stdio: 'inherit'
  });
  return true;
}
