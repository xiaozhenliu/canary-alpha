/**
 * Coverage for P1-5: the cascade-delete coordinator drops
 * `sessions` and `extracted_content` inside a single SQLite
 * transaction. A failure between the two deletes MUST leave both
 * tables unchanged. The vector store deletion runs only AFTER the
 * SQL transaction commits.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  initDerivedSchema,
  openDerivedDatabase,
  deleteDerivedByFrameIds
} from '../../../src/services/work-activity/derived-database.js';
import { SqliteExtractedContentStore } from '../../../src/services/work-activity/extraction/extracted-content-store.js';
import { SqliteSessionStore } from '../../../src/services/work-activity/sessions/session-store.js';
import { createCascadeDeleteCoordinator } from '../../../src/services/work-activity/cascade-delete-coordinator.js';
import type { ExtractionResult } from '../../../src/services/work-activity/extraction/types.js';
import type { VectorStore, VectorStoreRecord } from '../../../src/services/retrieval/types.js';

function makeExtraction(frameId: number, ts: string): ExtractionResult {
  return {
    frameId,
    frameTimestamp: ts,
    appName: 'TestApp',
    contextLabel: 'Test Window',
    contextKey: 'TestApp::test window',
    extractedText: `evidence ${frameId}`,
    extractedTextHash: `hash-${frameId}`,
    extractionRuleKind: 'generic',
    sourceTypes: ['accessibility']
  };
}

async function seed(db: ReturnType<typeof openDerivedDatabase>, frameIds: number[]): Promise<void> {
  const store = new SqliteExtractedContentStore(db);
  for (const id of frameIds) {
    await store.upsert(makeExtraction(id, `2026-04-13T10:0${id % 10}:00.000Z`));
  }
  db.exec(`
    INSERT INTO sessions (
      session_id, app_name, context_key, context_label,
      started_at, ended_at, active_seconds, source_types,
      evidence_frame_ids, is_open
    ) VALUES (
      'tx-session', 'TestApp', 'TestApp::test window', 'Test Window',
      '2026-04-13T10:00:00.000Z', '2026-04-13T10:30:00.000Z', 1800,
      '["accessibility"]', '${JSON.stringify(frameIds)}', 0
    )
  `);
}

describe('deleteDerivedByFrameIds', () => {
  it('rolls back when an inner statement fails — both tables stay unchanged', async () => {
    const db = openDerivedDatabase(':memory:');
    initDerivedSchema(db);
    await seed(db, [1, 2, 3]);

    // Replace `prepare` so the second invocation throws — that's
    // the `extracted_content` delete inside the transaction. The
    // helper MUST roll back so the earlier `sessions` delete does
    // not leak.
    const realPrepare = db.prepare.bind(db);
    let callCount = 0;
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      callCount += 1;
      if (callCount === 2 && sql.startsWith('DELETE FROM extracted_content')) {
        throw new Error('simulated failure between deletes');
      }
      return realPrepare(sql);
    });

    expect(() => deleteDerivedByFrameIds(db, [1, 2, 3])).toThrow('simulated failure');
    spy.mockRestore();

    const remainingSessions = db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number | bigint };
    const remainingExtracted = db
      .prepare('SELECT COUNT(*) AS c FROM extracted_content')
      .get() as { c: number | bigint };
    expect(Number(remainingSessions.c)).toBe(1);
    expect(Number(remainingExtracted.c)).toBe(3);
  });

  it('commits both deletes on the happy path', async () => {
    const db = openDerivedDatabase(':memory:');
    initDerivedSchema(db);
    await seed(db, [10, 11]);

    const result = deleteDerivedByFrameIds(db, [10, 11]);
    expect(result.sessions).toBe(1);
    expect(result.extractedContent).toBe(2);

    const remainingExtracted = db
      .prepare('SELECT COUNT(*) AS c FROM extracted_content')
      .get() as { c: number | bigint };
    expect(Number(remainingExtracted.c)).toBe(0);
  });

  it('empty input is a no-op', async () => {
    const db = openDerivedDatabase(':memory:');
    initDerivedSchema(db);
    expect(deleteDerivedByFrameIds(db, [])).toEqual({ extractedContent: 0, sessions: 0 });
  });
});

describe('createCascadeDeleteCoordinator transaction integration', () => {
  it('does not invoke the vector store delete when the SQL transaction rolls back', async () => {
    const db = openDerivedDatabase(':memory:');
    initDerivedSchema(db);
    await seed(db, [21, 22]);

    const sessionStore = new SqliteSessionStore(db);
    const extractedContentStore = new SqliteExtractedContentStore(db);
    const vectorStore: VectorStore = {
      upsert: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      deleteByFrameIds: vi.fn().mockResolvedValue(2)
    } as unknown as VectorStore;

    const realPrepare = db.prepare.bind(db);
    let callCount = 0;
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      callCount += 1;
      if (callCount === 2 && sql.startsWith('DELETE FROM extracted_content')) {
        throw new Error('simulated failure');
      }
      return realPrepare(sql);
    });

    const coordinator = createCascadeDeleteCoordinator({
      sessionStore,
      extractedContentStore,
      vectorStore,
      derivedDatabase: db
    });

    await expect(coordinator.cascadeByFrameIds([21, 22])).rejects.toThrow('simulated failure');
    spy.mockRestore();

    expect(vectorStore.deleteByFrameIds).not.toHaveBeenCalled();

    // Both derived tables are intact.
    const remainingSessions = db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number | bigint };
    const remainingExtracted = db
      .prepare('SELECT COUNT(*) AS c FROM extracted_content')
      .get() as { c: number | bigint };
    expect(Number(remainingSessions.c)).toBe(1);
    expect(Number(remainingExtracted.c)).toBe(2);
  });

  it('invokes the vector store delete on the happy path', async () => {
    const db = openDerivedDatabase(':memory:');
    initDerivedSchema(db);
    await seed(db, [31]);

    const sessionStore = new SqliteSessionStore(db);
    const extractedContentStore = new SqliteExtractedContentStore(db);
    const vectorStore: VectorStore = {
      upsert: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      deleteByFrameIds: vi.fn().mockResolvedValue(1)
    } as unknown as VectorStore;

    const coordinator = createCascadeDeleteCoordinator({
      sessionStore,
      extractedContentStore,
      vectorStore,
      derivedDatabase: db
    });

    const result = await coordinator.cascadeByFrameIds([31]);
    expect(vectorStore.deleteByFrameIds).toHaveBeenCalledWith([31]);
    expect(result.sessions).toBe(1);
    expect(result.extractedContent).toBe(1);
    expect(result.embeddings).toBe(1);
  });
});
