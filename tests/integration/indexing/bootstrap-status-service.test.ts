import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { BootstrapStatusService } from '../../../src/services/bootstrap-status-service.js';
import type { AppConfig } from '../../../src/types/app-config.js';
import type { CheckpointStore, IndexedCheckpoint, VectorStore, VectorStoreInspection, VectorSearchRequest } from '../../../src/services/retrieval/types.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

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
  await writeFile(filePath, Buffer.alloc(size, 120));
}

class StubCheckpointStore implements CheckpointStore {
  constructor(private readonly checkpoint: IndexedCheckpoint | Record<string, unknown> | null) {}

  async readLatest(): Promise<IndexedCheckpoint | null> {
    return this.checkpoint as IndexedCheckpoint | null;
  }

  async writeLatest(): Promise<void> {}

  async reset(): Promise<void> {}
}

class StubVectorStore implements VectorStore {
  readonly kind = 'stub-vector';

  constructor(private readonly inspection: VectorStoreInspection) {}

  async upsert(): Promise<void> {}

  async reset(): Promise<void> {}

  async query(_request: VectorSearchRequest) {
    return [];
  }

  async inspect(): Promise<VectorStoreInspection> {
    return this.inspection;
  }
}

class SlowVectorStore implements VectorStore {
  readonly kind = 'slow-vector';

  async upsert(): Promise<void> {}

  async reset(): Promise<void> {}

  async query(_request: VectorSearchRequest) {
    return [];
  }

  async inspect(): Promise<VectorStoreInspection> {
    await delay(500);
    return {
      persisted: true,
      readable: true
    };
  }
}

function createConfig(): AppConfig {
  const fixtureRoot = join(testTempRoot(), 'bootstrap-status-fixture');
  return {
    server: {
      mode: 'stdio',
      host: '127.0.0.1',
      port: 8765
    },
    logging: {
      level: 'info'
    },
    screenpipe: {
      url: 'http://127.0.0.1:3030'
    },
    providers: {
      embeddings: {
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'text-embedding-3-small'
      }
    },
    vectorStore: {
      kind: 'chroma',
      path: fixtureRoot
    },
    retrieval: {
      freshnessWindowMinutes: 15,
      pollIntervalSeconds: 30,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 500
    },
    paths: {
      configFile: join(fixtureRoot, 'config.yaml'),
      logDirectory: join(fixtureRoot, 'logs'),
      serviceLogFile: join(fixtureRoot, 'logs', 'service.log'),
      derivedDatabase: join(fixtureRoot, 'derived.sqlite')
    },
    routines: {
      enabled: false,
      definitionsPath: join(fixtureRoot, 'routines', 'definitions'),
      historyPath: join(fixtureRoot, 'routines', 'history')
    },
    trim: { enabled: true, intervalSeconds: 600 },
    capture: { provider: 'screenpipe', livenessThresholdSeconds: 120, permissionsGracePeriodSeconds: 60 },
    storage: { diskBudgetBytes: null, retentionDays: 7 },
    privacy: { excludeApps: ['1Password', 'Keychain Access'], secureAxRoles: ['AXSecureTextField'] },
    analysis: {
      sessions: { idleThresholdSeconds: 120 },
      summary: { provider: 'template', remoteLlmTimeoutMs: 30000 },
      embeddings: { topK: 20, minScore: 0 }
    },
    llm: { model: 'gpt-4o-mini' }
  };
}

