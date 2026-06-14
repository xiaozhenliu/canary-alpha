/**
 * Integration tests: internal-status three new blocks end-to-end (task 9.6)
 *
 * Constructs a complete SQLite + vector store fixture, calls
 * BootstrapStatusService.getStatus() directly, and asserts that the three new
 * blocks (capture, ingestionMix, diskBudget) are populated as expected.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { BootstrapStatusService } from '../../../src/services/bootstrap-status-service.js';
import { InMemoryVectorStore } from '../../../src/services/retrieval/vector-store.js';
import type { AppConfig } from '../../../src/types/app-config.js';
import type { VectorStoreRecord } from '../../../src/services/retrieval/types.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(testTempRoot(), 'internal-status-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Creates a minimal SQLite db with a frames table and optional rows. */
async function createSqliteDb(dir: string, rows: Array<{ id: number; timestamp: string }>): Promise<string> {
  const dbPath = join(dir, 'db.sqlite');
  await mkdir(dir, { recursive: true });
  const schema = [
    'PRAGMA journal_mode = WAL;',
    'CREATE TABLE frames(id INTEGER PRIMARY KEY, content_hash INTEGER, accessibility_tree_json TEXT, timestamp TEXT NOT NULL);',
    'CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL);'
  ].join('\n');
  await execFileAsync('sqlite3', [dbPath, schema]);
  for (const row of rows) {
    await execFileAsync('sqlite3', [dbPath, `INSERT INTO frames VALUES (${row.id}, NULL, NULL, '${row.timestamp}');`]);
  }
  return dbPath;
}


/** Builds a minimal AppConfig for testing. */
function makeConfig(diskBudgetBytes: number | null = null): AppConfig {
  return {
    server: { mode: 'stdio', host: '127.0.0.1', port: 8765, maxConnections: 10 },
    logging: { level: 'info' },
    screenpipe: { url: 'http://localhost:3030' },
    providers: { embeddings: { kind: 'none' } },
    vectorStore: { kind: 'memory' },
    retrieval: {
      freshnessWindowMinutes: 15,
      pollIntervalSeconds: 30,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 500
    },
    routines: { enabled: false, definitionsPath: '', historyPath: '' },
    paths: { configFile: '', logDirectory: '', serviceLogFile: '', derivedDatabase: '' },
    trim: { enabled: false, intervalSeconds: 3600 },
    capture: { provider: 'screenpipe', livenessThresholdSeconds: 120, permissionsGracePeriodSeconds: 60 },
    storage: { diskBudgetBytes, retentionDays: 7 },
    privacy: { excludeApps: [], secureAxRoles: [] },
    analysis: {
      sessions: { idleThresholdSeconds: 120 },
      summary: { provider: 'template', remoteLlmTimeoutMs: 30000 },
      embeddings: { topK: 20, minScore: 0 }
    },
    llm: { model: 'gpt-4o-mini' }
  } as AppConfig;
}

/** Stub CheckpointStore that returns null. */
const stubCheckpointStore = {
  readLatest: async () => null,
  writeLatest: async () => {},
  reset: async () => {}
};

/** Builds a VectorStoreRecord with given sourceTypes in metadata. */
function makeVectorRecord(id: string, sourceTypes: string[], timestamp: string): VectorStoreRecord {
  return {
    id,
    text: `record-${id}`,
    timestamp,
    sourceTypes,
    metadata: { sourceTypes }
  };
}


// ---------------------------------------------------------------------------
// Scenario A: budget=null, no db.sqlite (ENOENT path)
// Note: BootstrapStatusService now reads the injected `screenpipeDirectory`
// (a per-test fixture dir), so these cases exercise the real ENOENT path
// against an isolated empty directory rather than the developer's real
// ~/.screenpipe. We also keep the direct IngestionObservabilityService cases
// below for the lowest-level ENOENT contract.
// ---------------------------------------------------------------------------

import {
  IngestionObservabilityService,
  type IngestionObservabilityServiceDeps
} from '../../../src/services/diagnostics/ingestion-observability-service.js';

const stubRuntimeRegistry = {
  hasActiveProcess: async () => false,
  getProcessStartedAt: async () => null as string | null
};

