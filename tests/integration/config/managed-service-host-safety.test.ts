import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../../src/bootstrap/create-app.js';
import { startEmbeddingStub } from '../../helpers/embedding-stub.js';
import { startScreenpipeStub } from '../../helpers/screenpipe-stub.js';
import { writeTestConfig } from '../../helpers/test-config.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

const cleanup: Array<() => Promise<void>> = [];
const originalHome = process.env.HOME;
const originalManagedServiceFlag = process.env.CANARY_ALPHA_MCP_MANAGED_SERVICE;

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalManagedServiceFlag === undefined) {
    delete process.env.CANARY_ALPHA_MCP_MANAGED_SERVICE;
  } else {
    process.env.CANARY_ALPHA_MCP_MANAGED_SERVICE = originalManagedServiceFlag;
  }

  while (cleanup.length > 0) {
    const close = cleanup.pop();
    if (close) {
      await close();
    }
  }
});

describe('managed service host safety', () => {
  it('rejects managed HTTP startup when config host is not localhost', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'managed-host-check-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http'
    });

    const configPath = join(homeDir, '.computer-history-mcp', 'config.yaml');

    // overwrite only the host field to simulate a later unsafe edit
    const unsafeConfig = [
      'server:',
      '  mode: http',
      '  host: 0.0.0.0',
      '  port: 8765',
      'logging:',
      '  level: info',
      'screenpipe:',
      `  url: ${screenpipe.url}`,
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      `    baseUrl: ${embedding.url}`,
      '    model: acceptance-embedding-model',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n');
    await writeFile(configPath, `${unsafeConfig}\n`, 'utf8');

    process.env.HOME = homeDir;
    process.env.CANARY_ALPHA_MCP_MANAGED_SERVICE = '1';

    await expect(createApp({ mode: 'http' })).rejects.toThrow(
      'Managed HTTP service must bind to 127.0.0.1 (found 0.0.0.0).'
    );
  });

  it('rejects non-managed HTTP startup when config host is not localhost', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'http-host-check-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http'
    });

    const configPath = join(homeDir, '.computer-history-mcp', 'config.yaml');
    const unsafeConfig = [
      'server:',
      '  mode: http',
      '  host: 0.0.0.0',
      '  port: 8765',
      'logging:',
      '  level: info',
      'screenpipe:',
      `  url: ${screenpipe.url}`,
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      `    baseUrl: ${embedding.url}`,
      '    model: acceptance-embedding-model',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n');
    await writeFile(configPath, `${unsafeConfig}\n`, 'utf8');

    process.env.HOME = homeDir;
    delete process.env.CANARY_ALPHA_MCP_MANAGED_SERVICE;

    await expect(createApp({ mode: 'http' })).rejects.toThrow(
      'HTTP transport must bind to 127.0.0.1 (found 0.0.0.0).'
    );
  });

  it('rejects HTTP startup when no auth token is configured', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'http-auth-check-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http'
    });

    const configPath = join(homeDir, '.computer-history-mcp', 'config.yaml');
    const noAuthConfig = [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 8765',
      'logging:',
      '  level: info',
      'screenpipe:',
      `  url: ${screenpipe.url}`,
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      `    baseUrl: ${embedding.url}`,
      '    model: acceptance-embedding-model',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n');
    await writeFile(configPath, `${noAuthConfig}\n`, 'utf8');

    process.env.HOME = homeDir;
    delete process.env.CANARY_ALPHA_MCP_MANAGED_SERVICE;
    delete process.env.CANARY_ALPHA_MCP_AUTH_TOKEN;

    await expect(createApp({ mode: 'http' })).rejects.toThrow(
      'HTTP transport requires server.authToken or CANARY_ALPHA_MCP_AUTH_TOKEN.'
    );
  });
});
