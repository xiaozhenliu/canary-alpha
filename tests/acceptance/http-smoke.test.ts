import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connectHttpClient } from '../helpers/mcp-client.js';
import { startEmbeddingStub } from '../helpers/embedding-stub.js';
import { startHttpServer } from '../helpers/start-http-server.js';
import { startScreenpipeStub } from '../helpers/screenpipe-stub.js';
import { writeTestConfig } from '../helpers/test-config.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  delete process.env.HOME;

  while (cleanup.length > 0) {
    const close = cleanup.pop();
    if (close) {
      await close();
    }
  }
});

describe('HTTP smoke acceptance', () => {
  it('executes a real MCP retrieval flow over streamable HTTP', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'http-smoke-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'http-smoke-1',
          text: 'HTTP smoke retrieval fixture for MCP delivery validation',
          timestamp: '2026-04-13T11:59:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    const port = 8768;
    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http',
      port
    });

    await writeFile(
      join(homeDir, '.screenpipe-memory-mcp', 'retrieval-checkpoint.json'),
      JSON.stringify({
        cursor: 'http-smoke-checkpoint',
        timestamp: new Date(Date.now() - 2 * 60_000).toISOString()
      }, null, 2),
      'utf8'
    );

    process.env.HOME = homeDir;

    const server = await startHttpServer(port, { HOME: homeDir });
    cleanup.push(() => server.stop());

    const connection = await connectHttpClient(server.port);
    cleanup.push(() => connection.close());

    const result = await connection.client.callTool({
      name: 'search-screen',
      arguments: {
        query: 'HTTP smoke',
        mode: 'hybrid',
        appName: 'Claude'
      }
    });

    const structured = result.structuredContent as {
      summary: string;
      evidence: Array<{ id: string; source: string }>;
      freshness?: { status: string };
      error?: unknown;
    };

    expect(structured.error).toBeUndefined();
    expect(structured.summary).toContain('HTTP smoke');
    expect(structured.evidence.some((item) => item.id === 'http-smoke-1')).toBe(true);
    expect(structured.freshness?.status).toBe('fresh');
  });
});