describe('IngestionObservabilityService: ENOENT path (no db.sqlite)', () => {
  it('capture.state == "unknown" with non-empty reason when db.sqlite is absent', async () => {
    const dir = await createTempDir();
    // No db.sqlite in dir
    const deps: IngestionObservabilityServiceDeps = {
      screenpipeDirectory: dir,
      vectorStore: new InMemoryVectorStore({ kind: 'memory' }),
      runtimeRegistry: stubRuntimeRegistry,
      config: makeConfig(null),
      now: () => new Date()
    };
    const svc = new IngestionObservabilityService(deps);
    const result = await svc.collect();

    expect(result.capture.state).toBe('unknown');
    expect(result.capture.reason).toBeTruthy();
    expect(result.capture.livenessThresholdSeconds).toBe(120);
  });

  it('diskBudget.budgetBytes == null and headroomBytes == null when budget not configured', async () => {
    const dir = await createTempDir();
    const deps: IngestionObservabilityServiceDeps = {
      screenpipeDirectory: dir,
      vectorStore: new InMemoryVectorStore({ kind: 'memory' }),
      runtimeRegistry: stubRuntimeRegistry,
      config: makeConfig(null),
      now: () => new Date()
    };
    const svc = new IngestionObservabilityService(deps);
    const result = await svc.collect();

    expect(result.diskBudget.budgetBytes).toBeNull();
    expect(result.diskBudget.headroomBytes).toBeNull();
    expect(result.diskBudget.warning).toBeUndefined();
  });
});

