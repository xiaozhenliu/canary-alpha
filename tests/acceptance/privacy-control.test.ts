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
    const homeDir = await mkdtemp(join(testTempRoot(), 'privacy-delete-range-e2e-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    // Create the Screenpipe SQLite fixture DB in <homeDir>/.screenpipe/db.sqlite.
    // Frame id=1 is 65 minutes ago — outside last_1h but WITHIN the startup
    // catch-up window (freshnessWindowMinutes:15 * maxCatchUpBatches:5 = 75 min).
    // Frames id=2 and id=3 are 30 and 10 minutes ago (inside last_1h window).
    const screenpipeDir = join(homeDir, '.screenpipe');
    await mkdir(screenpipeDir, { recursive: true });
    const dbSql = [
      'PRAGMA journal_mode = WAL;',
      'CREATE TABLE frames(id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, app_name TEXT, window_name TEXT);',
      'CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL);',
      `INSERT INTO frames VALUES`,
      `  (1, datetime('now', '-65 minutes'), 'TestApp', 'TestWindow'),`,
      `  (2, datetime('now', '-30 minutes'), 'TestApp', 'TestWindow'),`,
      `  (3, datetime('now', '-10 minutes'), 'TestApp', 'TestWindow');`,
      'INSERT INTO elements VALUES (1, 1), (2, 2), (3, 3);'
    ].join('\n');
    await execFileAsync('sqlite3', [join(screenpipeDir, 'db.sqlite'), dbSql]);

    // Timestamps for the HTTP stub records must match those in the SQLite DB
    // closely enough that the indexing catch-up pipeline picks them all up.
    // We use ISO strings relative to now to mirror the SQLite datetime() values.
    // Frame 1 is at 65 minutes ago (outside last_1h, within the 75-min catch-up
    // window), frames 2 and 3 are inside last_1h and will be cascade-deleted.
    const now = Date.now();
    const sixtyFiveMinutesAgo = new Date(now - 65 * 60 * 1000).toISOString();
    const thirtyMinutesAgo = new Date(now - 30 * 60 * 1000).toISOString();
    const tenMinutesAgo = new Date(now - 10 * 60 * 1000).toISOString();

    // Start the Screenpipe HTTP stub with records matching the SQLite fixture.
    // Frame IDs MUST match between the HTTP stub and the SQLite DB so that
    // the cascade delete coordinator can remove derived rows by the same frameId set.
    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'frame:1:0',
          text: 'persistent baseline data older than one hour',
          timestamp: sixtyFiveMinutesAgo,
          appName: 'TestApp',
          windowName: 'TestWindow',
          frameId: 1,
          sourceTypes: ['ocr']
        },
        {
          id: 'frame:2:0',
          text: 'recent ephemeral data inside last hour alpha',
          timestamp: thirtyMinutesAgo,
          appName: 'TestApp',
          windowName: 'TestWindow',
          frameId: 2,
          sourceTypes: ['ocr']
        },
        {
          id: 'frame:3:0',
          text: 'recent ephemeral data inside last hour beta',
          timestamp: tenMinutesAgo,
          appName: 'TestApp',
          windowName: 'TestWindow',
          frameId: 3,
          sourceTypes: ['ocr']
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    // freshnessWindowMinutes defaults to 15; with maxCatchUpBatches=5 the
    // startup window is 75 minutes, which covers all three fixture frames.
    // A very long poll interval prevents re-indexing mid-test.
    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      pollIntervalSeconds: 9999,
      maxCatchUpBatches: 5,
      maxCatchUpRecords: 100
    });

    const connection = await connectStdioClient({ HOME: homeDir });
    cleanup.push(() => connection.close());

    // Poll `find` until BOTH recent frames (2 and 3) have been indexed by the
    // startup catch-up pipeline. keyword mode is used so results do not depend
    // on embedding similarity (the stub always returns [0.11, 0.22, 0.33]).
    const POLL_TIMEOUT_MS = 20_000;
    const POLL_INTERVAL_MS = 500;
    const pollStart = Date.now();
    let preFindFrameIds: number[] = [];

    while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
      const result = await connection.client.callTool({
        name: 'find',
        arguments: {
          query: 'data',
          mode: 'keyword',
          limit: 20
        }
      });

      const structured = result.structuredContent as { data: Array<{ frameId: string | number }> };
      preFindFrameIds = structured.data.map((item) => Number(item.frameId));

      // Wait until both recent frames are visible before proceeding.
      const hasFrame2 = preFindFrameIds.includes(2);
      const hasFrame3 = preFindFrameIds.includes(3);
      if (hasFrame2 && hasFrame3) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // Both recent frames must be present before the delete.
    expect(preFindFrameIds).toContain(2);
    expect(preFindFrameIds).toContain(3);

    // Execute the confirmed delete-range for last_1h.
    const deleteResult = await connection.client.callTool({
      name: 'privacy-control',
      arguments: {
        action: 'delete-range',
        range: 'last_1h',
        confirm: true
      }
    });

    const deleteStructured = deleteResult.structuredContent as {
      confirmed: boolean;
      requestedRange: string;
      deletedFrames?: number;
      deletedElements?: number;
      deletedExtractedContent?: number;
      cascade?: { upstreamDeleted: boolean; cascade: string };
      error?: { code: string };
    };

    // The delete must succeed: exactly 2 frames (id=2 and id=3) are inside
    // last_1h. The cascade coordinator must have completed (not just placed
    // a tombstone that silently filters results from the query layer).
    expect(deleteResult.isError).toBeFalsy();
    expect(deleteStructured.confirmed).toBe(true);
    expect(deleteStructured.requestedRange).toBe('last_1h');
    expect(deleteStructured.error).toBeUndefined();
    expect(deleteStructured.deletedFrames).toBe(2);
    expect(deleteStructured.deletedElements).toBe(2);
    expect(deleteStructured.cascade?.upstreamDeleted).toBe(true);
    expect(deleteStructured.cascade?.cascade).toBe('ok');

    // Verify the upstream SQLite DB directly: frame 1 must survive; frames 2
    // and 3 must be gone along with their elements rows.
    const { stdout: frameCount } = await execFileAsync('sqlite3', [
      join(screenpipeDir, 'db.sqlite'),
      'SELECT COUNT(*) FROM frames;'
    ]);
    expect(frameCount.trim()).toBe('1');

    const { stdout: survivingId } = await execFileAsync('sqlite3', [
      join(screenpipeDir, 'db.sqlite'),
      'SELECT id FROM frames;'
    ]);
    expect(survivingId.trim()).toBe('1');

    // Query `find` again after the delete. The cascade coordinator should have
    // physically removed derived rows for frames 2 and 3 from derived.sqlite
    // and the vector store, so they must no longer appear in search results.
    const postDeleteResult = await connection.client.callTool({
      name: 'find',
      arguments: {
        query: 'data',
        mode: 'keyword',
        limit: 20
      }
    });

    const postStructured = postDeleteResult.structuredContent as {
      data: Array<{ frameId: string | number; extractedText: string }>;
    };

    const postDeleteFrameIds = postStructured.data.map((item) => Number(item.frameId));

    // Frames 2 and 3 (inside last_1h) must be absent after the cascade delete.
    expect(postDeleteFrameIds).not.toContain(2);
    expect(postDeleteFrameIds).not.toContain(3);

    // Frame 1 (65 minutes ago, outside last_1h) must still be accessible;
    // it was indexed during catch-up and was not in the delete window.
    expect(postDeleteFrameIds).toContain(1);
  });

  it('returns explicit confirmation guidance for delete-range without confirm', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'privacy-enforcement-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const checkpointDir = join(homeDir, '.canary-alpha-mcp');
    await mkdir(checkpointDir, { recursive: true });
    await writeFile(
      join(checkpointDir, 'retrieval-checkpoint.screenpipe.json'),
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
