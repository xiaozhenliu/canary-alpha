import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../../src/bootstrap/create-app.js';
import { startEmbeddingStub } from '../../helpers/embedding-stub.js';
import { startScreenpipeStub } from '../../helpers/screenpipe-stub.js';
import { writeTestConfig } from '../../helpers/test-config.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

describe('app bootstrap indexing catch-up', () => {
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

  it('starts bootstrap indexing in the background without blocking app creation', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'bootstrap-indexing-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'bootstrap-1',
          text: 'Bootstrap indexing note',
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          appName: 'Claude',
          sourceTypes: ['ocr']
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub({ delayMs: 250 });
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio'
    });

    process.env.HOME = homeDir;

    await createApp({ mode: 'stdio' });

    const checkpointPath = join(homeDir, '.canary-alpha-mcp', 'retrieval-checkpoint.screenpipe.json');
    await expect(access(checkpointPath)).rejects.toBeDefined();

    await waitFor(async () => {
      const checkpoint = JSON.parse(await readCheckpoint(checkpointPath)) as {
        cursor: string;
        timestamp: string;
      };

      expect(checkpoint.cursor).toBe('bootstrap-1');
    });
  });

  it('continues indexing new records after startup on the polling interval', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'bootstrap-polling-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'bootstrap-1',
          text: 'Bootstrap indexing note',
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          appName: 'Claude',
          sourceTypes: ['ocr']
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      pollIntervalSeconds: 1
    });

    process.env.HOME = homeDir;

    await createApp({ mode: 'stdio' });

    screenpipe.addRecord({
      id: 'bootstrap-2',
      text: 'Indexed after startup',
      timestamp: new Date(Date.now()).toISOString(),
      appName: 'Claude',
      sourceTypes: ['ocr']
    });

    await waitFor(async () => {
      const checkpoint = JSON.parse(
        await readCheckpoint(join(homeDir, '.canary-alpha-mcp', 'retrieval-checkpoint.screenpipe.json'))
      ) as { cursor: string };
      expect(checkpoint.cursor).toBe('bootstrap-2');
    });
  });
});

async function readCheckpoint(filePath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(filePath, 'utf8');
}

async function waitFor(assertion: () => Promise<void>, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Timed out waiting for indexing poller.');
}