describe('internal-status: budget=null, no db.sqlite (ENOENT)', () => {
  it('capture block: state is one of the five valid values and livenessThresholdSeconds is set', async () => {
    const dir = await createTempDir();
    // No db.sqlite created in dir
    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    const validStates = ['ok', 'idle', 'process-down', 'permissions-missing', 'unknown'];
    expect(status.capture).toBeDefined();
    expect(validStates).toContain(status.capture!.state);
    // When state != "ok", reason must be non-empty (R6.4)
    if (status.capture!.state !== 'ok') {
      expect(status.capture!.reason).toBeTruthy();
      expect(typeof status.capture!.reason).toBe('string');
    }
    expect(status.capture!.livenessThresholdSeconds).toBe(120);
  });

  it('capture block: livenessThresholdSeconds equals config value (120)', async () => {
    const dir = await createTempDir();
    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    expect(status.capture!.livenessThresholdSeconds).toBe(120);
  });

  it('ingestionMix block: windowSeconds == 86400, counts are non-negative', async () => {
    const dir = await createTempDir();
    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    expect(status.ingestionMix).toBeDefined();
    expect(status.ingestionMix!.windowSeconds).toBe(86400);
    expect(status.ingestionMix!.accessibilityCount).toBeGreaterThanOrEqual(0);
    expect(status.ingestionMix!.ocrCount).toBeGreaterThanOrEqual(0);
    expect(status.ingestionMix!.ratio).toBeGreaterThanOrEqual(0);
    expect(status.ingestionMix!.ratio).toBeLessThanOrEqual(1);
  });

  it('diskBudget block: budgetBytes=null, headroomBytes=null when budget is not configured', async () => {
    const dir = await createTempDir();
    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    expect(status.diskBudget).toBeDefined();
    expect(status.diskBudget!.budgetBytes).toBeNull();
    expect(status.diskBudget!.headroomBytes).toBeNull();
    expect(status.diskBudget!.warning).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// Scenario B: db.sqlite exists with recent frames, vector store has records
// ---------------------------------------------------------------------------

describe('internal-status: db.sqlite with recent frames + vector store records', () => {
  it('capture block: state is one of the five valid values', async () => {
    const dir = await createTempDir();
    const now = new Date();
    // Insert a frame with a recent timestamp (within liveness window)
    const recentTs = new Date(now.getTime() - 30_000).toISOString(); // 30s ago
    await createSqliteDb(dir, [{ id: 1, timestamp: recentTs }]);

    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    const validStates = ['ok', 'idle', 'process-down', 'permissions-missing', 'unknown'];
    expect(validStates).toContain(status.capture!.state);
  });

  it('capture block: livenessThresholdSeconds is a positive integer', async () => {
    const dir = await createTempDir();
    const recentTs = new Date(Date.now() - 30_000).toISOString();
    await createSqliteDb(dir, [{ id: 1, timestamp: recentTs }]);

    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    expect(Number.isInteger(status.capture!.livenessThresholdSeconds)).toBe(true);
    expect(status.capture!.livenessThresholdSeconds).toBeGreaterThan(0);
  });

  it('ingestionMix block: accessibilityCount reflects vector store records', async () => {
    const dir = await createTempDir();
    const recentTs = new Date(Date.now() - 30_000).toISOString();
    await createSqliteDb(dir, [{ id: 1, timestamp: recentTs }]);

    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });

    // Insert 3 accessibility records and 2 OCR-only records within the 24h window
    const now = new Date();
    const records: VectorStoreRecord[] = [
      makeVectorRecord('ax-1', ['accessibility'], new Date(now.getTime() - 1_000).toISOString()),
      makeVectorRecord('ax-2', ['accessibility'], new Date(now.getTime() - 2_000).toISOString()),
      makeVectorRecord('ax-3', ['accessibility'], new Date(now.getTime() - 3_000).toISOString()),
      makeVectorRecord('ocr-1', ['ocr'], new Date(now.getTime() - 4_000).toISOString()),
      makeVectorRecord('ocr-2', ['ocr'], new Date(now.getTime() - 5_000).toISOString())
    ];
    await vectorStore.upsert(records);

    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    expect(status.ingestionMix!.accessibilityCount).toBe(3);
    expect(status.ingestionMix!.ocrCount).toBe(2);
    expect(status.ingestionMix!.ratio).toBeCloseTo(3 / 5, 5);
  });

  it('ingestionMix block: windowSeconds is always 86400', async () => {
    const dir = await createTempDir();
    const recentTs = new Date(Date.now() - 30_000).toISOString();
    await createSqliteDb(dir, [{ id: 1, timestamp: recentTs }]);

    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    expect(status.ingestionMix!.windowSeconds).toBe(86400);
  });
});


// ---------------------------------------------------------------------------
// Scenario C: budget=some_value, db.sqlite exists
// ---------------------------------------------------------------------------

describe('internal-status: budget=some_value with db.sqlite', () => {
  it('diskBudget block: budgetBytes and headroomBytes are set when budget is configured', async () => {
    const dir = await createTempDir();
    const recentTs = new Date(Date.now() - 30_000).toISOString();
    await createSqliteDb(dir, [{ id: 1, timestamp: recentTs }]);

    const budget = 50 * 1024 * 1024; // 50 MB
    const config = makeConfig(budget);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    expect(status.diskBudget!.budgetBytes).toBe(budget);
    expect(status.diskBudget!.headroomBytes).not.toBeNull();
    expect(typeof status.diskBudget!.headroomBytes).toBe('number');
    expect(status.diskBudget!.headroomBytes).toBeGreaterThanOrEqual(0);
  });

  it('diskBudget block: headroomBytes == max(0, budget - currentSize)', async () => {
    const dir = await createTempDir();
    const recentTs = new Date(Date.now() - 30_000).toISOString();
    await createSqliteDb(dir, [{ id: 1, timestamp: recentTs }]);

    const budget = 50 * 1024 * 1024; // 50 MB
    const config = makeConfig(budget);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    const { budgetBytes, currentSizeBytes, headroomBytes } = status.diskBudget!;
    expect(headroomBytes).toBe(Math.max(0, (budgetBytes as number) - currentSizeBytes));
  });

  it('diskBudget block: no warning when db is well under 90% of budget', async () => {
    const dir = await createTempDir();
    const recentTs = new Date(Date.now() - 30_000).toISOString();
    await createSqliteDb(dir, [{ id: 1, timestamp: recentTs }]);

    // Use a very large budget so the tiny test db is well under 90%
    const budget = 1024 * 1024 * 1024; // 1 GB
    const config = makeConfig(budget);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    expect(status.diskBudget!.warning).toBeUndefined();
  });

  it('diskBudget block: warning is set when db exceeds 90% of budget', async () => {
    const dir = await createTempDir();
    // Create a db.sqlite file with known size
    const dbPath = join(dir, 'db.sqlite');
    // Write 950 bytes of content
    await writeFile(dbPath, Buffer.alloc(950, 0));

    // Budget of 1000 bytes → 950/1000 = 95% → should trigger warning
    const budget = 1000;
    const config = makeConfig(budget);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    expect(status.diskBudget!.warning).toBeTruthy();
    expect(typeof status.diskBudget!.warning).toBe('string');
  });
});


// ---------------------------------------------------------------------------
// Scenario D: ingestionMix ratio edge cases
// ---------------------------------------------------------------------------

describe('internal-status: ingestionMix ratio edge cases', () => {
  it('ratio == 0.0 when vector store is empty (no records)', async () => {
    const dir = await createTempDir();
    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    // No records upserted
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    expect(status.ingestionMix!.accessibilityCount).toBe(0);
    expect(status.ingestionMix!.ocrCount).toBe(0);
    expect(status.ingestionMix!.ratio).toBe(0.0);
    expect(Number.isNaN(status.ingestionMix!.ratio)).toBe(false);
  });

  it('ratio == 1.0 when all records are accessibility', async () => {
    const dir = await createTempDir();
    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });

    const now = new Date();
    const records: VectorStoreRecord[] = [
      makeVectorRecord('ax-1', ['accessibility'], new Date(now.getTime() - 1_000).toISOString()),
      makeVectorRecord('ax-2', ['accessibility'], new Date(now.getTime() - 2_000).toISOString())
    ];
    await vectorStore.upsert(records);

    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    expect(status.ingestionMix!.accessibilityCount).toBe(2);
    expect(status.ingestionMix!.ocrCount).toBe(0);
    expect(status.ingestionMix!.ratio).toBe(1.0);
  });

  it('ratio == 0.0 when all records are OCR-only', async () => {
    const dir = await createTempDir();
    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });

    const now = new Date();
    const records: VectorStoreRecord[] = [
      makeVectorRecord('ocr-1', ['ocr'], new Date(now.getTime() - 1_000).toISOString()),
      makeVectorRecord('ocr-2', ['ocr'], new Date(now.getTime() - 2_000).toISOString())
    ];
    await vectorStore.upsert(records);

    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    expect(status.ingestionMix!.accessibilityCount).toBe(0);
    expect(status.ingestionMix!.ocrCount).toBe(2);
    expect(status.ingestionMix!.ratio).toBe(0.0);
  });

  it('records outside the 24h window are excluded from ingestionMix counts', async () => {
    const dir = await createTempDir();
    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });

    const now = new Date();
    const WINDOW_SECONDS = 86_400;
    const records: VectorStoreRecord[] = [
      // In-window record
      makeVectorRecord('ax-in', ['accessibility'], new Date(now.getTime() - 1_000).toISOString()),
      // Out-of-window record (older than 24h)
      makeVectorRecord('ax-out', ['accessibility'], new Date(now.getTime() - (WINDOW_SECONDS + 60) * 1000).toISOString())
    ];
    await vectorStore.upsert(records);

    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    // Only the in-window record should be counted
    expect(status.ingestionMix!.accessibilityCount).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// Scenario E: all three blocks present in response (structural check)
