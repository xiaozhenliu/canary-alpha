import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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

describe('stdio MCP initialization', () => {
  it('connects a real MCP client over stdio', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'stdio-init-connect-'));
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

    const tools = await connection.client.listTools();

    expect(tools.tools.length).toBeGreaterThan(0);
  });

  it('removes the runtime marker when a stdio session shuts down', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'stdio-init-runtime-marker-'));
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
    const runtimeDir = join(homeDir, '.computer-history-mcp', 'runtime-processes');

    await connection.client.listTools();
    expect((await readdir(runtimeDir)).length).toBeGreaterThan(0);

    await connection.close();

    const startedAt = Date.now();
    let remainingMarkers = ['placeholder'];
    while (Date.now() - startedAt < 10_000) {
      try {
        remainingMarkers = await readdir(runtimeDir);
      } catch {
        remainingMarkers = [];
      }

      if (remainingMarkers.length === 0) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(remainingMarkers).toEqual([]);
  });

  it('does not write stdio session logs into the managed service log', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'stdio-init-'));
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

    await connection.client.listTools();
    await connection.close();

    await expect(access(join(homeDir, '.computer-history-mcp', 'logs', 'service.log'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });
});
