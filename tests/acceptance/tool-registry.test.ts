import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TOOL_MANIFEST } from '../../src/mcp/tool-manifest.js';
import { connectStdioClient } from '../helpers/mcp-client.js';
import { startEmbeddingStub } from '../helpers/embedding-stub.js';
import { startScreenpipeStub } from '../helpers/screenpipe-stub.js';
import { writeTestConfig } from '../helpers/test-config.js';
import { testTempRoot } from '../helpers/test-tmp.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const close = cleanup.pop();
    if (close) {
      await close();
    }
  }
});

describe('tool registry visibility', () => {
  it('exposes the focused v1 tool manifest over MCP', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'tool-registry-'));
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
    // TOOL_MANIFEST includes all registered tools (including routine-list,
    // routine-create, routine-history) plus screenpipe-control which is
    // registered directly without appearing in the manifest.
    const expectedNames = [...TOOL_MANIFEST.map((tool) => tool.name), 'screenpipe-control'].sort();

    expect(actualNames).toEqual(expectedNames);
  });
});
