import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteVectorStore } from '../../../src/services/retrieval/sqlite-vector-store.js';
import { initDerivedSchema } from '../../../src/services/work-activity/derived-database.js';
import type { VectorStoreRecord } from '../../../src/services/retrieval/types.js';

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  initDerivedSchema(db);
  return db;
}

function makeRecord(overrides?: Partial<VectorStoreRecord>): VectorStoreRecord {
  return {
    id: overrides?.id ?? 'extracted:1',
    text: overrides?.text ?? 'hello world',
    timestamp: overrides?.timestamp ?? '2026-06-15T10:00:00.000Z',
    appName: overrides?.appName ?? 'TestApp',
    windowName: overrides?.windowName ?? 'Main Window',
    embedding: overrides?.embedding ?? [0.1, 0.2, 0.3],
    sourceTypes: overrides?.sourceTypes ?? ['ocr'],
    metadata: overrides?.metadata ?? { frameId: 1 }
  };
}

describe('SqliteVectorStore', () => {
  let db: DatabaseSync;
  let store: SqliteVectorStore;

  beforeEach(() => {
    db = createTestDb();
    store = new SqliteVectorStore(db);
  });

  describe('upsert', () => {
    it('inserts records into the vectors table', async () => {
      await store.upsert([makeRecord()]);
      const inspection = await store.inspect();
      expect(inspection.recordCount).toBe(1);
    });

    it('replaces existing records on id collision', async () => {
      await store.upsert([makeRecord({ text: 'v1' })]);
      await store.upsert([makeRecord({ text: 'v2' })]);
      const inspection = await store.inspect();
      expect(inspection.recordCount).toBe(1);
    });

    it('skips records without embedding', async () => {
      await store.upsert([makeRecord({ embedding: [] })]);
      const inspection = await store.inspect();
      expect(inspection.recordCount).toBe(0);
    });
  });

  describe('query', () => {
    it('returns records within time window', async () => {
      await store.upsert([
        makeRecord({ id: 'extracted:1', timestamp: '2026-06-15T08:00:00.000Z' }),
        makeRecord({ id: 'extracted:2', timestamp: '2026-06-15T10:00:00.000Z' }),
        makeRecord({ id: 'extracted:3', timestamp: '2026-06-15T12:00:00.000Z' })
      ]);

      const results = await store.query({
        queryEmbedding: [0.1, 0.2, 0.3],
        from: '2026-06-15T09:00:00.000Z',
        to: '2026-06-15T11:00:00.000Z'
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('extracted:2');
    });

    it('filters by appName', async () => {
      await store.upsert([
        makeRecord({ id: 'extracted:1', appName: 'App1' }),
        makeRecord({ id: 'extracted:2', appName: 'App2' })
      ]);

      const results = await store.query({
        queryEmbedding: [0.1, 0.2, 0.3],
        appName: 'App1'
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('extracted:1');
    });

    it('sorts by score descending', async () => {
      await store.upsert([
        makeRecord({ id: 'extracted:1', embedding: [0.1, 0.0, 0.0] }),
        makeRecord({ id: 'extracted:2', embedding: [0.9, 0.9, 0.9] })
      ]);

      const results = await store.query({
        queryEmbedding: [1.0, 1.0, 1.0],
        limit: 10
      });

      expect(results[0].id).toBe('extracted:2');
      expect(results[0].score!).toBeGreaterThan(results[1].score!);
    });

    it('respects limit', async () => {
      const records = Array.from({ length: 10 }, (_, i) =>
        makeRecord({ id: `extracted:${i}`, embedding: [i * 0.1, 0, 0] })
      );
      await store.upsert(records);

      const results = await store.query({
        queryEmbedding: [1, 0, 0],
        limit: 3
      });

      expect(results).toHaveLength(3);
    });
  });

  describe('reset', () => {
    it('clears all records', async () => {
      await store.upsert([makeRecord()]);
      await store.reset();
      const inspection = await store.inspect();
      expect(inspection.recordCount).toBe(0);
    });
  });

  describe('listByTimeWindow', () => {
    it('returns records within the window', async () => {
      await store.upsert([
        makeRecord({ id: 'extracted:1', timestamp: '2026-06-15T08:00:00.000Z' }),
        makeRecord({ id: 'extracted:2', timestamp: '2026-06-15T10:00:00.000Z' }),
        makeRecord({ id: 'extracted:3', timestamp: '2026-06-15T12:00:00.000Z' })
      ]);

      const records = await store.listByTimeWindow('2026-06-15T09:00:00.000Z', '2026-06-15T11:00:00.000Z');
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe('extracted:2');
    });
  });

  describe('deleteByFrameIds', () => {
    it('deletes by extracted:N convention', async () => {
      await store.upsert([
        makeRecord({ id: 'extracted:1' }),
        makeRecord({ id: 'extracted:2' })
      ]);

      const deleted = await store.deleteByFrameIds([1]);
      expect(deleted).toBe(1);

      const inspection = await store.inspect();
      expect(inspection.recordCount).toBe(1);
    });

    it('deletes by legacy metadata.frameId', async () => {
      await store.upsert([
        makeRecord({ id: 'legacy-id-1', metadata: { frameId: 42 } })
      ]);

      const deleted = await store.deleteByFrameIds([42]);
      expect(deleted).toBe(1);
    });

    it('deletes by metadata.captureId', async () => {
      await store.upsert([
        makeRecord({ id: 'cap-id-1', metadata: { captureId: 'screenpipe:frame:99' } })
      ]);

      const deleted = await store.deleteByFrameIds([99]);
      expect(deleted).toBe(1);
    });

    it('returns 0 for empty input', async () => {
      const deleted = await store.deleteByFrameIds([]);
      expect(deleted).toBe(0);
    });
  });

  describe('deleteByTimestampRange', () => {
    it('deletes records within the range', async () => {
      await store.upsert([
        makeRecord({ id: 'extracted:1', timestamp: '2026-06-15T08:00:00.000Z' }),
        makeRecord({ id: 'extracted:2', timestamp: '2026-06-15T10:00:00.000Z' }),
        makeRecord({ id: 'extracted:3', timestamp: '2026-06-15T12:00:00.000Z' })
      ]);

      const deleted = await store.deleteByTimestampRange('2026-06-15T09:00:00.000Z', '2026-06-15T11:00:00.000Z');
      expect(deleted).toBe(1);

      const inspection = await store.inspect();
      expect(inspection.recordCount).toBe(2);
    });

    it('does not touch records outside the range', async () => {
      await store.upsert([
        makeRecord({ id: 'extracted:1', timestamp: '2026-06-14T10:00:00.000Z' }),
        makeRecord({ id: 'extracted:2', timestamp: '2026-06-16T10:00:00.000Z' })
      ]);

      const deleted = await store.deleteByTimestampRange('2026-06-15T00:00:00.000Z', '2026-06-15T23:59:59.999Z');
      expect(deleted).toBe(0);
    });
  });

  describe('embedding round-trip', () => {
    it('preserves embedding values within Float32 tolerance', async () => {
      const embedding = [0.123456789, -0.987654321, 0.5, 1.0, 0.0];
      await store.upsert([makeRecord({ embedding })]);
      const records = await store.listByTimeWindow('2000-01-01T00:00:00.000Z', '2099-12-31T23:59:59.999Z');
      expect(records).toHaveLength(1);
      const expected = Array.from(new Float32Array(embedding));
      expect(records[0].embedding).toEqual(expected);
    });
  });
});