describe('bootstrap status service', () => {
  it('keeps needs-rebuild while checkpoint backlog catch-up is still pending', async () => {
    const service = new BootstrapStatusService(createConfig(), {
      checkpointStore: new StubCheckpointStore({
        cursor: 'checkpoint-1',
        timestamp: '2026-04-13T12:00:00.000Z',
        backlog: {
          from: '2026-04-13T11:00:00.000Z',
          to: '2026-04-13T12:00:00.000Z',
          nextOffset: 500
        }
      }),
      vectorStore: new StubVectorStore({
        persisted: true,
        readable: true
      })
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      retrieval: {
        checkpointExists: true,
        checkpointTimestamp: '2026-04-13T12:00:00.000Z',
        vectorStoreKind: 'stub-vector',
        recoveryStatus: 'needs-rebuild'
      }
    });
  });

  it('reports needs-rebuild when the checkpoint exists but the vector store is empty', async () => {
    const service = new BootstrapStatusService(createConfig(), {
      checkpointStore: new StubCheckpointStore({
        cursor: 'checkpoint-1',
        timestamp: '2026-04-13T12:00:00.000Z'
      }),
      vectorStore: new StubVectorStore({
        persisted: false,
        readable: true
      })
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      retrieval: {
        checkpointExists: true,
        checkpointTimestamp: '2026-04-13T12:00:00.000Z',
        vectorStoreKind: 'stub-vector',
        recoveryStatus: 'needs-rebuild'
      }
    });
  });

  it('reports ready when the checkpoint is current and the vector store is readable but intentionally empty', async () => {
    const service = new BootstrapStatusService(createConfig(), {
      checkpointStore: new StubCheckpointStore({
        cursor: 'checkpoint-1',
        timestamp: '2026-04-13T12:00:00.000Z'
      }),
      vectorStore: new StubVectorStore({
        persisted: false,
        readable: true,
        recordCount: 0
      })
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      retrieval: {
        checkpointExists: true,
        checkpointTimestamp: '2026-04-13T12:00:00.000Z',
        vectorStoreKind: 'stub-vector',
        recoveryStatus: 'ready'
      }
    });
  });

  it('reports needs-rebuild when the checkpoint payload is malformed', async () => {
    const service = new BootstrapStatusService(createConfig(), {
      checkpointStore: new StubCheckpointStore({
        cursor: 'checkpoint-1'
      }),
      vectorStore: new StubVectorStore({
        persisted: true,
        readable: true
      })
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      retrieval: {
        checkpointExists: true,
        checkpointTimestamp: undefined,
        vectorStoreKind: 'stub-vector',
        recoveryStatus: 'needs-rebuild'
      }
    });
  });

  it('reports degraded when vector-store inspection exceeds the bootstrap probe budget', async () => {
    const service = new BootstrapStatusService(createConfig(), {
      checkpointStore: new StubCheckpointStore({
        cursor: 'checkpoint-1',
        timestamp: '2026-04-13T12:00:00.000Z'
      }),
      vectorStore: new SlowVectorStore()
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      retrieval: {
        checkpointExists: true,
        checkpointTimestamp: '2026-04-13T12:00:00.000Z',
        vectorStoreKind: 'slow-vector',
        recoveryStatus: 'degraded'
      }
    });
  });

  it('reports Screenpipe db.sqlite totals with dominant table diagnostics when SQLite inspection succeeds', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'bootstrap-status-storage-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipeDirectory = join(homeDir, '.screenpipe');
    await createScreenpipeDiagnosticsFixture(screenpipeDirectory);

    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const service = new BootstrapStatusService(createConfig(), {
        checkpointStore: new StubCheckpointStore({
          cursor: 'checkpoint-1',
          timestamp: '2026-04-13T12:00:00.000Z'
        }),
        vectorStore: new StubVectorStore({
          persisted: true,
          readable: true
        })
      });

      const status = await service.getStatus();
      expect(status).toMatchObject({
        retrieval: {
          recoveryStatus: 'ready'
        },
        screenpipeStorage: {
          inspectionStatus: 'ready',
          databasePath: join(screenpipeDirectory, 'db.sqlite')
        }
      });
      expect(status.screenpipeStorage.totalBytes).toBeGreaterThan(0);
      expect(status.screenpipeStorage.dominantTables).toHaveLength(3);
      expect(status.screenpipeStorage.dominantTables[0].name).toBe('frames');
      expect(status.screenpipeStorage.dominantTables[1].name).toBe('elements');
      expect(status.screenpipeStorage.dominantTables[0].estimatedBytes).toBeGreaterThanOrEqual(
        status.screenpipeStorage.dominantTables[1].estimatedBytes
      );
      expect(status.screenpipeStorage.dominantTables[1].estimatedBytes).toBeGreaterThanOrEqual(
        status.screenpipeStorage.dominantTables[2].estimatedBytes
      );
      expect(status.screenpipeStorage.byteAttribution).toBeUndefined();
      expect(status.screenpipeStorage.hotspots).toBeUndefined();
      expect(status.screenpipeStorage.recentTextDuplication).toMatchObject({
        inspectionStatus: 'ready'
      });
      expect(status.screenpipeStorage.recentTextDuplication?.sources.some((source) => source.key === 'frame-full-text')).toBe(true);
      expect(status.screenpipeStorage.recentElementDuplication).toMatchObject({
        inspectionStatus: 'ready',
        duplicateRows: 3
      });
      expect(status.screenpipeStorage.recentCaptureReuse).toMatchObject({
        inspectionStatus: 'ready',
        coverage: 'supported'
      });
      const captureReuseSignals = Object.fromEntries(
        (status.screenpipeStorage.recentCaptureReuse?.signals ?? []).map((signal) => [signal.key, signal])
      );
      expect(captureReuseSignals['capture-trigger']).toMatchObject({
        matchedRows: 4
      });
      expect(captureReuseSignals['element-reuse']).toMatchObject({
        matchedRows: 3
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('degrades only screenpipeStorage when SQLite table inspection is unavailable', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'bootstrap-status-storage-degraded-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipeDirectory = join(homeDir, '.screenpipe');
    await writeSizedFile(join(screenpipeDirectory, 'db.sqlite'), 2048);

    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const service = new BootstrapStatusService(createConfig(), {
        checkpointStore: new StubCheckpointStore({
          cursor: 'checkpoint-1',
          timestamp: '2026-04-13T12:00:00.000Z'
        }),
        vectorStore: new StubVectorStore({
          persisted: true,
          readable: true
        })
      });

      await expect(service.getStatus()).resolves.toMatchObject({
        status: 'ok',
        retrieval: {
          recoveryStatus: 'ready'
        },
        screenpipeStorage: {
          inspectionStatus: 'degraded',
          reason: expect.stringMatching(/unavailable|inspect|metadata/i),
          databasePath: join(screenpipeDirectory, 'db.sqlite'),
          totalBytes: 2048,
          dominantTables: []
        }
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});
