/**
 * End-to-end integration test for Cascade_Delete wiring (task 10.2).
 *
 * Validates that after a `delete-range` operation (via
 * `DefaultPrivacyControlService`) or a retention pass (via
 * `runRetentionIfOverBudget`), all derived data — `extracted_content`
 * rows, `sessions` rows, and vector-store records — are no longer
 * visible.
 *
 * The test wires the **real** collaborators:
 *   - `DefaultCascadeDeleteCoordinator` (task 10.1)
 *   - `DefaultPrivacyControlService` with the coordinator injected
 *   - `runRetentionIfOverBudget` with the coordinator injected
 *   - `SqliteExtractedContentStore` / `SqliteSessionStore` over an
 *     in-memory derived database
 *   - `InMemoryVectorStore`
 *
 * The ScreenPipe `db.sqlite` is simulated with a real in-memory SQLite
 * database so `deleteScreenpipeRange` / `deleteOldestBatch` can
 * actually execute their SQL.
 *
 * **Validates: Requirements 9.1, 9.3**
 *   - **Cascade_Completeness (W25)** — after delete-range, no
 *     `extracted_content` row, `sessions` row, or vector-store record
 *     referencing a deleted frame survives.
 *   - **No_Re_Sessionize (W26)** — sessions are removed in their
 *     entirety; no partial session is reconstructed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  initDerivedSchema,
  openDerivedDatabase,
  type DerivedDatabase
} from '../../../src/services/work-activity/derived-database.js';
import { testTempRoot } from '../../helpers/test-tmp.js';
import { SqliteExtractedContentStore } from '../../../src/services/work-activity/extraction/extracted-content-store.js';
import { SqliteSessionStore } from '../../../src/services/work-activity/sessions/session-store.js';
import { InMemoryVectorStore } from '../../../src/services/retrieval/vector-store.js';
import {
  createCascadeDeleteCoordinator
} from '../../../src/services/work-activity/cascade-delete-coordinator.js';
import { DefaultPrivacyControlService } from '../../../src/services/privacy/privacy-control-service.js';
import { runRetentionIfOverBudget } from '../../../src/services/trim/screenpipe-trim-service.js';
import type { ExtractionResult } from '../../../src/services/work-activity/extraction/types.js';
import type { PrivacyStore, PrivacyState } from '../../../src/services/privacy/types.js';
import type { VectorStoreRecord } from '../../../src/services/retrieval/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal in-memory PrivacyStore for tests. */
class InMemoryPrivacyStore implements PrivacyStore {
  private state: PrivacyState = { paused: false, excludedApps: [] };

  async read(): Promise<PrivacyState> {
    return { ...this.state };
  }

  async write(state: PrivacyState): Promise<void> {
    this.state = { ...state };
  }
}

/**
 * Create a minimal ScreenPipe-style `frames` + `elements` SQLite
 * database at `dbPath` and insert `count` frames with timestamps
 * starting at `baseTime` (1-second increments).
 *
 * Returns the list of inserted frame ids.
 */
