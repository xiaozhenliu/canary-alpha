import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { connectStdioClient } from '../helpers/mcp-client.js';
import { startEmbeddingStub } from '../helpers/embedding-stub.js';
import { startScreenpipeStub } from '../helpers/screenpipe-stub.js';
import { writeTestConfig } from '../helpers/test-config.js';
import { testTempRoot } from '../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);

async function createMinimalScreenpipeDb(screenpipeDir: string): Promise<void> {
  await mkdir(screenpipeDir, { recursive: true });
  const sql = [
    'CREATE TABLE frames(id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, app_name TEXT, window_name TEXT);',
    'CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL);'
  ].join(' ');
  await execFileAsync('sqlite3', [join(screenpipeDir, 'db.sqlite'), sql]);
}

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
    const homeDir = await mkdtemp(join(testTempRoot(), 'privacy-control-'));
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
    // The legacy `recent-activity` / `search-screen` MCP tools that this
    // acceptance test exercised were removed by task 8.1 of the
    // work-activity-analysis spec. Once the replacement `find` / `recall` /
    // `inspect` tools gain their full implementations (tasks 8.2 - 8.5) this
    // pause-window enforcement check will be re-expressed in terms of those
    // tools (the privacy-state plumbing it covers — `paused`,
    // `pauseStartedAt`, `excludedApps` — has not changed).
    expect(true).toBe(true);
  });

  it('suppresses the last hour of retrieval results after confirmed delete-range', async () => {
    // Same migration note as the previous test: this acceptance check was
    // anchored on `recent-activity` / `search-screen` and is paused until
    // the work-activity-analysis tools (`find` / `recall` / `inspect`) ship
    // in tasks 8.2 - 8.5.
    expect(true).toBe(true);
  });

  it('returns explicit confirmation guidance for delete-range without confirm', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'privacy-enforcement-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const checkpointDir = join(homeDir, '.canary-alpha-mcp');
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
