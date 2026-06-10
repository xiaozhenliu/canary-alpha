import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  askSecret,
  runValidationToolCalls,
  summarizeOllamaModelProbe,
  summarizeRecallValidation,
  summarizeFindValidation
} from '../../scripts/onboard.js';
import { testTempRoot } from '../helpers/test-tmp.js';
import {
  backupConfigIfPresent,
  buildConfigObject,
  buildHermesServerConfig,
  createHostedEmbeddingsConfig,
  createOllamaEmbeddingsConfig,
  DEFAULT_HOSTED_BASE_URL,
  DEFAULT_HOSTED_MODEL,
  DEFAULT_HERMES_SERVER_NAME,
  DEFAULT_HERMES_TOOL_INCLUDE,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_SCREENPIPE_URL,
  ensureAppDirectories,
  mergeHermesConfig,
  resolveAppPaths,
  resolveHermesPaths,
  writeConfigYamlFile,
  writeHermesConfigFile
} from '../../scripts/onboarding-config.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const task = cleanup.pop();
    if (task) {
      await task();
    }
  }
});

describe('onboarding config helpers', () => {
  it('builds the default local Ollama config for onboarding', () => {
    const config = buildConfigObject();

    expect(config.server).toEqual({
      mode: 'http',
      host: '127.0.0.1',
      port: 18765,
      authToken: expect.any(String)
    });
    expect(config.screenpipe.url).toBe(DEFAULT_SCREENPIPE_URL);
    expect(config.screenpipe.apiKey).toBeUndefined();
    expect(config.providers.embeddings).toEqual({
      kind: 'ollama',
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      model: DEFAULT_OLLAMA_MODEL,
      concurrency: 2
    });
    expect(config.vectorStore).toEqual({
      kind: 'chroma'
    });
  });

  it('builds a hosted provider config with the required user-supplied fields', () => {
    const embeddings = createHostedEmbeddingsConfig({
      baseUrl: DEFAULT_HOSTED_BASE_URL,
      model: DEFAULT_HOSTED_MODEL,
      apiKey: 'sk-test-key'
    });
    const config = buildConfigObject({ embeddings });

    expect(config.providers.embeddings).toEqual({
      kind: 'openai-compatible',
      baseUrl: DEFAULT_HOSTED_BASE_URL,
      model: DEFAULT_HOSTED_MODEL,
      concurrency: 2,
      apiKey: 'sk-test-key'
    });
  });

  it('backs up an existing config before overwriting it', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'onboard-config-backup-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const paths = resolveAppPaths(homeDir);
    await ensureAppDirectories(paths);
    await writeFile(paths.configPath, 'server:\n  port: 9999\n', 'utf8');

    const backupPath = await backupConfigIfPresent(paths.configPath, paths.appDirectory, new Date('2026-04-17T04:00:00.000Z'));

    expect(backupPath).toBe(join(paths.appDirectory, 'config.backup-20260417-040000.yaml'));
    expect(backupPath).not.toBeNull();
    await expect(readFile(backupPath as string, 'utf8')).resolves.toBe('server:\n  port: 9999\n');
  });

  it('writes the selected config shape to disk', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'onboard-config-write-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const paths = resolveAppPaths(homeDir);
    const yaml = await writeConfigYamlFile(paths.configPath, {
      screenpipeUrl: 'http://localhost:3030',
      screenpipeApiKey: 'sp-test-token',
      embeddings: createOllamaEmbeddingsConfig()
    });

    expect(yaml).toContain('port: 18765');
    expect(yaml).toContain('authToken:');
    expect(yaml).toContain('kind: ollama');
    expect(yaml).toContain('apiKey: sp-test-token');
    await expect(readFile(paths.configPath, 'utf8')).resolves.toContain('nomic-embed-text');
  });

  it('builds a Hermes MCP server entry for the local onboarding endpoint', () => {
    expect(buildHermesServerConfig('http://127.0.0.1:18765/mcp')).toEqual({
      url: 'http://127.0.0.1:18765/mcp',
      enabled: true,
      tools: {
        include: DEFAULT_HERMES_TOOL_INCLUDE
      }
    });
  });

  it('rejects non-loopback Hermes auto-config endpoints', () => {
    for (const endpoint of ['http://localhost:18765/mcp', 'http://0.0.0.0:18765/mcp', 'https://example.com/mcp']) {
      expect(() => buildHermesServerConfig(endpoint)).toThrow(/requires a 127\.0\.0\.1 endpoint/);
    }
  });

  it('merges the Hermes server while preserving existing config and servers', () => {
    const merged = mergeHermesConfig({
      default_model: 'claude',
      mcp_servers: {
        existing: {
          url: 'http://127.0.0.1:9999/mcp',
          enabled: false
        }
      }
    }, 'http://127.0.0.1:18765/mcp');

    expect(merged).toEqual({
      default_model: 'claude',
      mcp_servers: {
        existing: {
          url: 'http://127.0.0.1:9999/mcp',
          enabled: false
        },
        [DEFAULT_HERMES_SERVER_NAME]: {
          url: 'http://127.0.0.1:18765/mcp',
          enabled: true,
          tools: {
            include: DEFAULT_HERMES_TOOL_INCLUDE
          }
        }
      }
    });
  });

  it('updates an existing Hermes canary-alpha-mcp entry idempotently', () => {
    const merged = mergeHermesConfig({
      mcp_servers: {
        [DEFAULT_HERMES_SERVER_NAME]: {
          url: 'http://127.0.0.1:1111/mcp',
          enabled: false,
          tools: {
            include: ['old-tool']
          }
        }
      }
    }, 'http://127.0.0.1:18765/mcp');

    expect(merged.mcp_servers[DEFAULT_HERMES_SERVER_NAME]).toEqual({
      url: 'http://127.0.0.1:18765/mcp',
      enabled: true,
      tools: {
        include: DEFAULT_HERMES_TOOL_INCLUDE
      }
    });
  });

  it('writes Hermes config under an isolated home directory', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'hermes-config-write-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const paths = resolveHermesPaths(homeDir);
    const result = await writeHermesConfigFile(paths.configPath, 'http://127.0.0.1:18765/mcp');

    expect(result).toMatchObject({
      configPath: paths.configPath,
      serverName: DEFAULT_HERMES_SERVER_NAME,
      endpoint: 'http://127.0.0.1:18765/mcp'
    });
    await expect(readFile(paths.configPath, 'utf8')).resolves.toContain('canary-alpha-mcp');
  });

  it('fails invalid Hermes YAML without overwriting the original file', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'hermes-config-invalid-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const paths = resolveHermesPaths(homeDir);
    await mkdir(paths.hermesDirectory, { recursive: true });
    await writeFile(paths.configPath, 'mcp_servers: [unterminated\n', 'utf8');

    await expect(writeHermesConfigFile(paths.configPath, 'http://127.0.0.1:18765/mcp')).rejects.toThrow(/file was not modified/);
    await expect(readFile(paths.configPath, 'utf8')).resolves.toBe('mcp_servers: [unterminated\n');
  });

  it('falls back to visible prompt behavior for secret input outside a TTY', async () => {
    const visiblePrompt = vi.fn().mockResolvedValue('fallback-key');

    await expect(askSecret('Embedding API key: ', 'ignored', {
      visiblePrompt,
      inputIsTTY: false,
      outputIsTTY: false
    })).resolves.toBe('fallback-key');

    expect(visiblePrompt).toHaveBeenCalledWith('Embedding API key: ', 'ignored');
  });

  it('detects the Screenpipe API token without starting Screenpipe capture', async () => {
    const execFileMock = vi.fn((file, args, options, callback) => {
      callback(null, { stdout: 'sp-auto-token\n', stderr: '' });
    });

    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFile: execFileMock
    }));

    try {
      const onboardModule = await import('../../scripts/onboard.js') as unknown as {
        detectScreenpipeApiKey: () => Promise<string | null>;
      };

      await expect(onboardModule.detectScreenpipeApiKey()).resolves.toBe('sp-auto-token');
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).toHaveBeenCalledWith(
        'npx',
        ['screenpipe@latest', 'auth', 'token'],
        expect.objectContaining({
          cwd: PROJECT_ROOT,
          env: process.env,
          maxBuffer: 1024 * 1024
        }),
        expect.any(Function)
      );
      expect(execFileMock).not.toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining(['screenpipe@latest', 'record']),
        expect.anything(),
        expect.anything()
      );
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('resolves Screenpipe auth by probing health and search without starting capture', async () => {
    const execFileMock = vi.fn((file, args, options, callback) => {
      callback(null, { stdout: 'sp-auto-token\n', stderr: '' });
    });
    const fetchMock = vi.fn(async (input: string | URL, init?: { headers?: Record<string, string> }) => {
      const url = String(input);
      const authorization = init?.headers?.authorization;

      if (url === 'http://localhost:3030/health') {
        return new Response('ok', { status: 200 });
      }

      if (url.startsWith('http://localhost:3030/search?') && authorization === undefined) {
        return new Response('forbidden', { status: 403 });
      }

      if (url.startsWith('http://localhost:3030/search?') && authorization === 'Bearer sp-auto-token') {
        return new Response('{"data":[],"pagination":{"limit":1,"offset":0,"total":0}}', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFile: execFileMock
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const onboardModule = await import('../../scripts/onboard.js') as unknown as {
        resolveScreenpipeConnection: (baseUrl: string) => Promise<{ apiKey?: string; authSummary: string }>;
      };

      await expect(onboardModule.resolveScreenpipeConnection('http://localhost:3030')).resolves.toEqual({
        apiKey: 'sp-auto-token',
        authSummary: 'enabled (auto-detected token)'
      });
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        'http://localhost:3030/health',
        'http://localhost:3030/search?content_type=ocr&limit=1&offset=0',
        'http://localhost:3030/search?content_type=ocr&limit=1&offset=0'
      ]);
      expect(execFileMock).toHaveBeenCalledWith(
        'npx',
        ['screenpipe@latest', 'auth', 'token'],
        expect.anything(),
        expect.any(Function)
      );
      expect(execFileMock).not.toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining(['screenpipe@latest', 'record']),
        expect.anything(),
        expect.anything()
      );
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('summarizes Ollama model readiness from the models response', () => {
    expect(summarizeOllamaModelProbe({
      ok: true,
      status: 200,
      body: JSON.stringify({
        data: [
          { id: 'other-model' },
          { id: DEFAULT_OLLAMA_MODEL }
        ]
      })
    }, DEFAULT_OLLAMA_MODEL)).toEqual({
      available: true,
      reason: 'available'
    });
  });

  it('summarizes a missing Ollama embedding model with an actionable install message', () => {
    expect(summarizeOllamaModelProbe({
      ok: true,
      status: 200,
      body: JSON.stringify({
        data: [
          { id: 'other-model' }
        ]
      })
    }, DEFAULT_OLLAMA_MODEL)).toEqual({
      available: false,
      reason: `Ollama is reachable at ${DEFAULT_OLLAMA_BASE_URL}, but embedding model ${DEFAULT_OLLAMA_MODEL} is not installed. Install it with \`ollama pull ${DEFAULT_OLLAMA_MODEL}\` or choose hosted embeddings.`
    });
  });

  it('summarizes invalid Ollama model responses as unverifiable', () => {
    expect(summarizeOllamaModelProbe({
      ok: true,
      status: 200,
      body: 'not json'
    }, DEFAULT_OLLAMA_MODEL)).toEqual({
      available: false,
      reason: `Ollama responded, but ${DEFAULT_OLLAMA_MODEL} could not be verified because /api/models returned invalid JSON.`
    });
  });

  it('summarizes recall validation content without exposing session text', () => {
    expect(summarizeRecallValidation({
      sessions: [
        { sessionId: 'session-1', appName: 'Cursor', contextLabel: 'editing' },
        { sessionId: 'session-2', appName: 'Cursor', contextLabel: 'reviewing' },
        { sessionId: 3 }
      ]
    })).toEqual({
      sessionCount: 3,
      sessionIds: ['session-1', 'session-2']
    });
  });

  it('summarizes find validation evidence without exposing extracted text', () => {
    expect(summarizeFindValidation({
      data: [
        { frameId: 'frame-1', extractedText: 'hidden OCR text' },
        { frameId: 'frame-2', extractedText: 'hidden OCR text' },
        { frameId: 42, extractedText: 'numeric frame id' }
      ]
    })).toEqual({
      findResultCount: 3,
      findItemIds: ['frame-1', 'frame-2', '42'],
      findStatus: 'ok'
    });
  });

  it('summarizes degraded find validation status', () => {
    expect(summarizeFindValidation({
      data: [],
      degraded: {
        requestedMode: 'semantic',
        actualMode: 'keyword',
        reason: 'Embedding provider failed; returned keyword-backed results instead.'
      }
    })).toEqual({
      findResultCount: 0,
      findItemIds: [],
      findStatus: 'Embedding provider failed; returned keyword-backed results instead.'
    });
  });

  it('summarizes find without data field as empty', () => {
    expect(summarizeFindValidation({})).toEqual({
      findResultCount: 0,
      findItemIds: [],
      findStatus: 'ok'
    });
  });

  it('calls onboarding validation tools in order with a bounded find probe', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client = {
      async callTool(request: { name: string; arguments: Record<string, unknown> }) {
        calls.push(request);

        if (request.name === 'internal-status') {
          return { structuredContent: { status: 'ok' } };
        }
        if (request.name === 'recall') {
          return {
            structuredContent: {
              granularity: 'session',
              sessions: [{ sessionId: 'session-1', appName: 'Cursor', contextLabel: 'editing' }]
            }
          };
        }
        if (request.name === 'find') {
          return {
            structuredContent: {
              data: [{ frameId: 'frame-1', extractedText: 'hidden OCR text' }],
              narrativeText: ''
            }
          };
        }

        throw new Error(`Unexpected tool call: ${request.name}`);
      }
    };

    const validation = await runValidationToolCalls(client, new Date('2026-04-17T04:10:00.000Z'));

    expect(calls).toEqual([
      {
        name: 'internal-status',
        arguments: {}
      },
      {
        name: 'recall',
        arguments: {
          from: '2026-04-17T04:00:00.000Z',
          to: '2026-04-17T04:10:00.000Z',
          granularity: 'session',
          includeSummary: false
        }
      },
      {
        name: 'find',
        arguments: {
          query: 'screenpipe',
          mode: 'keyword',
          from: '2026-04-17T04:00:00.000Z',
          to: '2026-04-17T04:10:00.000Z',
          limit: 5
        }
      }
    ]);
    expect(validation).toEqual({
      status: { status: 'ok' },
      sessionCount: 1,
      sessionIds: ['session-1'],
      findResultCount: 1,
      findItemIds: ['frame-1'],
      findStatus: 'ok'
    });
  });
});
