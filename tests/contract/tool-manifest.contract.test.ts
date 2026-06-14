import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connectStdioClient } from '../helpers/mcp-client.js';
import { startEmbeddingStub } from '../helpers/embedding-stub.js';
import { startScreenpipeStub } from '../helpers/screenpipe-stub.js';
import { writeTestConfig } from '../helpers/test-config.js';
import { testTempRoot } from '../helpers/test-tmp.js';

const CANONICAL_FOCUSED_V1_TOOLS = [
  { name: 'file-analyze', title: 'Analyze File' },
  { name: 'find', title: 'Find in Screen Memory' },
  { name: 'inspect', title: 'Inspect Screen Session or Frame' },
  { name: 'internal-status', title: 'Internal Status' },
  { name: 'memory-read', title: 'Read Memory' },
  { name: 'memory-write', title: 'Write Memory' },
  { name: 'privacy-control', title: 'Privacy Control' },
  { name: 'recall', title: 'Recall Screen Activity' },
  { name: 'routine-create', title: 'Create or Update Routine' },
  { name: 'routine-history', title: 'Routine Execution History' },
  { name: 'routine-list', title: 'List Routines' },
  { name: 'screenpipe-control', title: 'Screenpipe Control' }
] as const;

describe('focused v1 tool manifest contract', () => {
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

  it('exposes exactly the canonical focused v1 tool names over MCP', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'tool-manifest-contract-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio'
    });

    const connection = await connectStdioClient({ HOME: homeDir });
    cleanup.push(() => connection.close());

    const result = await connection.client.listTools();
    const actualNames = result.tools.map((tool) => tool.name).sort();
    const expectedNames = CANONICAL_FOCUSED_V1_TOOLS.map((tool) => tool.name).sort();

    expect(actualNames).toEqual(expectedNames);
  });

  it('keeps stable manifest metadata aligned with the public registry surface', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'tool-manifest-metadata-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio'
    });

    const connection = await connectStdioClient({ HOME: homeDir });
    cleanup.push(() => connection.close());

    const result = await connection.client.listTools();
    const registry = new Map(result.tools.map((tool) => [tool.name, tool]));

    expect(result.tools).toHaveLength(CANONICAL_FOCUSED_V1_TOOLS.length);

    for (const expectedTool of CANONICAL_FOCUSED_V1_TOOLS) {
      const tool = registry.get(expectedTool.name);

      expect(tool, `Expected ${expectedTool.name} to be registered.`).toBeDefined();
      expect(tool?.title).toBe(expectedTool.title);
      expect(tool?.description).toEqual(expect.any(String));
      expect(tool?.description?.trim().length).toBeGreaterThan(0);
      expect(tool?.inputSchema).toBeDefined();
    }
  });
});
