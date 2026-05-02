import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connectStdioClient } from '../helpers/mcp-client.js';
import { startEmbeddingStub } from '../helpers/embedding-stub.js';
import { startScreenpipeStub } from '../helpers/screenpipe-stub.js';
import { writeTestConfig } from '../helpers/test-config.js';

describe('real MCP smoke', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    delete process.env.HOME;

    while (cleanup.length > 0) {
      const task = cleanup.pop();
      if (task) {
        await task();
      }
    }
  });

  it('executes a real stdio MCP search flow end-to-end', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'real-mcp-smoke-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'smoke-1',
          text: 'Smoke test retrieval fixture for MCP protocol validation',
          timestamp: '2026-04-13T11:59:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio'
    });

    const checkpointDir = join(homeDir, '.screenpipe-memory-mcp');
    await writeFile(
      join(checkpointDir, 'retrieval-checkpoint.json'),
      JSON.stringify({
        cursor: 'smoke-checkpoint',
        timestamp: new Date(Date.now() - 2 * 60_000).toISOString()
      }, null, 2),
      'utf8'
    );

    const connection = await connectStdioClient({
      HOME: homeDir
    });
    cleanup.push(() => connection.close());

    const result = await connection.client.callTool({
      name: 'search-screen',
      arguments: {
        query: 'smoke',
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
    expect(structured.summary).toContain('smoke');
    expect(structured.evidence.some((item) => item.id === 'smoke-1')).toBe(true);
    expect(structured.freshness?.status).toBe('fresh');
  });
});
