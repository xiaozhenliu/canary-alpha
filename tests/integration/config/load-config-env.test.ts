import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config/load-config.js';
import {
  APP_DIRECTORY_NAME,
  resolveRoutineDefinitionsDirectory,
  resolveRoutineHistoryDirectory
} from '../../../src/config/paths.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

const DEFAULT_ROUTINES_ENABLED = false;

function buildBaseConfigYaml(extraLines: string[] = []) {
  return [
    'server:',
    '  mode: http',
    '  host: 127.0.0.1',
    '  port: 8765',
    'logging:',
    '  level: info',
    'screenpipe:',
    '  url: http://127.0.0.1:3030',
    'providers:',
    '  embeddings:',
    '    kind: openai-compatible',
    '    baseUrl: http://127.0.0.1:11434/v1',
    '    model: acceptance-embedding-model',
    'vectorStore:',
    '  kind: chroma',
    'retrieval:',
    '  freshnessWindowMinutes: 15',
    '  pollIntervalSeconds: 30',
    '  maxCatchUpBatches: 3',
    '  maxCatchUpRecords: 500',
    'routines:',
    `  enabled: ${DEFAULT_ROUTINES_ENABLED}`,
    ...extraLines
  ].join('\n');
}

async function writeConfigForHome(homeDir: string, yaml: string) {
  const appDir = join(homeDir, APP_DIRECTORY_NAME);
  const configPath = join(appDir, 'config.yaml');
  await mkdir(appDir, { recursive: true });
  await writeFile(configPath, yaml, 'utf8');
  return configPath;
}

function setRoutineNoiseEnv() {
  process.env.ROUTINES_ENABLED = 'true';
  process.env.ROUTINES_DEFINITIONS_PATH = '/tmp/routines-definitions-from-env';
  process.env.ROUTINES_HISTORY_PATH = '/tmp/routines-history-from-env';
}

function clearRoutineNoiseEnv() {
  delete process.env.ROUTINES_ENABLED;
  delete process.env.ROUTINES_DEFINITIONS_PATH;
  delete process.env.ROUTINES_HISTORY_PATH;
}

clearRoutineNoiseEnv();

const originalHome = process.env.HOME;
const originalManagedServiceFlag = process.env.SCREENPIPE_MEMORY_MCP_MANAGED_SERVICE;
const originalManagedServicePort = process.env.SCREENPIPE_MEMORY_MCP_SERVER_PORT;
const originalMcpPort = process.env.MCP_PORT;
const originalScreenpipeBaseUrl = process.env.SCREENPIPE_BASE_URL;
const originalScreenpipeApiKey = process.env.SCREENPIPE_API_KEY;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalManagedServiceFlag === undefined) {
    delete process.env.SCREENPIPE_MEMORY_MCP_MANAGED_SERVICE;
  } else {
    process.env.SCREENPIPE_MEMORY_MCP_MANAGED_SERVICE = originalManagedServiceFlag;
  }

  if (originalManagedServicePort === undefined) {
    delete process.env.SCREENPIPE_MEMORY_MCP_SERVER_PORT;
  } else {
    process.env.SCREENPIPE_MEMORY_MCP_SERVER_PORT = originalManagedServicePort;
  }

  if (originalMcpPort === undefined) {
    delete process.env.MCP_PORT;
  } else {
    process.env.MCP_PORT = originalMcpPort;
  }

  if (originalScreenpipeBaseUrl === undefined) {
    delete process.env.SCREENPIPE_BASE_URL;
  } else {
    process.env.SCREENPIPE_BASE_URL = originalScreenpipeBaseUrl;
  }

  if (originalScreenpipeApiKey === undefined) {
    delete process.env.SCREENPIPE_API_KEY;
  } else {
    process.env.SCREENPIPE_API_KEY = originalScreenpipeApiKey;
  }

  clearRoutineNoiseEnv();
});