// ---------------------------------------------------------------------------

describe('internal-status: all three new blocks are present in response', () => {
  it('status response contains capture, ingestionMix, and diskBudget blocks', async () => {
    const dir = await createTempDir();
    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    // All three blocks must be present
    expect(status.capture).toBeDefined();
    expect(status.ingestionMix).toBeDefined();
    expect(status.diskBudget).toBeDefined();

    // capture block structure
    expect(typeof status.capture!.state).toBe('string');
    expect(typeof status.capture!.livenessThresholdSeconds).toBe('number');

    // ingestionMix block structure
    expect(typeof status.ingestionMix!.windowSeconds).toBe('number');
    expect(typeof status.ingestionMix!.accessibilityCount).toBe('number');
    expect(typeof status.ingestionMix!.ocrCount).toBe('number');
    expect(typeof status.ingestionMix!.ratio).toBe('number');

    // diskBudget block structure
    expect(typeof status.diskBudget!.currentSizeBytes).toBe('number');
    // budgetBytes and headroomBytes can be null or number
    expect(
      status.diskBudget!.budgetBytes === null || typeof status.diskBudget!.budgetBytes === 'number'
    ).toBe(true);
    expect(
      status.diskBudget!.headroomBytes === null || typeof status.diskBudget!.headroomBytes === 'number'
    ).toBe(true);
  });

  it('existing screenpipeStorage field is still present (backward compatibility)', async () => {
    const dir = await createTempDir();
    const config = makeConfig(null);
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const svc = new BootstrapStatusService(config, {
      checkpointStore: stubCheckpointStore,
      vectorStore,
      screenpipeDirectory: dir
    });

    const status = await svc.getStatus();

    // screenpipeStorage must still be present (R6.6 backward compat)
    expect(status.screenpipeStorage).toBeDefined();
    expect(typeof status.screenpipeStorage.inspectionStatus).toBe('string');
  });
});


