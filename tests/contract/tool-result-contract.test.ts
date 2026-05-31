import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { connectHttpClient, connectStdioClient } from '../helpers/mcp-client.js';
import { startEmbeddingStub } from '../helpers/embedding-stub.js';
import { startHttpServer } from '../helpers/start-http-server.js';
import { startScreenpipeStub } from '../helpers/screenpipe-stub.js';
import { writeTestConfig } from '../helpers/test-config.js';
import { testTempRoot } from '../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);

async function createSqliteFixture(databasePath: string, rowsByTable: Record<string, number>): Promise<void> {
  const statements = Object.entries(rowsByTable)
    .flatMap(([tableName, rowCount]) => {
      const inserts = Array.from({ length: rowCount }, (_, index) => (
        `INSERT INTO ${tableName}(payload) VALUES ('${tableName}-${index}-${'x'.repeat(400)}');`
      ));

      return [
        `CREATE TABLE ${tableName}(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);`,
        ...inserts
      ];
    })
    .join(' ');

  await mkdir(join(databasePath, '..'), { recursive: true });
  await execFileAsync('sqlite3', [databasePath, ['PRAGMA page_size = 4096;', 'PRAGMA journal_mode = DELETE;', statements].join(' ')]);
}

async function createScreenpipeDiagnosticsFixture(screenpipeDirectory: string): Promise<void> {
  const statements = [
    'PRAGMA page_size = 4096;',
    'PRAGMA journal_mode = DELETE;',
    'CREATE TABLE frames(id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, app_name TEXT, window_name TEXT, accessibility_text TEXT, accessibility_tree_json TEXT, full_text TEXT, capture_trigger TEXT);',
    'CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL, source TEXT NOT NULL DEFAULT \'accessibility\', role TEXT NOT NULL DEFAULT \'AXGroup\', text TEXT, properties TEXT, element_reuse_kind TEXT);',
    'CREATE TABLE ocr_text(frame_id INTEGER NOT NULL, text TEXT NOT NULL, app_name TEXT NOT NULL DEFAULT \'\', window_name TEXT);',
    'CREATE VIRTUAL TABLE frames_fts_content USING fts5(full_text);',
    `INSERT INTO frames(id, timestamp, app_name, window_name, accessibility_text, accessibility_tree_json, full_text, capture_trigger) VALUES
      (1, datetime('now', '-5 minutes'), 'Terminal', 'Claude Code', 'terminal prompt history terminal prompt history', '${'a'.repeat(3000)}', 'npm test failed in warp terminal and needs retry', 'manual-debug'),
      (2, datetime('now', '-4 minutes'), 'Terminal', 'Claude Code', 'terminal prompt history terminal prompt history', '${'b'.repeat(2800)}', 'npm test failed in warp terminal and needs retry', 'manual-debug'),
      (3, datetime('now', '-3 minutes'), 'Terminal', 'Claude Code', 'terminal prompt history terminal prompt history', '${'c'.repeat(2600)}', 'npm test failed in warp terminal and needs retry', 'window-focus'),
      (4, datetime('now', '-2 minutes'), 'Cursor', 'Docs', 'release checklist release checklist release checklist', '${'d'.repeat(400)}', 'release checklist release checklist release checklist', 'window-focus'),
      (5, datetime('now', '-1 minutes'), 'Cursor', 'Docs', 'release checklist release checklist release checklist', '${'e'.repeat(350)}', 'release checklist release checklist release checklist', NULL);`,
    `INSERT INTO elements(frame_id, source, role, text, properties, element_reuse_kind) VALUES
      (1, 'accessibility', 'AXTextArea', 'element-1-${'x'.repeat(300)}', '${'p'.repeat(900)}', 'reused'),
      (2, 'accessibility', 'AXTextArea', 'element-2-${'x'.repeat(300)}', '${'q'.repeat(850)}', 'reused'),
      (3, 'accessibility', 'AXTextArea', 'element-3-${'x'.repeat(300)}', '${'r'.repeat(800)}', 'fresh'),
      (4, 'accessibility', 'AXButton', 'element-4-${'x'.repeat(120)}', '${'s'.repeat(200)}', NULL),
      (5, 'ocr', 'block', 'ocr-block-${'o'.repeat(80)}', '${'t'.repeat(40)}', NULL);`,
    `INSERT INTO ocr_text(frame_id, text, app_name, window_name) VALUES
      (1, 'terminal output duplicated terminal output duplicated', 'Terminal', 'Claude Code'),
      (2, 'terminal output duplicated terminal output duplicated', 'Terminal', 'Claude Code'),
      (3, 'terminal output duplicated terminal output duplicated', 'Terminal', 'Claude Code'),
      (4, 'unique ocr text that should stay informative', 'Cursor', 'Docs');`,
    `INSERT INTO frames_fts_content(full_text) VALUES
      ('fts content ${'y'.repeat(500)}'),
      ('fts content ${'z'.repeat(300)}');`
  ].join(' ');

  await mkdir(screenpipeDirectory, { recursive: true });
  await execFileAsync('sqlite3', [join(screenpipeDirectory, 'db.sqlite'), statements]);
}