describe('loadConfig env overrides', () => {
  it('resolves default routines definitions and history paths from the canonical app home', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-routines-defaults-'));
    await writeConfigForHome(homeDir, buildBaseConfigYaml());

    process.env.HOME = homeDir;

    const config = await loadConfig();

    expect(config.routines.enabled).toBe(false);
    expect(config.routines.definitionsPath).toBe(resolveRoutineDefinitionsDirectory());
    expect(config.routines.historyPath).toBe(resolveRoutineHistoryDirectory());
  });

  it('keeps the default history path when only routines.definitionsPath is overridden', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-routines-definitions-only-'));
    const customDefinitionsPath = join(homeDir, 'custom-routines', 'definitions');
    await writeConfigForHome(homeDir, buildBaseConfigYaml([
      `  definitionsPath: ${customDefinitionsPath}`
    ]));

    process.env.HOME = homeDir;

    const config = await loadConfig();

    expect(config.routines.enabled).toBe(false);
    expect(config.routines.definitionsPath).toBe(customDefinitionsPath);
    expect(config.routines.historyPath).toBe(resolveRoutineHistoryDirectory());
  });

  it('keeps the default definitions path when only routines.historyPath is overridden', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-routines-history-only-'));
    const customHistoryPath = join(homeDir, 'custom-routines', 'history');
    await writeConfigForHome(homeDir, buildBaseConfigYaml([
      `  historyPath: ${customHistoryPath}`
    ]));

    process.env.HOME = homeDir;

    const config = await loadConfig();

    expect(config.routines.enabled).toBe(false);
    expect(config.routines.definitionsPath).toBe(resolveRoutineDefinitionsDirectory());
    expect(config.routines.historyPath).toBe(customHistoryPath);
  });

  it('ignores ROUTINES_* env noise and keeps config.yaml as the routines boundary', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-routines-env-noise-'));
    await writeConfigForHome(homeDir, buildBaseConfigYaml());

    process.env.HOME = homeDir;
    setRoutineNoiseEnv();

    const config = await loadConfig();

    expect(config.routines.enabled).toBe(false);
    expect(config.routines.definitionsPath).toBe(resolveRoutineDefinitionsDirectory());
    expect(config.routines.historyPath).toBe(resolveRoutineHistoryDirectory());
  });

  it('loads embedding concurrency from config.yaml', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-embedding-concurrency-'));
    const appDir = join(homeDir, APP_DIRECTORY_NAME);
    const configPath = join(appDir, 'config.yaml');

    await mkdir(appDir, { recursive: true });
    await writeFile(configPath, [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 8765',
      'logging:',
      '  level: info',
      'screenpipe:',
      '  url: http://127.0.0.1:3030',
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      '    baseUrl: http://127.0.0.1:11434/v1',
      '    model: acceptance-embedding-model',
      '    concurrency: 1',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n'), 'utf8');

    process.env.HOME = homeDir;

    const config = await loadConfig();

    expect(config.providers.embeddings.concurrency).toBe(1);
  });

  it('defaults embedding concurrency when the field is omitted', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-embedding-concurrency-default-'));
    const appDir = join(homeDir, APP_DIRECTORY_NAME);
    const configPath = join(appDir, 'config.yaml');

    await mkdir(appDir, { recursive: true });
    await writeFile(configPath, [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 8765',
      'logging:',
      '  level: info',
      'screenpipe:',
      '  url: http://127.0.0.1:3030',
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      '    baseUrl: http://127.0.0.1:11434/v1',
      '    model: acceptance-embedding-model',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n'), 'utf8');

    process.env.HOME = homeDir;

    const config = await loadConfig();

    expect(config.providers.embeddings.concurrency).toBe(2);
  });
  it('loads screenpipe apiKey from config.yaml', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-screenpipe-auth-'));
    const appDir = join(homeDir, APP_DIRECTORY_NAME);
    const configPath = join(appDir, 'config.yaml');

    await mkdir(appDir, { recursive: true });
    await writeFile(configPath, [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 8765',
      'logging:',
      '  level: info',
      'screenpipe:',
      '  url: http://127.0.0.1:3030',
      '  apiKey: sp-config-token',
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      '    baseUrl: http://127.0.0.1:11434/v1',
      '    model: acceptance-embedding-model',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n'), 'utf8');

    process.env.HOME = homeDir;

    const config = await loadConfig();

    expect(config.screenpipe.apiKey).toBe('sp-config-token');
  });

  it('prefers SCREENPIPE_BASE_URL over config.yaml screenpipe.url for managed service runs', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-env-'));
    const appDir = join(homeDir, APP_DIRECTORY_NAME);
    const configPath = join(appDir, 'config.yaml');

    await mkdir(appDir, { recursive: true });
    await writeFile(configPath, [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 8765',
      'logging:',
      '  level: info',
      'screenpipe:',
      '  url: http://127.0.0.1:3030',
      '  apiKey: config-token',
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      '    baseUrl: http://127.0.0.1:11434/v1',
      '    model: acceptance-embedding-model',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n'), 'utf8');

    process.env.HOME = homeDir;
    process.env.SCREENPIPE_MEMORY_MCP_MANAGED_SERVICE = '1';
    process.env.SCREENPIPE_BASE_URL = 'http://127.0.0.1:3031';

    const config = await loadConfig();

    expect(config.screenpipe.url).toBe('http://127.0.0.1:3031');
    expect(config.screenpipe.apiKey).toBe('config-token');
  });

  it('prefers SCREENPIPE_API_KEY over config.yaml screenpipe.apiKey for managed service runs', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-env-screenpipe-key-'));
    const appDir = join(homeDir, APP_DIRECTORY_NAME);
    const configPath = join(appDir, 'config.yaml');

    await mkdir(appDir, { recursive: true });
    await writeFile(configPath, [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 8765',
      'logging:',
      '  level: info',
      'screenpipe:',
      '  url: http://127.0.0.1:3030',
      '  apiKey: config-token',
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      '    baseUrl: http://127.0.0.1:11434/v1',
      '    model: acceptance-embedding-model',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n'), 'utf8');

    process.env.HOME = homeDir;
    process.env.SCREENPIPE_MEMORY_MCP_MANAGED_SERVICE = '1';
    process.env.SCREENPIPE_API_KEY = 'env-token';

    const config = await loadConfig();

    expect(config.screenpipe.apiKey).toBe('env-token');
  });

  it('ignores SCREENPIPE_BASE_URL for non-managed runs and keeps config.yaml screenpipe.url', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-empty-env-'));
    const appDir = join(homeDir, APP_DIRECTORY_NAME);
    const configPath = join(appDir, 'config.yaml');

    await mkdir(appDir, { recursive: true });
    await writeFile(configPath, [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 8765',
      'logging:',
      '  level: info',
      'screenpipe:',
      '  url: http://127.0.0.1:3030',
      '  apiKey: config-token',
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      '    baseUrl: http://127.0.0.1:11434/v1',
      '    model: acceptance-embedding-model',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n'), 'utf8');

    process.env.HOME = homeDir;
    process.env.SCREENPIPE_BASE_URL = 'http://127.0.0.1:3031';
    process.env.SCREENPIPE_API_KEY = 'env-token';

    const config = await loadConfig();

    expect(config.screenpipe.url).toBe('http://127.0.0.1:3030');
    expect(config.screenpipe.apiKey).toBe('config-token');
  });

  it('ignores stale SCREENPIPE_MEMORY_MCP_SERVER_PORT outside managed service runs', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-stale-frozen-port-'));
    const appDir = join(homeDir, APP_DIRECTORY_NAME);
    const configPath = join(appDir, 'config.yaml');

    await mkdir(appDir, { recursive: true });
    await writeFile(configPath, [
      'server:',
      '  mode: stdio',
      '  host: 127.0.0.1',
      '  port: 8765',
      'logging:',
      '  level: info',
      'screenpipe:',
      '  url: http://127.0.0.1:3030',
      '  apiKey: config-token',
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      '    baseUrl: http://127.0.0.1:11434/v1',
      '    model: acceptance-embedding-model',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n'), 'utf8');

    process.env.HOME = homeDir;
    process.env.SCREENPIPE_MEMORY_MCP_SERVER_PORT = 'not-a-port';

    const config = await loadConfig();

    expect(config.server.port).toBe(8765);
  });

  it('falls back to the frozen managed-service port when MCP_PORT is invalid for managed service runs', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-invalid-runtime-port-'));
    const appDir = join(homeDir, APP_DIRECTORY_NAME);
    const configPath = join(appDir, 'config.yaml');

    await mkdir(appDir, { recursive: true });
    await writeFile(configPath, [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 9999',
      'logging:',
      '  level: info',
      'screenpipe:',
      '  url: http://127.0.0.1:3030',
      '  apiKey: config-token',
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      '    baseUrl: http://127.0.0.1:11434/v1',
      '    model: acceptance-embedding-model',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n'), 'utf8');

    process.env.HOME = homeDir;
    process.env.SCREENPIPE_MEMORY_MCP_MANAGED_SERVICE = '1';
    process.env.SCREENPIPE_MEMORY_MCP_SERVER_PORT = '18765';
    process.env.MCP_PORT = 'broken';

    const config = await loadConfig({ mode: 'http' });

    expect(config.server.port).toBe(18765);
  });
});