// ---------------------------------------------------------------------------
// Property 26: AX 接通后 internal-status 三联立
// Validates: Requirements 7.1
//
// 至少一条满足 R1.3 前提的 AX 行的 fixture，索引完成后断言：
//   1. capture.state == "ok" 且 now - lastFrameTimestamp <= livenessThresholdSeconds
//   2. ingestionMix.accessibilityCount > 0
//   3. ingestionMix.ratio > 0
//
// 由于 BootstrapStatusService 使用真实的 runtimeRegistry（依赖系统进程），
// 我们直接使用 IngestionObservabilityService 并注入一个 mock registry
// 返回 processRunning=true，以便可靠地测试 capture.state == "ok"。
// ---------------------------------------------------------------------------

describe('Property 26: AX 接通后 internal-status 三联立 (Requirements 7.1)', () => {
  it('capture.state == "ok", accessibilityCount > 0, ratio > 0 when AX records are indexed and frame is recent', async () => {
    const dir = await createTempDir();
    const now = new Date();

    // Create a SQLite db with a recent frame timestamp (within liveness window)
    // 30 seconds ago — well within the 120s liveness threshold
    const recentTs = new Date(now.getTime() - 30_000).toISOString();
    await createSqliteDb(dir, [{ id: 1, timestamp: recentTs }]);

    // Create an InMemoryVectorStore with AX records (sourceTypes=['accessibility'])
    // These records satisfy the R1.3 premise: AX text that has been indexed
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const axRecords: VectorStoreRecord[] = [
      makeVectorRecord('ax-1', ['accessibility'], new Date(now.getTime() - 1_000).toISOString()),
      makeVectorRecord('ax-2', ['accessibility'], new Date(now.getTime() - 2_000).toISOString()),
      makeVectorRecord('ax-3', ['accessibility'], new Date(now.getTime() - 3_000).toISOString())
    ];
    await vectorStore.upsert(axRecords);

    // Mock registry that returns processRunning=true so capture.state can be "ok"
    const mockRegistryRunning = {
      hasActiveProcess: async () => true,
      getProcessStartedAt: async () => new Date(now.getTime() - 300_000).toISOString() // started 5 min ago
    };

    const config = makeConfig(null);
    const deps: IngestionObservabilityServiceDeps = {
      screenpipeDirectory: dir,
      vectorStore,
      runtimeRegistry: mockRegistryRunning,
      config,
      now: () => now
    };
    const svc = new IngestionObservabilityService(deps);
    const result = await svc.collect();

    // Assertion 1: capture.state == "ok" AND now - lastFrameTimestamp <= livenessThresholdSeconds
    expect(result.capture.state).toBe('ok');
    expect(result.capture.lastFrameTimestamp).toBeDefined();
    const lastFrameDate = new Date(result.capture.lastFrameTimestamp!);
    const ageSeconds = (now.getTime() - lastFrameDate.getTime()) / 1000;
    expect(ageSeconds).toBeLessThanOrEqual(result.capture.livenessThresholdSeconds);

    // Assertion 2: ingestionMix.accessibilityCount > 0
    expect(result.ingestionMix.accessibilityCount).toBeGreaterThan(0);

    // Assertion 3: ingestionMix.ratio > 0
    expect(result.ingestionMix.ratio).toBeGreaterThan(0);
  });

  it('all three conditions hold simultaneously with mixed AX + OCR records', async () => {
    const dir = await createTempDir();
    const now = new Date();

    // Recent frame (10 seconds ago)
    const recentTs = new Date(now.getTime() - 10_000).toISOString();
    await createSqliteDb(dir, [{ id: 1, timestamp: recentTs }]);

    // Mix of AX and OCR records — AX must dominate for ratio > 0
    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const records: VectorStoreRecord[] = [
      makeVectorRecord('ax-1', ['accessibility'], new Date(now.getTime() - 1_000).toISOString()),
      makeVectorRecord('ax-2', ['accessibility'], new Date(now.getTime() - 2_000).toISOString()),
      makeVectorRecord('ocr-1', ['ocr'], new Date(now.getTime() - 3_000).toISOString())
    ];
    await vectorStore.upsert(records);

    const mockRegistryRunning = {
      hasActiveProcess: async () => true,
      getProcessStartedAt: async () => new Date(now.getTime() - 600_000).toISOString() // started 10 min ago
    };

    const config = makeConfig(null);
    const deps: IngestionObservabilityServiceDeps = {
      screenpipeDirectory: dir,
      vectorStore,
      runtimeRegistry: mockRegistryRunning,
      config,
      now: () => now
    };
    const svc = new IngestionObservabilityService(deps);
    const result = await svc.collect();

    // All three conditions must hold simultaneously (Property 26)
    expect(result.capture.state).toBe('ok');
    const lastFrameDate = new Date(result.capture.lastFrameTimestamp!);
    const ageSeconds = (now.getTime() - lastFrameDate.getTime()) / 1000;
    expect(ageSeconds).toBeLessThanOrEqual(result.capture.livenessThresholdSeconds);

    expect(result.ingestionMix.accessibilityCount).toBeGreaterThan(0);
    expect(result.ingestionMix.ratio).toBeGreaterThan(0);

    // Verify the ratio is computed correctly: 2 AX / (2 AX + 1 OCR) = 2/3
    expect(result.ingestionMix.accessibilityCount).toBe(2);
    expect(result.ingestionMix.ocrCount).toBe(1);
    expect(result.ingestionMix.ratio).toBeCloseTo(2 / 3, 5);
  });

  it('three conditions are independent: failing one does not mask the others', async () => {
    // This test verifies that when capture.state != "ok" (process down),
    // the ingestionMix counts are still computed correctly from the vector store.
    // This ensures the three assertions are truly independent checks.
    const dir = await createTempDir();
    const now = new Date();

    const recentTs = new Date(now.getTime() - 30_000).toISOString();
    await createSqliteDb(dir, [{ id: 1, timestamp: recentTs }]);

    const vectorStore = new InMemoryVectorStore({ kind: 'memory' });
    const axRecords: VectorStoreRecord[] = [
      makeVectorRecord('ax-1', ['accessibility'], new Date(now.getTime() - 1_000).toISOString()),
      makeVectorRecord('ax-2', ['accessibility'], new Date(now.getTime() - 2_000).toISOString())
    ];
    await vectorStore.upsert(axRecords);

    // Process is DOWN — capture.state will NOT be "ok"
    const mockRegistryDown = {
      hasActiveProcess: async () => false,
      getProcessStartedAt: async () => null as string | null
    };

    const config = makeConfig(null);
    const deps: IngestionObservabilityServiceDeps = {
      screenpipeDirectory: dir,
      vectorStore,
      runtimeRegistry: mockRegistryDown,
      config,
      now: () => now
    };
    const svc = new IngestionObservabilityService(deps);
    const result = await svc.collect();

    // capture.state is NOT "ok" (process down)
    expect(result.capture.state).toBe('process-down');
    expect(result.capture.reason).toBeTruthy();

    // But ingestionMix still reflects the indexed AX records
    expect(result.ingestionMix.accessibilityCount).toBe(2);
    expect(result.ingestionMix.ratio).toBe(1.0);
  });
});