function minusMinutes(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe('focused v1 tool result contract', () => {
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

  it('returns stable structuredContent keys for focused v1 stdio tools', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'tool-result-contract-stdio-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const checkpointDir = join(homeDir, '.canary-alpha-mcp');
    await mkdir(checkpointDir, { recursive: true });
    await writeFile(
      join(checkpointDir, 'retrieval-checkpoint.json'),
      JSON.stringify({
        cursor: 'contract-checkpoint',
        timestamp: minusMinutes(2)
      }, null, 2),
      'utf8'
    );

    const filePath = join(homeDir, 'analysis-fixture.md');
    await writeFile(
      filePath,
      ['# Contract fixture', 'persistent memory note', 'focused v1 contract coverage line'].join('\n'),
      'utf8'
    );

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'contract-1',
          text: 'Focused v1 retrieval fixture for contract coverage',
          timestamp: minusMinutes(1),
          appName: 'Claude',
          sourceTypes: []
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

    // Note: legacy `search-screen` / `recent-activity` calls were removed by
    // task 8.1 of the work-activity-analysis spec. The replacement `find` /
    // `recall` / `inspect` tools have their own contract assertions once
    // tasks 8.2 - 8.5 land.

    const memoryWriteResult = await connection.client.callTool({
      name: 'memory-write',
      arguments: {
        scope: 'memory',
        content: 'persistent memory note',
        mode: 'append'
      }
    });

    expect(memoryWriteResult.isError).toBeFalsy();
    expect(memoryWriteResult.structuredContent).toEqual({
      scope: 'memory',
      mode: 'append',
      content: 'persistent memory note'
    });

    const memoryReadResult = await connection.client.callTool({
      name: 'memory-read',
      arguments: {
        scope: 'all'
      }
    });

    expect(memoryReadResult.isError).toBeFalsy();
    expect(memoryReadResult.structuredContent).toMatchObject({
      scope: 'all',
      content: expect.any(String),
      memory: expect.any(String),
      user: expect.any(String)
    });

    const fileAnalyzeResult = await connection.client.callTool({
      name: 'file-analyze',
      arguments: {
        path: filePath,
        question: 'Where is the focused v1 contract coverage line?'
      }
    });

    expect(fileAnalyzeResult.isError).toBeFalsy();
    expect(fileAnalyzeResult.structuredContent).toMatchObject({
      summary: expect.any(String),
      answer: expect.any(String),
      highlights: expect.any(Array),
      evidence: expect.any(Array),
      file: expect.objectContaining({
        path: filePath,
        name: 'analysis-fixture.md',
        extension: '.md',
        lineCount: 3
      })
    });

    const privacyStatusResult = await connection.client.callTool({
      name: 'privacy-control',
      arguments: {
        action: 'status'
      }
    });

    expect(privacyStatusResult.isError).toBeFalsy();
    expect(privacyStatusResult.structuredContent).toMatchObject({
      action: 'status',
      paused: expect.any(Boolean),
      excludedApps: expect.any(Array),
      allowedDeleteRanges: expect.arrayContaining(['last_1h', 'last_1d', 'all']),
      confirmationHint: expect.any(String),
      screenpipeStorage: {
        inspectionStatus: expect.stringMatching(/^(ready|degraded|unavailable)$/),
        databasePath: expect.any(String),
        totalBytes: expect.any(Number),
        dominantTables: expect.any(Array)
      }
    });
  });

  it('preserves stable error semantics for privacy-control confirmation failures', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'tool-result-contract-privacy-'));
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

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      action: 'delete-range',
      requestedRange: 'last_1d',
      confirmed: false,
      confirmationHint: expect.stringContaining('confirm=true'),
      error: {
        code: 'PRIVACY_CONFIRM_REQUIRED',
        message: expect.any(String)
      }
    });
  });

  it('keeps internal-status output aligned with the declared HTTP contract surface', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'tool-result-contract-http-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    const screenpipeHome = join(homeDir, '.screenpipe');
    await createScreenpipeDiagnosticsFixture(screenpipeHome);

    const port = 8776;
    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http',
      port
    });

    const server = await startHttpServer(port, { HOME: homeDir });
    cleanup.push(() => server.stop());

    const connection = await connectHttpClient(server.port);
    cleanup.push(() => connection.close());

    const result = await connection.client.callTool({
      name: 'internal-status',
      arguments: {}
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: 'ok',
      mode: 'http',
      host: expect.any(String),
      port: server.port,
      pid: server.pid,
      configFile: expect.any(String),
      retrieval: {
        checkpointExists: expect.any(Boolean),
        vectorStoreKind: expect.any(String),
        recoveryStatus: expect.stringMatching(/^(ready|needs-rebuild|degraded)$/)
      },
      screenpipeStorage: {
        inspectionStatus: expect.stringMatching(/^(ready|degraded|unavailable)$/),
        databasePath: expect.any(String),
        totalBytes: expect.any(Number),
        dominantTables: expect.any(Array),
        recentTextDuplication: {
          inspectionStatus: expect.stringMatching(/^(ready|degraded|unavailable)$/),
          windowMinutes: expect.any(Number),
          minTextLength: expect.any(Number),
          analyzedAt: expect.any(String),
          sources: expect.any(Array)
        },
        recentElementDuplication: {
          inspectionStatus: expect.stringMatching(/^(ready|degraded|unavailable)$/),
          windowMinutes: expect.any(Number),
          minTextLength: expect.any(Number),
          analyzedAt: expect.any(String),
          sampledRows: expect.any(Number),
          distinctElements: expect.any(Number),
          duplicateGroups: expect.any(Number),
          duplicateRows: expect.any(Number),
          sampledBytes: expect.any(Number),
          redundantBytes: expect.any(Number),
          topGroups: expect.any(Array)
        },
        recentCaptureReuse: {
          inspectionStatus: expect.stringMatching(/^(ready|degraded|unavailable)$/),
          windowMinutes: expect.any(Number),
          analyzedAt: expect.any(String),
          coverage: expect.stringMatching(/^(supported|partial|unsupported)$/),
          signals: expect.any(Array)
        }
      }
    });
    const structuredStatus = result.structuredContent as {
      screenpipeStorage: {
        inspectionStatus: string;
        totalBytes: number;
        dominantTables: Array<{ name: string; estimatedBytes: number }>;
        byteAttribution?: unknown;
        hotspots?: unknown;
        recentTextDuplication?: {
          inspectionStatus: string;
          sources: Array<{ key: string }>;
        };
        recentElementDuplication?: {
          inspectionStatus: string;
          duplicateRows: number;
        };
        recentCaptureReuse?: {
          inspectionStatus: string;
          coverage: string;
          signals: Array<{ key: string; matchedRows: number }>;
        };
      };
    };
    expect(structuredStatus.screenpipeStorage.inspectionStatus).toBe('ready');
    expect(structuredStatus.screenpipeStorage.totalBytes).toBeGreaterThan(0);
    expect(structuredStatus.screenpipeStorage.dominantTables).toHaveLength(3);
    expect(structuredStatus.screenpipeStorage.dominantTables[0].name).toBe('frames');
    expect(structuredStatus.screenpipeStorage.dominantTables[1].name).toBe('elements');
    expect(structuredStatus.screenpipeStorage.dominantTables[0].estimatedBytes).toBeGreaterThanOrEqual(
      structuredStatus.screenpipeStorage.dominantTables[1].estimatedBytes
    );
    expect(structuredStatus.screenpipeStorage.dominantTables[1].estimatedBytes).toBeGreaterThanOrEqual(
      structuredStatus.screenpipeStorage.dominantTables[2].estimatedBytes
    );
    expect(structuredStatus.screenpipeStorage.byteAttribution).toBeUndefined();
    expect(structuredStatus.screenpipeStorage.hotspots).toBeUndefined();
    expect(structuredStatus.screenpipeStorage.recentTextDuplication).toMatchObject({
      inspectionStatus: 'ready'
    });
    expect(structuredStatus.screenpipeStorage.recentTextDuplication?.sources.some((source) => source.key === 'frame-full-text')).toBe(true);
    expect(structuredStatus.screenpipeStorage.recentElementDuplication).toMatchObject({
      inspectionStatus: 'ready',
      duplicateRows: 3
    });
    expect(structuredStatus.screenpipeStorage.recentCaptureReuse).toMatchObject({
      inspectionStatus: 'ready',
      coverage: 'supported'
    });
    const captureReuseSignals = Object.fromEntries(
      (structuredStatus.screenpipeStorage.recentCaptureReuse?.signals ?? []).map((signal) => [signal.key, signal])
    );
    expect(captureReuseSignals['capture-trigger']).toMatchObject({
      matchedRows: 4
    });
    expect(captureReuseSignals['element-reuse']).toMatchObject({
      matchedRows: 3
    });
  });
});
