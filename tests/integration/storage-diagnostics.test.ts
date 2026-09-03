import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectStorageDiagnostics,
  formatStorageDiagnosticsReport,
  summarizeDominantArtifacts
} from '../../src/services/diagnostics/storage-diagnostics.js';
import { testTempRoot } from '../helpers/test-tmp.js';
import { writeTestConfig } from '../helpers/test-config.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cleanup: Array<() => Promise<void>> = [];

async function createScreenpipeFixture(screenpipeDirectory: string): Promise<void> {
  const statements = [
    'PRAGMA page_size = 4096;',
    'PRAGMA journal_mode = DELETE;',
    'CREATE TABLE frames(id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, app_name TEXT, window_name TEXT, accessibility_text TEXT, accessibility_tree_json TEXT, full_text TEXT);',
    'CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL, source TEXT NOT NULL DEFAULT \'accessibility\', role TEXT NOT NULL DEFAULT \'AXGroup\', text TEXT, properties TEXT);',
    'CREATE TABLE ocr_text(frame_id INTEGER NOT NULL, text TEXT NOT NULL, app_name TEXT NOT NULL DEFAULT \'\', window_name TEXT);',
    'CREATE VIRTUAL TABLE frames_fts_content USING fts5(full_text);',
    `INSERT INTO frames(id, timestamp, app_name, window_name, accessibility_text, accessibility_tree_json, full_text) VALUES
      (1, datetime('now', '-5 minutes'), 'Terminal', 'Claude Code', 'terminal prompt history terminal prompt history', '${'a'.repeat(3000)}', 'npm test failed in warp terminal and needs retry'),
      (2, datetime('now', '-4 minutes'), 'Terminal', 'Claude Code', 'terminal prompt history terminal prompt history', '${'b'.repeat(2800)}', 'npm test failed in warp terminal and needs retry'),
      (3, datetime('now', '-3 minutes'), 'Terminal', 'Claude Code', 'terminal prompt history terminal prompt history', '${'c'.repeat(2600)}', 'npm test failed in warp terminal and needs retry'),
      (4, datetime('now', '-2 minutes'), 'Cursor', 'Docs', 'release checklist release checklist release checklist', '${'d'.repeat(400)}', 'release checklist release checklist release checklist'),
      (5, datetime('now', '-1 minutes'), 'Cursor', 'Docs', 'release checklist release checklist release checklist', '${'e'.repeat(350)}', 'release checklist release checklist release checklist'),
      (6, datetime('now', '-10 minutes'), 'Safari', 'Reference', NULL, '${'f'.repeat(100)}', 'screenpipe docs worth keeping unique notes');`,
    `INSERT INTO elements(frame_id, source, role, text, properties) VALUES
      (1, 'accessibility', 'AXTextArea', 'element-1-${'x'.repeat(300)}', '${'p'.repeat(900)}'),
      (2, 'accessibility', 'AXTextArea', 'element-2-${'x'.repeat(300)}', '${'q'.repeat(850)}'),
      (3, 'accessibility', 'AXTextArea', 'element-3-${'x'.repeat(300)}', '${'r'.repeat(800)}'),
      (4, 'accessibility', 'AXButton', 'element-4-${'x'.repeat(120)}', '${'s'.repeat(200)}'),
      (5, 'ocr', 'block', 'ocr-block-${'o'.repeat(80)}', '${'t'.repeat(40)}');`,
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

async function createCaptureReuseFixture(screenpipeDirectory: string): Promise<void> {
  const statements = [
    'PRAGMA page_size = 4096;',
    'PRAGMA journal_mode = DELETE;',
    'CREATE TABLE frames(id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, app_name TEXT, window_name TEXT, full_text TEXT, capture_trigger TEXT);',
    'CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL, source TEXT NOT NULL DEFAULT \'accessibility\', role TEXT NOT NULL DEFAULT \'AXGroup\', text TEXT, properties TEXT, element_reuse_kind TEXT);',
    `INSERT INTO frames(id, timestamp, app_name, window_name, full_text, capture_trigger) VALUES
      (1, datetime('now', '-5 minutes'), 'Terminal', 'Claude Code', '${'t'.repeat(900)}', 'manual-debug'),
      (2, datetime('now', '-4 minutes'), 'Terminal', 'Claude Code', '${'u'.repeat(880)}', 'manual-debug'),
      (3, datetime('now', '-3 minutes'), 'Terminal', 'Claude Code', '${'v'.repeat(860)}', 'window-focus'),
      (4, datetime('now', '-2 minutes'), 'Cursor', 'Docs', '${'w'.repeat(300)}', 'window-focus'),
      (5, datetime('now', '-70 minutes'), 'Safari', 'Reference', '${'z'.repeat(200)}', 'manual-debug');`,
    `INSERT INTO elements(id, frame_id, source, role, text, properties, element_reuse_kind) VALUES
      (1, 1, 'accessibility', 'AXTextArea', 'terminal-1-${'x'.repeat(50)}', '${'p'.repeat(200)}', 'reused'),
      (2, 2, 'accessibility', 'AXTextArea', 'terminal-2-${'x'.repeat(50)}', '${'q'.repeat(180)}', 'reused'),
      (3, 3, 'accessibility', 'AXTextArea', 'terminal-3-${'x'.repeat(50)}', '${'r'.repeat(160)}', 'fresh'),
      (4, 4, 'accessibility', 'AXButton', 'docs-${'x'.repeat(30)}', '${'s'.repeat(40)}', NULL),
      (5, 5, 'accessibility', 'AXTextArea', 'old-${'x'.repeat(30)}', '${'o'.repeat(60)}', 'reused');`
  ].join(' ');

  await mkdir(screenpipeDirectory, { recursive: true });
  await execFileAsync('sqlite3', [join(screenpipeDirectory, 'db.sqlite'), statements]);
}

async function createPartialCaptureReuseFixture(screenpipeDirectory: string): Promise<void> {
  const statements = [
    'PRAGMA page_size = 4096;',
    'PRAGMA journal_mode = DELETE;',
    'CREATE TABLE frames(id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, app_name TEXT, window_name TEXT, full_text TEXT);',
    'CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL, source TEXT NOT NULL DEFAULT \'accessibility\', role TEXT NOT NULL DEFAULT \'AXGroup\', text TEXT, properties TEXT, element_reuse_kind TEXT);',
    `INSERT INTO frames(id, timestamp, app_name, window_name, full_text) VALUES
      (1, datetime('now', '-5 minutes'), 'Terminal', 'Claude Code', '${'a'.repeat(700)}'),
      (2, datetime('now', '-4 minutes'), 'Terminal', 'Claude Code', '${'b'.repeat(680)}'),
      (3, datetime('now', '-3 minutes'), 'Cursor', 'Docs', '${'c'.repeat(220)}');`,
    `INSERT INTO elements(id, frame_id, source, role, text, properties, element_reuse_kind) VALUES
      (1, 1, 'accessibility', 'AXTextArea', 'terminal-1-${'x'.repeat(40)}', '${'p'.repeat(210)}', 'reused'),
      (2, 2, 'accessibility', 'AXTextArea', 'terminal-2-${'x'.repeat(40)}', '${'q'.repeat(180)}', 'reused'),
      (3, 3, 'accessibility', 'AXButton', 'docs-${'x'.repeat(20)}', '${'r'.repeat(40)}', 'fresh');`
  ].join(' ');

  await mkdir(screenpipeDirectory, { recursive: true });
  await execFileAsync('sqlite3', [join(screenpipeDirectory, 'db.sqlite'), statements]);
}

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

afterEach(async () => {
  while (cleanup.length > 0) {
    const task = cleanup.pop();
    if (task) {
      await task();
    }
  }
});

async function writeSizedFile(filePath: string, size: number): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, 'x'.repeat(size), 'utf8');
}

