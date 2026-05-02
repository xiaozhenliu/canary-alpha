import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connectStdioClient } from '../helpers/mcp-client.js';
import { startEmbeddingStub } from '../helpers/embedding-stub.js';
import { startScreenpipeStub } from '../helpers/screenpipe-stub.js';
import { writeTestConfig } from '../helpers/test-config.js';

function minusMinutes(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe('privacy control acceptance', () => {
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

  it('persists paused state and excluded apps across real MCP stdio reconnects', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'privacy-control-'));
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

    const firstConnection = await connectStdioClient({ HOME: homeDir });
    try {
      await firstConnection.client.callTool({
        name: 'privacy-control',
        arguments: {
          action: 'pause'
        }
      });

      await firstConnection.client.callTool({
        name: 'privacy-control',
        arguments: {
          action: 'exclude-app',
          appName: 'Claude'
        }
      });
    } finally {
      await firstConnection.close();
    }

    const secondConnection = await connectStdioClient({ HOME: homeDir });
    cleanup.push(() => secondConnection.close());

    const statusResult = await secondConnection.client.callTool({
      name: 'privacy-control',
      arguments: {
        action: 'status'
      }
    });

    const structured = statusResult.structuredContent as {
      paused: boolean;
      excludedApps: string[];
    };

    expect(structured.paused).toBe(true);
    expect(structured.excludedApps).toEqual(['Claude']);
  });

  it('keeps pre-pause retrieval visible while paused and keeps paused-window records hidden after resume', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'privacy-enforcement-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const checkpointDir = join(homeDir, '.screenpipe-memory-mcp');
    await mkdir(checkpointDir, { recursive: true });
    await writeFile(
      join(checkpointDir, 'retrieval-checkpoint.json'),
      JSON.stringify({
        cursor: 'checkpoint-1',
        timestamp: minusMinutes(2)
      }, null, 2),
      'utf8'
    );

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio'
    });

    const prePauseTimestamp = new Date(Date.now() - 2 * 60_000).toISOString();
    screenpipe.addRecord({
      id: 'privacy-0',
      text: 'Visible note before pause',
      timestamp: prePauseTimestamp,
      appName: 'Notes'
    });

    const connection = await connectStdioClient({ HOME: homeDir });
    cleanup.push(() => connection.close());

    await connection.client.callTool({
      name: 'privacy-control',
      arguments: {
        action: 'pause'
      }
    });

    screenpipe.addRecord({
      id: 'privacy-1',
      text: 'Private note during pause',
      timestamp: new Date().toISOString(),
      appName: 'Claude'
    });

    const pausedRecentResult = await connection.client.callTool({
      name: 'recent-activity',
      arguments: {
        minutes: 10,
        format: 'raw'
      }
    });

    const pausedRecentStructured = pausedRecentResult.structuredContent as {
      summary: string;
      evidence: Array<{ text: string; appName?: string }>;
      raw?: Array<{ text: string; appName?: string }>;
      error?: unknown;
    };

    expect(pausedRecentStructured.evidence.map((item) => item.text)).toEqual(['Visible note before pause']);
    expect(pausedRecentStructured.raw?.map((item) => item.text)).toEqual(['Visible note before pause']);
    expect(pausedRecentStructured.error).toBeUndefined();

    await connection.client.callTool({
      name: 'privacy-control',
      arguments: {
        action: 'resume'
      }
    });

    screenpipe.addRecord({
      id: 'privacy-2',
      text: 'Visible note after resume',
      timestamp: new Date().toISOString(),
      appName: 'Terminal'
    });

    const resumedRecentResult = await connection.client.callTool({
      name: 'recent-activity',
      arguments: {
        minutes: 10,
        format: 'raw'
      }
    });

    const resumedRecentStructured = resumedRecentResult.structuredContent as {
      evidence: Array<{ text: string; appName?: string }>;
    };

    expect(resumedRecentStructured.evidence.map((item) => item.text)).toEqual(['Visible note before pause', 'Visible note after resume']);
    expect(resumedRecentStructured.evidence.every((item) => item.appName !== 'Claude')).toBe(true);

    const searchResult = await connection.client.callTool({
      name: 'search-screen',
      arguments: {
        query: 'note',
        mode: 'hybrid'
      }
    });

    const searchStructured = searchResult.structuredContent as {
      evidence: Array<{ text: string; appName?: string }>;
    };

    expect(searchStructured.evidence.some((item) => item.text === 'Visible note after resume')).toBe(true);
    expect(searchStructured.evidence.some((item) => item.text === 'Visible note before pause')).toBe(true);
    expect(searchStructured.evidence.some((item) => item.text === 'Private note during pause')).toBe(false);
    expect(searchStructured.evidence.every((item) => item.appName !== 'Claude')).toBe(true);
  });

  it('suppresses the last hour of retrieval results after confirmed delete-range', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'privacy-delete-range-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const checkpointDir = join(homeDir, '.screenpipe-memory-mcp');
    await mkdir(checkpointDir, { recursive: true });
    await writeFile(
      join(checkpointDir, 'retrieval-checkpoint.json'),
      JSON.stringify({
        cursor: 'checkpoint-1',
        timestamp: minusMinutes(90)
      }, null, 2),
      'utf8'
    );

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'delete-range-old',
          text: 'Old note outside delete range',
          timestamp: minusMinutes(90),
          appName: 'Notes'
        },
        {
          id: 'delete-range-recent',
          text: 'Recent note inside delete range',
          timestamp: minusMinutes(20),
          appName: 'Terminal'
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

    const connection = await connectStdioClient({ HOME: homeDir });
    cleanup.push(() => connection.close());

    const beforeResult = await connection.client.callTool({
      name: 'recent-activity',
      arguments: {
        minutes: 180,
        format: 'raw'
      }
    });

    const beforeStructured = beforeResult.structuredContent as {
      evidence: Array<{ text: string }>;
      raw?: Array<{ text: string }>;
    };

    expect(beforeStructured.evidence.map((item) => item.text)).toEqual(['Old note outside delete range', 'Recent note inside delete range']);
    expect(beforeStructured.raw?.map((item) => item.text)).toEqual(['Old note outside delete range', 'Recent note inside delete range']);

    const deleteResult = await connection.client.callTool({
      name: 'privacy-control',
      arguments: {
        action: 'delete-range',
        range: 'last_1h',
        confirm: true
      }
    });

    const deleteStructured = deleteResult.structuredContent as {
      requestedRange?: string;
      confirmed?: boolean;
      error?: unknown;
    };

    expect(deleteResult.isError).toBe(false);
    expect(deleteStructured.requestedRange).toBe('last_1h');
    expect(deleteStructured.confirmed).toBe(true);
    expect(deleteStructured.error).toBeUndefined();

    const afterRecentResult = await connection.client.callTool({
      name: 'recent-activity',
      arguments: {
        minutes: 180,
        format: 'raw'
      }
    });

    const afterRecentStructured = afterRecentResult.structuredContent as {
      evidence: Array<{ text: string }>;
      raw?: Array<{ text: string }>;
    };

    expect(afterRecentStructured.evidence.map((item) => item.text)).toEqual(['Old note outside delete range']);
    expect(afterRecentStructured.raw?.map((item) => item.text)).toEqual(['Old note outside delete range']);

    const afterSearchResult = await connection.client.callTool({
      name: 'search-screen',
      arguments: {
        query: 'note',
        mode: 'hybrid'
      }
    });

    const afterSearchStructured = afterSearchResult.structuredContent as {
      evidence: Array<{ text: string }>;
    };

    expect(afterSearchStructured.evidence.map((item) => item.text)).toEqual(['Old note outside delete range']);
  });

  it('returns explicit confirmation guidance for delete-range without confirm', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'privacy-confirm-'));
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

    const result = await connection.client.callTool({
      name: 'privacy-control',
      arguments: {
        action: 'delete-range',
        range: 'last_1d'
      }
    });

    const structured = result.structuredContent as {
      confirmationHint: string;
      error?: { code: string };
    };

    expect(result.isError).toBe(true);
    expect(structured.confirmationHint).toContain('confirm=true');
    expect(structured.error).toMatchObject({ code: 'PRIVACY_CONFIRM_REQUIRED' });
  });
});
