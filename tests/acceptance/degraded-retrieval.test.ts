import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connectStdioClient } from '../helpers/mcp-client.js';
import { startEmbeddingStub } from '../helpers/embedding-stub.js';
import { startScreenpipeStub } from '../helpers/screenpipe-stub.js';
import { writeTestConfig } from '../helpers/test-config.js';
import { minusMinutes } from '../helpers/timestamps.js';

describe('degraded retrieval acceptance', () => {
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

  it('returns keyword-backed degraded results when embeddings fail', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'degraded-retrieval-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'fallback-1',
          text: 'Keyword fallback acceptance record',
          timestamp: minusMinutes(5),
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub({ fail: true });
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio'
    });

    const checkpointDir = join(homeDir, '.canary-alpha-mcp');
    await writeFile(
      join(checkpointDir, 'retrieval-checkpoint.json'),
      JSON.stringify({
        cursor: 'checkpoint-1',
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
        query: 'fallback',
        mode: 'hybrid'
      }
    });

    const structured = result.structuredContent as {
      evidence: Array<{ source: string; id: string }>;
      degraded?: { fallbackMode?: string; reason: string };
      error?: unknown;
    };

    expect(structured.error).toBeUndefined();
    expect(structured.evidence.some((item) => item.id === 'fallback-1')).toBe(true);
    expect(structured.degraded?.fallbackMode).toBe('keyword');
    expect(structured.degraded?.reason).toContain('keyword-backed results');
  });

  it('returns an actionable error when Screenpipe is unavailable while the MCP server stays healthy', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'screenpipe-outage-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ fail: true });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio'
    });

    const checkpointDir = join(homeDir, '.canary-alpha-mcp');
    await writeFile(
      join(checkpointDir, 'retrieval-checkpoint.json'),
      JSON.stringify({
        cursor: 'checkpoint-1',
        timestamp: new Date(Date.now() - 2 * 60_000).toISOString()
      }, null, 2),
      'utf8'
    );

    const connection = await connectStdioClient({
      HOME: homeDir
    });
    cleanup.push(() => connection.close());

    const result = await connection.client.callTool({
      name: 'recent-activity',
      arguments: {
        minutes: 10,
        format: 'summary'
      }
    });

    const structured = result.structuredContent as {
      error?: { code: string; action: string };
      evidence: Array<unknown>;
    };

    expect(structured.evidence).toEqual([]);
    expect(structured.error?.code).toBe('SCREENPIPE_UNAVAILABLE');
    expect(structured.error?.action).toContain('Verify the local Screenpipe service');

    const toolList = await connection.client.listTools();
    expect(toolList.tools.some((tool) => tool.name === 'search-screen')).toBe(true);
  });
});