function createScreenpipeDb(dbPath: string, frames: Array<{ id: number; timestamp: string }>): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS frames (
      id INTEGER PRIMARY KEY,
      timestamp TEXT NOT NULL,
      app_name TEXT,
      window_name TEXT,
      content_hash TEXT,
      accessibility_tree_json TEXT
    );
    CREATE TABLE IF NOT EXISTS elements (
      id INTEGER PRIMARY KEY,
      frame_id INTEGER NOT NULL,
      text TEXT
    );
  `);
  const insert = db.prepare(
    'INSERT INTO frames (id, timestamp, app_name, window_name) VALUES (?, ?, ?, ?)'
  );
  for (const f of frames) {
    insert.run(f.id, f.timestamp, 'TestApp', 'Test Window');
  }
  db.close();
}

/** Build a minimal ExtractionResult for seeding derived stores. */
function makeExtraction(frameId: number, timestamp: string, appName = 'TestApp'): ExtractionResult {
  return {
    frameId,
    frameTimestamp: timestamp,
    appName,
    contextLabel: 'Test Window',
    contextKey: `${appName}::test window`,
    extractedText: `content for frame ${frameId}`,
    extractedTextHash: `hash-${frameId}`,
    extractionRuleKind: 'generic',
    sourceTypes: ['accessibility']
  };
}

/** Build a minimal VectorStoreRecord for seeding the vector store. */
function makeVectorRecord(frameId: number, timestamp: string): VectorStoreRecord {
  return {
    id: `extracted:${frameId}`,
    text: `content for frame ${frameId}`,
    timestamp,
    appName: 'TestApp',
    embedding: [0.1, 0.2, 0.3],
    metadata: {
      frameId,
      frameTimestamp: timestamp,
      extractedTextHash: `hash-${frameId}`,
      appName: 'TestApp',
      contextKey: 'TestApp::test window',
      sourceTypes: ['accessibility']
    }
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let screenpipeDbPath: string;
let derivedDb: DerivedDatabase;
let extractedContentStore: SqliteExtractedContentStore;
let sessionStore: SqliteSessionStore;
let vectorStore: InMemoryVectorStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(testTempRoot(), 'cascade-delete-test-'));
  screenpipeDbPath = join(tmpDir, 'db.sqlite');

  derivedDb = openDerivedDatabase(':memory:');
  initDerivedSchema(derivedDb);
  extractedContentStore = new SqliteExtractedContentStore(derivedDb);
  sessionStore = new SqliteSessionStore(derivedDb);
  vectorStore = new InMemoryVectorStore({ kind: 'memory' } as never);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers to seed derived data
// ---------------------------------------------------------------------------

async function seedDerivedData(frames: Array<{ id: number; timestamp: string }>): Promise<void> {
  // Seed extracted_content rows
  for (const f of frames) {
    await extractedContentStore.upsert(makeExtraction(f.id, f.timestamp));
  }

  // Seed a single session covering all frames
  const sessionId = randomUUID();
  const frameIds = frames.map((f) => f.id);
  const firstTs = frames[0]!.timestamp;
  const lastTs = frames[frames.length - 1]!.timestamp;

  // Insert session directly via the store's createSession path
  // by using the aggregator-compatible interface
  const db = (derivedDb as unknown as { exec: (sql: string) => void });
  (derivedDb as unknown as DatabaseSync).exec(`
    INSERT INTO sessions (
      session_id, app_name, context_key, context_label,
      started_at, ended_at, active_seconds, source_types,
      evidence_frame_ids, is_open
    ) VALUES (
      '${sessionId}', 'TestApp', 'TestApp::test window', 'Test Window',
      '${firstTs}', '${lastTs}', ${frames.length},
      '["accessibility"]',
      '${JSON.stringify(frameIds)}',
      0
    )
  `);

  // Seed vector store records
  for (const f of frames) {
    await vectorStore.upsert([makeVectorRecord(f.id, f.timestamp)]);
  }
}

// ---------------------------------------------------------------------------
// Tests: delete-range cascade
// ---------------------------------------------------------------------------

describe('Cascade_Delete via delete-range (R9.1, W25, W26)', () => {
  it('after delete-range=all, no extracted_content rows remain', async () => {
    const frames = [
      { id: 1, timestamp: '2024-01-01T10:00:00.000Z' },
      { id: 2, timestamp: '2024-01-01T10:01:00.000Z' },
      { id: 3, timestamp: '2024-01-01T10:02:00.000Z' }
    ];
    createScreenpipeDb(screenpipeDbPath, frames);
    await seedDerivedData(frames);

    // Verify data is present before delete
    const beforeRows = await extractedContentStore.listByTimeWindow(
      '2024-01-01T00:00:00.000Z',
      '2024-01-02T00:00:00.000Z'
    );
    expect(beforeRows).toHaveLength(3);

    const coordinator = createCascadeDeleteCoordinator({
      sessionStore,
      extractedContentStore,
      vectorStore
    });

    const privacyStore = new InMemoryPrivacyStore();
    const privacy = new DefaultPrivacyControlService(
      privacyStore,
      () => new Date('2024-01-01T12:00:00.000Z'),
      { screenpipeDirectory: tmpDir },
      coordinator
    );

    const result = await privacy.execute({
      action: 'delete-range',
      range: 'all',
      confirm: true
    });

    expect(result.action).toBe('delete-range');
    expect(result.confirmed).toBe(true);

    // Cascade fields should be present
    expect(result.deletedExtractedContent).toBe(3);
    expect(result.deletedSessions).toBe(1);
    expect(result.deletedEmbeddings).toBe(3);

    // Verify extracted_content is gone
    const afterRows = await extractedContentStore.listByTimeWindow(
      '2024-01-01T00:00:00.000Z',
      '2024-01-02T00:00:00.000Z'
    );
    expect(afterRows).toHaveLength(0);

    // Verify sessions are gone
    const openCount = await sessionStore.countOpenSessions();
    expect(openCount).toBe(0);

    // Verify vector store records are gone
    const vsRecords = await vectorStore.query([0.1, 0.2, 0.3], 100);
    expect(vsRecords).toHaveLength(0);
  });

  it('after delete-range=all, sessions are removed entirely (W26 — No_Re_Sessionize)', async () => {
    const frames = [
      { id: 10, timestamp: '2024-01-01T09:00:00.000Z' },
      { id: 11, timestamp: '2024-01-01T09:01:00.000Z' }
    ];
    createScreenpipeDb(screenpipeDbPath, frames);
    await seedDerivedData(frames);

    const coordinator = createCascadeDeleteCoordinator({
      sessionStore,
      extractedContentStore,
      vectorStore
    });

    const privacyStore = new InMemoryPrivacyStore();
    const privacy = new DefaultPrivacyControlService(
      privacyStore,
      () => new Date('2024-01-01T12:00:00.000Z'),
      { screenpipeDirectory: tmpDir },
      coordinator
    );

    await privacy.execute({ action: 'delete-range', range: 'all', confirm: true });

    // No sessions should remain — not even partial ones
    const lastClosed = await sessionStore.findLastClosedAt();
    const total24h = await sessionStore.countSessionsStartedSince(
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    );
    // The sessions were seeded with started_at in 2024, so they won't
    // appear in the last-24h window from "now" — but the key assertion
    // is that the session table is empty after cascade.
    const openCount = await sessionStore.countOpenSessions();
    expect(openCount).toBe(0);
    // Verify by checking the raw count via listSessions
    const allSessions = await sessionStore.listSessions({
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-12-31T23:59:59.999Z'
    });
    expect(allSessions).toHaveLength(0);
  });

  it('delete-range without coordinator does not throw and returns no cascade fields', async () => {
    const frames = [{ id: 20, timestamp: '2024-01-01T08:00:00.000Z' }];
    createScreenpipeDb(screenpipeDbPath, frames);
    await seedDerivedData(frames);

    // No coordinator injected
    const privacyStore = new InMemoryPrivacyStore();
    const privacy = new DefaultPrivacyControlService(
      privacyStore,
      () => new Date('2024-01-01T12:00:00.000Z'),
      { screenpipeDirectory: tmpDir }
      // no cascadeDeleteCoordinator
    );

    const result = await privacy.execute({
      action: 'delete-range',
      range: 'all',
      confirm: true
    });

    expect(result.action).toBe('delete-range');
    expect(result.confirmed).toBe(true);
    // No cascade fields when coordinator is absent
    expect(result.deletedExtractedContent).toBeUndefined();
    expect(result.deletedSessions).toBeUndefined();
    expect(result.deletedEmbeddings).toBeUndefined();

    // Derived data is NOT cleaned up (no coordinator)
    const rows = await extractedContentStore.listByTimeWindow(
      '2024-01-01T00:00:00.000Z',
      '2024-01-02T00:00:00.000Z'
    );
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: retention pass cascade
// ---------------------------------------------------------------------------

describe('Cascade_Delete via retention pass (R9.1, W25)', () => {
  it('after runRetentionIfOverBudget, derived data for deleted frames is removed', async () => {
    // Create frames with old timestamps so they fall below the retention floor
    const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const frames = [
      { id: 100, timestamp: oldTimestamp },
      { id: 101, timestamp: new Date(Date.parse(oldTimestamp) + 60_000).toISOString() }
    ];
    createScreenpipeDb(screenpipeDbPath, frames);
    await seedDerivedData(frames);

    // Verify data is present before retention
    const beforeRows = await extractedContentStore.listByTimeWindow(
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      new Date().toISOString()
    );
    expect(beforeRows).toHaveLength(2);

    const coordinator = createCascadeDeleteCoordinator({
      sessionStore,
      extractedContentStore,
      vectorStore
    });

    // Run retention with a tiny budget (1 byte) to force deletion
    const result = await runRetentionIfOverBudget(
      screenpipeDbPath,
      1, // 1 byte budget — forces deletion
      7, // 7-day retention floor
      coordinator
    );

    expect(result.framesDeleted).toBe(2);

    // Verify extracted_content is gone
    const afterRows = await extractedContentStore.listByTimeWindow(
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      new Date().toISOString()
    );
    expect(afterRows).toHaveLength(0);

    // Verify sessions are gone
    const allSessions = await sessionStore.listSessions({
      from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString()
    });
    expect(allSessions).toHaveLength(0);

    // Verify vector store records are gone
    const vsRecords = await vectorStore.query([0.1, 0.2, 0.3], 100);
    expect(vsRecords).toHaveLength(0);
  });

  it('runRetentionIfOverBudget without coordinator does not throw', async () => {
    const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const frames = [{ id: 200, timestamp: oldTimestamp }];
    createScreenpipeDb(screenpipeDbPath, frames);
    await seedDerivedData(frames);

    // No coordinator — should not throw
    const result = await runRetentionIfOverBudget(
      screenpipeDbPath,
      1,
      7
      // no coordinator
    );

    expect(result.framesDeleted).toBe(1);

    // Derived data is NOT cleaned up (no coordinator)
    const rows = await extractedContentStore.listByTimeWindow(
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      new Date().toISOString()
    );
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: cascadeByFrameIds directly (unit-level integration)
// ---------------------------------------------------------------------------

describe('CascadeDeleteCoordinator.cascadeByFrameIds (W25, W26)', () => {
  it('removes extracted_content, sessions, and vector records for given frame ids', async () => {
    const frames = [
      { id: 300, timestamp: '2024-06-01T10:00:00.000Z' },
      { id: 301, timestamp: '2024-06-01T10:01:00.000Z' },
      { id: 302, timestamp: '2024-06-01T10:02:00.000Z' }
    ];
    await seedDerivedData(frames);

    const coordinator = createCascadeDeleteCoordinator({
      sessionStore,
      extractedContentStore,
      vectorStore
    });

    // Delete only frames 300 and 301
    const cascadeResult = await coordinator.cascadeByFrameIds([300, 301]);

    expect(cascadeResult.extractedContent).toBe(2);
    expect(cascadeResult.sessions).toBe(1); // The session covering all 3 frames is deleted
    expect(cascadeResult.embeddings).toBe(2);
    expect(cascadeResult.fallbackUsed).toBe('none');

    // Frame 302's extracted_content should be gone too because the session was deleted
    // but the extracted_content row for 302 should still exist (only 300 and 301 were deleted)
    const remaining = await extractedContentStore.getByFrameIds([302]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.frameId).toBe(302);

    // The session is gone (it contained frames 300 and 301)
    const allSessions = await sessionStore.listSessions({
      from: '2024-06-01T00:00:00.000Z',
      to: '2024-06-02T00:00:00.000Z'
    });
    expect(allSessions).toHaveLength(0);
  });

  it('empty frameIds is a no-op', async () => {
    const frames = [{ id: 400, timestamp: '2024-06-01T11:00:00.000Z' }];
    await seedDerivedData(frames);

    const coordinator = createCascadeDeleteCoordinator({
      sessionStore,
      extractedContentStore,
      vectorStore
    });

    const result = await coordinator.cascadeByFrameIds([]);

    expect(result.extractedContent).toBe(0);
    expect(result.sessions).toBe(0);
    expect(result.embeddings).toBe(0);

    // Data should still be present
    const rows = await extractedContentStore.getByFrameIds([400]);
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: cascadeByTimestampRange
// ---------------------------------------------------------------------------

describe('CascadeDeleteCoordinator.cascadeByTimestampRange (W25)', () => {
  it('removes all derived data within the timestamp range', async () => {
    const frames = [
      { id: 500, timestamp: '2024-07-01T10:00:00.000Z' },
      { id: 501, timestamp: '2024-07-01T10:01:00.000Z' },
      { id: 502, timestamp: '2024-07-01T11:00:00.000Z' } // outside range
    ];
    await seedDerivedData(frames);

    const coordinator = createCascadeDeleteCoordinator({
      sessionStore,
      extractedContentStore,
      vectorStore
    });

    // Delete only the first hour
    const cascadeResult = await coordinator.cascadeByTimestampRange(
      '2024-07-01T10:00:00.000Z',
      '2024-07-01T10:59:59.999Z'
    );

    expect(cascadeResult.extractedContent).toBe(2);
    // Session covers all 3 frames (including 502), so it gets deleted
    expect(cascadeResult.sessions).toBe(1);

    // Frame 502's extracted_content should still exist
    const remaining = await extractedContentStore.getByFrameIds([502]);
    expect(remaining).toHaveLength(1);
  });
});