describe('storage diagnostics', () => {
  it('reports per-class bytes and dominant artifact ranking without double counting', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'storage-diagnostics-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const screenpipeDirectory = join(root, '.screenpipe');
    const appDirectory = join(root, '.computer-history-mcp');
    const retrievalArtifactsDirectory = join(root, '.computer-history-mcp', 'chroma');

    await createSqliteFixture(join(screenpipeDirectory, 'db.sqlite'), {
      frames: 12,
      elements: 4,
      ocr_text: 6,
      frames_fts_content: 1
    });
    await writeSizedFile(join(screenpipeDirectory, 'db.sqlite-wal'), 20);
    await writeSizedFile(join(screenpipeDirectory, 'db.sqlite-shm'), 5);
    await writeSizedFile(join(screenpipeDirectory, 'data', 'frames.bin'), 40);
    await writeSizedFile(join(screenpipeDirectory, 'data', 'nested', 'ocr.json'), 10);
    await writeSizedFile(join(screenpipeDirectory, 'pi-agent', 'agent-cache.bin'), 30);
    await writeSizedFile(join(screenpipeDirectory, 'screenpipe.2026-04-17.0.log'), 7);
    await writeSizedFile(join(screenpipeDirectory, 'notes.txt'), 99);

    await writeSizedFile(join(retrievalArtifactsDirectory, 'vector-store.json'), 17);
    await writeSizedFile(join(retrievalArtifactsDirectory, 'retrieval-checkpoint.json'), 19);
    await writeSizedFile(join(retrievalArtifactsDirectory, 'runtime-processes', 'active.json'), 29);
    await writeSizedFile(join(retrievalArtifactsDirectory, 'rebuild-index.lock'), 31);

    await writeSizedFile(join(appDirectory, 'privacy-state.json'), 23);
    await writeSizedFile(join(appDirectory, 'logs', 'service.log'), 11);
    await writeSizedFile(join(appDirectory, 'memory', 'memory.md'), 13);

    const report = await collectStorageDiagnostics({
      appDirectory,
      retrievalArtifactsDirectory,
      screenpipeDirectory
    });

    expect(report.artifacts).toEqual([
      expect.objectContaining({ key: 'screenpipe-sqlite-main', exists: true }),
      expect.objectContaining({ key: 'screenpipe-sqlite-wal', bytes: 20, exists: true }),
      expect.objectContaining({ key: 'screenpipe-sqlite-shm', bytes: 5, exists: true }),
      expect.objectContaining({ key: 'screenpipe-data', bytes: 50, exists: true }),
      expect.objectContaining({ key: 'screenpipe-pi-agent', bytes: 30, exists: true }),
      expect.objectContaining({ key: 'screenpipe-logs', bytes: 7, exists: true }),
      expect.objectContaining({ key: 'mcp-vector-store', bytes: 17, exists: true }),
      expect.objectContaining({ key: 'mcp-checkpoint', bytes: 19, exists: true }),
      expect.objectContaining({ key: 'mcp-runtime-state', bytes: 83, exists: true }),
      expect.objectContaining({ key: 'mcp-logs', bytes: 11, exists: true }),
      expect.objectContaining({ key: 'mcp-memory', bytes: 13, exists: true })
    ]);
    expect(report.screenpipeSqlite).toMatchObject({
      inspectionStatus: 'ready',
      databasePath: join(screenpipeDirectory, 'db.sqlite')
    });
    expect(report.screenpipeSqlite.totalBytes).toBeGreaterThan(0);
    expect(report.screenpipeSqlite.dominantTables).toHaveLength(3);
    expect(report.screenpipeSqlite.dominantTables[0].name).toBe('frames');
    expect(report.screenpipeSqlite.dominantTables[1].name).toBe('elements');
    expect(report.screenpipeSqlite.dominantTables[0].estimatedBytes).toBeGreaterThanOrEqual(report.screenpipeSqlite.dominantTables[1].estimatedBytes);
    expect(report.screenpipeSqlite.dominantTables[1].estimatedBytes).toBeGreaterThanOrEqual(report.screenpipeSqlite.dominantTables[2].estimatedBytes);
    expect(report.screenpipeSqlite.byteAttribution).toMatchObject({
      buckets: expect.arrayContaining([
        expect.objectContaining({ key: 'frames' }),
        expect.objectContaining({ key: 'elements' }),
        expect.objectContaining({ key: 'fts' })
      ])
    });
    const attributionBuckets = Object.fromEntries(
      (report.screenpipeSqlite.byteAttribution?.buckets ?? []).map((bucket) => [bucket.key, bucket])
    );
    expect(attributionBuckets.frames.estimatedBytes).toBeGreaterThanOrEqual(attributionBuckets.elements.estimatedBytes);
    expect(attributionBuckets.fts.tables).toContain('frames_fts_content');
    expect(report.totalBytes).toBeGreaterThan(255);
    expect(report.dominantArtifacts.slice(0, 4).map((artifact) => artifact.key)).toEqual([
      'screenpipe-sqlite-main',
      'mcp-runtime-state',
      'screenpipe-data',
      'screenpipe-pi-agent'
    ]);
    expect(report.paths).toEqual({
      appDirectory,
      retrievalArtifactsDirectory,
      screenpipeDirectory
    });
  });

  it('reports bounded recent-window text duplication signals for low-value repeated plaintext', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'storage-diagnostics-duplication-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const screenpipeDirectory = join(root, '.screenpipe');
    await createScreenpipeFixture(screenpipeDirectory);

    const report = await collectStorageDiagnostics({
      appDirectory: join(root, '.computer-history-mcp'),
      retrievalArtifactsDirectory: join(root, '.computer-history-mcp', 'chroma'),
      screenpipeDirectory
    });

    expect(report.screenpipeSqlite.recentTextDuplication).toMatchObject({
      inspectionStatus: 'ready',
      windowMinutes: 60,
      minTextLength: 24
    });
    expect(report.screenpipeSqlite.recentElementDuplication).toMatchObject({
      inspectionStatus: 'ready',
      windowMinutes: 60,
      minTextLength: 24
    });

    const duplicationSources = Object.fromEntries(
      (report.screenpipeSqlite.recentTextDuplication?.sources ?? []).map((source) => [source.key, source])
    );

    expect(duplicationSources['frame-full-text']).toMatchObject({
      sampledRows: 6,
      duplicateGroups: 2
    });
    expect(duplicationSources['frame-full-text'].duplicateRows).toBeGreaterThanOrEqual(5);
    expect(duplicationSources['frame-full-text'].redundantCharacters).toBeGreaterThan(0);
    expect(duplicationSources['frame-full-text'].topGroups[0]).toMatchObject({
      appName: 'Terminal',
      windowName: 'Claude Code',
      occurrences: 3
    });

    expect(duplicationSources['frame-accessibility-text']).toMatchObject({
      sampledRows: 5,
      duplicateGroups: 2
    });
    expect(duplicationSources['ocr-text']).toMatchObject({
      sampledRows: 4,
      duplicateGroups: 1,
      duplicateRows: 3
    });

    expect(report.screenpipeSqlite.recentElementDuplication?.sampledRows).toBe(4);
    expect(report.screenpipeSqlite.recentElementDuplication?.duplicateGroups).toBe(1);
    expect(report.screenpipeSqlite.recentElementDuplication?.duplicateRows).toBe(3);
    expect(report.screenpipeSqlite.recentElementDuplication?.redundantBytes).toBeGreaterThan(0);
    expect(report.screenpipeSqlite.recentElementDuplication?.topGroups[0]).toMatchObject({
      appName: 'Terminal',
      windowName: 'Claude Code',
      source: 'accessibility',
      role: 'AXTextArea',
      occurrences: 3
    });
  });


  it('separates recent duplicate growth from unique heavy recent samples', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'storage-diagnostics-recent-heavy-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const screenpipeDirectory = join(root, '.screenpipe');
    await createScreenpipeFixture(screenpipeDirectory);

    const report = await collectStorageDiagnostics({
      appDirectory: join(root, '.computer-history-mcp'),
      retrievalArtifactsDirectory: join(root, '.computer-history-mcp', 'chroma'),
      screenpipeDirectory
    });

    expect(report.screenpipeSqlite.recentTextDuplication).toMatchObject({
      inspectionStatus: 'ready'
    });
    expect(report.screenpipeSqlite.recentHeavyGrowth).toMatchObject({
      inspectionStatus: 'ready',
      windowMinutes: 60,
      sampleLimit: 1000
    });

    expect(report.screenpipeSqlite.recentHeavyGrowth?.topSamples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appName: 'Terminal',
          windowName: 'Claude Code',
          duplicateSignal: 'duplicate-heavy'
        }),
        expect.objectContaining({
          appName: 'Safari',
          windowName: 'Reference',
          duplicateSignal: 'unique-heavy'
        })
      ])
    );
  });

  it('highlights the heaviest recent time slice even when the top sample is uniquely large', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'storage-diagnostics-recent-heavy-slice-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const screenpipeDirectory = join(root, '.screenpipe');
    await createScreenpipeFixture(screenpipeDirectory);

    const report = await collectStorageDiagnostics({
      appDirectory: join(root, '.computer-history-mcp'),
      retrievalArtifactsDirectory: join(root, '.computer-history-mcp', 'chroma'),
      screenpipeDirectory
    });

    expect(report.screenpipeSqlite.recentHeavyGrowth?.topSamples[0]).toMatchObject({
      appName: 'Safari',
      windowName: 'Reference',
      duplicateSignal: 'unique-heavy'
    });
    expect(report.screenpipeSqlite.recentHeavyGrowth?.topTimeSlices[0]).toMatchObject({
      appName: 'Terminal',
      windowName: 'Claude Code'
    });
    expect(report.screenpipeSqlite.recentHeavyGrowth?.topTimeSlices[0].samples).toBeGreaterThan(1);
    expect(report.screenpipeSqlite.recentHeavyGrowth?.topTimeSlices[0].estimatedBytes).toBeGreaterThan(
      report.screenpipeSqlite.recentHeavyGrowth?.topSamples[0].estimatedBytes ?? 0
    );
  });

  it('treats unique accessibility-heavy frames as unique-heavy even when full_text is absent', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'storage-diagnostics-recent-heavy-accessibility-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const screenpipeDirectory = join(root, '.screenpipe');
    const statements = [
      'PRAGMA page_size = 4096;',
      'PRAGMA journal_mode = DELETE;',
      'CREATE TABLE frames(id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, app_name TEXT, window_name TEXT, accessibility_text TEXT, accessibility_tree_json TEXT, full_text TEXT);',
      `INSERT INTO frames(id, timestamp, app_name, window_name, accessibility_text, accessibility_tree_json, full_text) VALUES
        (1, datetime('now', '-5 minutes'), 'Mail', 'Inbox', 'small note', '${'a'.repeat(2400)}', NULL),
        (2, datetime('now', '-4 minutes'), 'Mail', 'Inbox', 'small note', '${'b'.repeat(2200)}', NULL),
        (3, datetime('now', '-3 minutes'), 'Notes', 'Draft', 'small note', '${'c'.repeat(800)}', 'shared tiny full text'),
        (4, datetime('now', '-2 minutes'), 'Notes', 'Draft', 'small note', '${'d'.repeat(780)}', 'shared tiny full text');`
    ].join(' ');

    await mkdir(screenpipeDirectory, { recursive: true });
    await execFileAsync('sqlite3', [join(screenpipeDirectory, 'db.sqlite'), statements]);

    const report = await collectStorageDiagnostics({
      appDirectory: join(root, '.computer-history-mcp'),
      retrievalArtifactsDirectory: join(root, '.computer-history-mcp', 'chroma'),
      screenpipeDirectory
    });

    expect(report.screenpipeSqlite.recentHeavyGrowth?.topSamples[0]).toMatchObject({
      appName: 'Mail',
      windowName: 'Inbox',
      duplicateSignal: 'unique-heavy'
    });
    expect(report.screenpipeSqlite.recentHeavyGrowth?.topSamples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appName: 'Notes',
          windowName: 'Draft',
          duplicateSignal: 'duplicate-heavy'
        })
      ])
    );
  });

  it('reports storage hotspots for dominant fields apps and accessibility roles', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'storage-diagnostics-hotspots-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const screenpipeDirectory = join(root, '.screenpipe');
    await createScreenpipeFixture(screenpipeDirectory);

    const report = await collectStorageDiagnostics({
      appDirectory: join(root, '.computer-history-mcp'),
      retrievalArtifactsDirectory: join(root, '.computer-history-mcp', 'chroma'),
      screenpipeDirectory
    });

    expect(report.screenpipeSqlite.hotspots).toMatchObject({
      inspectionStatus: 'ready'
    });

    expect(report.screenpipeSqlite.hotspots?.dominantFields[0]).toMatchObject({
      key: 'frames.accessibility_tree_json'
    });
    expect(report.screenpipeSqlite.hotspots?.dominantFields.some((field) => field.key === 'elements.properties')).toBe(true);
    expect(report.screenpipeSqlite.hotspots?.dominantFields.some((field) => field.key === 'elements.text')).toBe(true);
    expect(report.screenpipeSqlite.hotspots?.dominantApps[0]).toMatchObject({
      appName: 'Terminal'
    });
    expect(report.screenpipeSqlite.hotspots?.dominantAccessibilityRoles[0]).toMatchObject({
      source: 'accessibility',
      role: 'AXTextArea'
    });
  });

  it('reports recent capture and reuse signals when schema metadata exists', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'storage-diagnostics-capture-reuse-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const screenpipeDirectory = join(root, '.screenpipe');
    await createCaptureReuseFixture(screenpipeDirectory);

    const report = await collectStorageDiagnostics({
      appDirectory: join(root, '.computer-history-mcp'),
      retrievalArtifactsDirectory: join(root, '.computer-history-mcp', 'chroma'),
      screenpipeDirectory
    });

    expect(report.screenpipeSqlite.recentCaptureReuse).toMatchObject({
      inspectionStatus: 'ready',
      coverage: 'supported'
    });

    const signals = Object.fromEntries(
      (report.screenpipeSqlite.recentCaptureReuse?.signals ?? []).map((signal) => [signal.key, signal])
    );

    expect(signals['capture-trigger']).toMatchObject({
      sampledRows: 4,
      matchedRows: 4
    });
    expect(signals['capture-trigger'].topValues[0]).toMatchObject({
      value: 'manual-debug',
      rows: 2
    });
    expect(signals['element-reuse']).toMatchObject({
      sampledRows: 4,
      matchedRows: 3
    });
    expect(signals['element-reuse'].topValues[0]).toMatchObject({
      value: 'reused',
      rows: 2
    });
  });

  it('degrades safely when capture and reuse metadata columns are absent', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'storage-diagnostics-capture-reuse-missing-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const screenpipeDirectory = join(root, '.screenpipe');
    await createScreenpipeFixture(screenpipeDirectory);

    const report = await collectStorageDiagnostics({
      appDirectory: join(root, '.computer-history-mcp'),
      retrievalArtifactsDirectory: join(root, '.computer-history-mcp', 'chroma'),
      screenpipeDirectory
    });

    expect(report.screenpipeSqlite.recentCaptureReuse).toMatchObject({
      inspectionStatus: 'unavailable',
      coverage: 'unsupported',
      signals: []
    });
  });

  it('uses partial schema coverage when only one reuse-related signal exists', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'storage-diagnostics-capture-reuse-partial-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const screenpipeDirectory = join(root, '.screenpipe');
    await createPartialCaptureReuseFixture(screenpipeDirectory);

    const report = await collectStorageDiagnostics({
      appDirectory: join(root, '.computer-history-mcp'),
      retrievalArtifactsDirectory: join(root, '.computer-history-mcp', 'chroma'),
      screenpipeDirectory
    });

    expect(report.screenpipeSqlite.recentCaptureReuse).toMatchObject({
      inspectionStatus: 'ready',
      coverage: 'partial'
    });
    expect(report.screenpipeSqlite.recentCaptureReuse?.signals).toHaveLength(1);
    expect(report.screenpipeSqlite.recentCaptureReuse?.signals[0]).toMatchObject({
      key: 'element-reuse',
      matchedRows: 3
    });
  });

  it('treats missing artifact roots as zero-byte diagnostics instead of failing', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'storage-diagnostics-missing-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const report = await collectStorageDiagnostics({
      appDirectory: join(root, '.computer-history-mcp'),
      retrievalArtifactsDirectory: join(root, '.computer-history-mcp', 'chroma'),
      screenpipeDirectory: join(root, '.screenpipe')
    });

    expect(report.totalBytes).toBe(0);
    expect(report.artifacts.every((artifact) => artifact.bytes === 0)).toBe(true);
    expect(report.artifacts.every((artifact) => artifact.exists === false)).toBe(true);
    expect(report.screenpipeSqlite).toMatchObject({
      inspectionStatus: 'unavailable',
      totalBytes: 0,
      dominantTables: [],
      hotspots: {
        inspectionStatus: 'unavailable'
      }
    });
  });

  it('prints sqlite attribution and duplication signals through the public storage:diagnostics CLI', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'storage-diagnostics-cli-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const homeDir = join(root, 'home');
    const screenpipeDirectory = join(homeDir, '.screenpipe');
    const retrievalArtifactsDirectory = join(homeDir, '.computer-history-mcp', 'chroma');

    await createScreenpipeFixture(screenpipeDirectory);
    await writeSizedFile(join(retrievalArtifactsDirectory, 'vector-store.json'), 17);
    await writeSizedFile(join(retrievalArtifactsDirectory, 'retrieval-checkpoint.json'), 19);

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: 'http://127.0.0.1:11434/v1',
      screenpipeBaseUrl: 'http://127.0.0.1:3030',
      vectorStorePath: retrievalArtifactsDirectory
    });

    const { stdout } = await execFileAsync('npm', ['run', '--silent', 'storage:diagnostics'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      },
      maxBuffer: 10 * 1024 * 1024
    });

    expect(stdout).toContain('Screenpipe SQLite tables:');
    expect(stdout).toContain('- Byte attribution:');
    expect(stdout).toContain('Frame tables:');
    expect(stdout).toContain('Element tables:');
    expect(stdout).toContain('FTS tables:');
    expect(stdout).toContain('Screenpipe storage hotspots:');
    expect(stdout).toContain('frames.accessibility_tree_json');
    expect(stdout).toContain('Terminal:');
    expect(stdout).toContain('accessibility/AXTextArea');
    expect(stdout).toContain('Recent text duplication sample:');
    expect(stdout).toContain('Frame full_text:');
    expect(stdout).toContain('Recent accessibility element duplication:');
    expect(stdout).toContain('accessibility/AXTextArea');
    expect(stdout).toContain('Recent capture/reuse signals:');
    expect(stdout).toContain('Coverage: unsupported');
    expect(stdout).toContain('Signals: unavailable');
    expect(stdout).toContain('Top artifacts:');
    expect(stdout).toContain('Screenpipe SQLite main database');
    expect(stdout).not.toContain('Config warning:');
  });

  it('formats a readable diagnostics report and top-artifact summary', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'storage-diagnostics-format-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const screenpipeDirectory = join(root, '.screenpipe');
    await createScreenpipeFixture(screenpipeDirectory);

    const report = await collectStorageDiagnostics({
      appDirectory: join(root, '.computer-history-mcp'),
      retrievalArtifactsDirectory: join(root, '.computer-history-mcp', 'chroma'),
      screenpipeDirectory
    });

    expect(formatStorageDiagnosticsReport(report)).toContain('Screenpipe SQLite tables:');
    expect(formatStorageDiagnosticsReport(report)).toContain('- Inspection: ready');
    expect(formatStorageDiagnosticsReport(report)).toContain('- Byte attribution:');
    expect(formatStorageDiagnosticsReport(report)).toContain('Frame tables:');
    expect(formatStorageDiagnosticsReport(report)).toContain('FTS tables:');
    expect(formatStorageDiagnosticsReport(report)).toContain('- Dominant tables:');
    expect(formatStorageDiagnosticsReport(report)).toContain('frames:');
    expect(formatStorageDiagnosticsReport(report)).toContain('Screenpipe storage hotspots:');
    expect(formatStorageDiagnosticsReport(report)).toContain('frames.accessibility_tree_json');
    expect(formatStorageDiagnosticsReport(report)).toContain('Terminal:');
    expect(formatStorageDiagnosticsReport(report)).toContain('accessibility/AXTextArea');
    expect(formatStorageDiagnosticsReport(report)).toContain('Recent text duplication sample:');
    expect(formatStorageDiagnosticsReport(report)).toContain('Recent heavy growth sample:');
    expect(formatStorageDiagnosticsReport(report)).toContain('unique-heavy');
    expect(formatStorageDiagnosticsReport(report)).toContain('Top time slices:');
    expect(summarizeDominantArtifacts(report, 1)).toEqual([
      expect.stringContaining(`at ${join(screenpipeDirectory, 'db.sqlite')}`)
    ]);
  });
});
