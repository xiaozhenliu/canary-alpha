/**
 * Unit tests for `VectorStore.deleteByFrameIds` / `deleteByTimestampRange`.
 *
 * Validates: Requirements 5.3
 *
 * Property coverage:
 * - Property 15 (Cascade_VectorStore_FrameId_Completeness):
 *   For any vector store state S and a frame-id set F, after invoking
 *   `vectorStore.deleteByFrameIds(F)`, no record returned by `vectorStore.query`
 *   carries `metadata.frameId ∈ F`.
 *
 *   **Validates: Requirements 5.3**
 *
 * - Property 16 (Cascade_VectorStore_Timestamp_Completeness):
 *   For any vector store state S and a time window [from, to], after invoking
 *   `vectorStore.deleteByTimestampRange(from, to)`, no record returned by
 *   `vectorStore.query` carries `metadata.frameTimestamp ∈ [from, to]`
 *   (falling back to `record.timestamp` when the metadata field is absent).
 *
 *   **Validates: Requirements 5.3**
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../../src/types/app-config.js';
import { FileBackedVectorStore, InMemoryVectorStore } from '../../../src/services/retrieval/vector-store.js';
import type { VectorStoreRecord } from '../../../src/services/retrieval/types.js';
import { createTempVectorStorePath } from '../../helpers/temp-vector-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VECTOR_CONFIG: AppConfig['vectorStore'] = { kind: 'memory', path: '/tmp/work-activity-vs-delete' };

/**
 * Builds a `VectorStoreRecord` whose embedding makes it match an arbitrary
 * query embedding (we use [1, 0, 0]). `frameId` and `frameTimestamp` go to
 * `metadata` so the new delete methods can match by either field.
 */
function buildRecord(args: {
  id: string;
  frameId?: number | string;
  frameTimestamp?: string;
  topLevelTimestamp?: string;
  appName?: string;
}): VectorStoreRecord {
  return {
    id: args.id,
    text: `record ${args.id}`,
    timestamp: args.topLevelTimestamp ?? args.frameTimestamp ?? '2026-01-01T00:00:00.000Z',
    appName: args.appName,
    embedding: [1, 0, 0],
    sourceTypes: ['accessibility'],
    metadata: {
      ...(args.frameId !== undefined ? { frameId: args.frameId } : {}),
      ...(args.frameTimestamp !== undefined ? { frameTimestamp: args.frameTimestamp } : {})
    }
  };
}

// ---------------------------------------------------------------------------
// InMemoryVectorStore — example-based tests
// ---------------------------------------------------------------------------

describe('InMemoryVectorStore.deleteByFrameIds', () => {
  it('removes records whose metadata.frameId matches', async () => {
    const store = new InMemoryVectorStore(VECTOR_CONFIG);
    await store.upsert([
      buildRecord({ id: 'a', frameId: 1 }),
      buildRecord({ id: 'b', frameId: 2 }),
      buildRecord({ id: 'c', frameId: 3 })
    ]);

    const deleted = await store.deleteByFrameIds([1, 3]);

    expect(deleted).toBe(2);
    const remaining = await store.query({ queryEmbedding: [1, 0, 0], limit: 10 });
    expect(remaining.map((r) => r.id).sort()).toEqual(['b']);
  });

  it('normalises numeric and string frame ids via String(id)', async () => {
    const store = new InMemoryVectorStore(VECTOR_CONFIG);
    await store.upsert([
      buildRecord({ id: 'a', frameId: 42 }),       // stored as number
      buildRecord({ id: 'b', frameId: '42' }),     // stored as string
      buildRecord({ id: 'c', frameId: 7 })
    ]);

    const deleted = await store.deleteByFrameIds(['42']);

    expect(deleted).toBe(2);
    const remaining = await store.query({ queryEmbedding: [1, 0, 0], limit: 10 });
    expect(remaining.map((r) => r.id)).toEqual(['c']);
  });

  it('leaves records without metadata.frameId untouched', async () => {
    const store = new InMemoryVectorStore(VECTOR_CONFIG);
    await store.upsert([
      buildRecord({ id: 'a', frameId: 1 }),
      buildRecord({ id: 'b' }) // no frameId metadata
    ]);

    const deleted = await store.deleteByFrameIds([1, 2, 3]);

    expect(deleted).toBe(1);
    const remaining = await store.query({ queryEmbedding: [1, 0, 0], limit: 10 });
    expect(remaining.map((r) => r.id)).toEqual(['b']);
  });

  it('leaves records whose metadata.frameId is null untouched', async () => {
    // The metadata may carry an explicit `null` frameId (e.g. from a serialised
    // snapshot). Such records must not be matched against any deletion target.
    const store = new InMemoryVectorStore(VECTOR_CONFIG);
    await store.upsert([
      buildRecord({ id: 'a', frameId: 1 }),
      // Hand-craft the metadata so frameId is explicitly null (not absent).
      {
        id: 'null-frame',
        text: 'record null-frame',
        timestamp: '2026-01-01T00:00:00.000Z',
        embedding: [1, 0, 0],
        sourceTypes: ['accessibility'],
        metadata: { frameId: null }
      }
    ]);

    const deleted = await store.deleteByFrameIds([1]);

    expect(deleted).toBe(1);
    const remaining = await store.query({ queryEmbedding: [1, 0, 0], limit: 10 });
    expect(remaining.map((r) => r.id)).toEqual(['null-frame']);
  });

  it('returns 0 and is a no-op when frameIds is empty', async () => {
    const store = new InMemoryVectorStore(VECTOR_CONFIG);
    await store.upsert([buildRecord({ id: 'a', frameId: 1 })]);

    const deleted = await store.deleteByFrameIds([]);

    expect(deleted).toBe(0);
    const remaining = await store.query({ queryEmbedding: [1, 0, 0], limit: 10 });
    expect(remaining).toHaveLength(1);
  });

  it('returns 0 when no record matches', async () => {
    const store = new InMemoryVectorStore(VECTOR_CONFIG);
    await store.upsert([buildRecord({ id: 'a', frameId: 1 })]);

    const deleted = await store.deleteByFrameIds([99, 100]);

    expect(deleted).toBe(0);
  });

  it('deleteByFrameIds matches records that only carry metadata.captureId', async () => {
    // Records written after the Task 5 dual-write migration carry
    // `captureId: 'screenpipe:frame:<id>'` instead of (or in addition
    // to) the legacy `frameId` key. The store MUST match on the neutral
    // key so Cascade_Delete works for post-migration records.
    const store = new InMemoryVectorStore(VECTOR_CONFIG);
    await store.upsert([{
      id: 'r1',
      text: 't',
      timestamp: '2026-06-12T00:00:00Z',
      sourceTypes: ['accessibility'],
      metadata: { captureId: 'screenpipe:frame:42' }
    }]);
    const deleted = await store.deleteByFrameIds([42]);
    expect(deleted).toBe(1);
  });
});

describe('InMemoryVectorStore.deleteByTimestampRange', () => {
  it('removes records whose metadata.frameTimestamp falls in [from, to] inclusive', async () => {
    const store = new InMemoryVectorStore(VECTOR_CONFIG);
    await store.upsert([
      buildRecord({ id: 'before', frameTimestamp: '2026-01-01T09:59:59.999Z' }),
      buildRecord({ id: 'from-edge', frameTimestamp: '2026-01-01T10:00:00.000Z' }),
      buildRecord({ id: 'middle', frameTimestamp: '2026-01-01T10:30:00.000Z' }),
      buildRecord({ id: 'to-edge', frameTimestamp: '2026-01-01T11:00:00.000Z' }),
      buildRecord({ id: 'after', frameTimestamp: '2026-01-01T11:00:00.001Z' })
    ]);

    const deleted = await store.deleteByTimestampRange(
      '2026-01-01T10:00:00.000Z',
      '2026-01-01T11:00:00.000Z'
    );

    expect(deleted).toBe(3);
    const remaining = await store.query({ queryEmbedding: [1, 0, 0], limit: 10 });
    expect(remaining.map((r) => r.id).sort()).toEqual(['after', 'before']);
  });

  it('falls back to record.timestamp when metadata.frameTimestamp is absent', async () => {
    const store = new InMemoryVectorStore(VECTOR_CONFIG);
    await store.upsert([
      // metadata.frameTimestamp absent — fallback to top-level timestamp
      buildRecord({ id: 'a', topLevelTimestamp: '2026-01-01T10:30:00.000Z' }),
      buildRecord({ id: 'b', topLevelTimestamp: '2026-01-01T12:00:00.000Z' })
    ]);

    const deleted = await store.deleteByTimestampRange(
      '2026-01-01T10:00:00.000Z',
      '2026-01-01T11:00:00.000Z'
    );

    expect(deleted).toBe(1);
    const remaining = await store.query({ queryEmbedding: [1, 0, 0], limit: 10 });
    expect(remaining.map((r) => r.id)).toEqual(['b']);
  });

  it('falls back to record.timestamp when metadata.frameTimestamp is non-string', async () => {
    // A serialised snapshot might persist a numeric / null frameTimestamp.
    // The implementation only honours string metadata; non-string values
    // must fall back to `record.timestamp`.
    const store = new InMemoryVectorStore(VECTOR_CONFIG);
    await store.upsert([
      {
        id: 'numeric-meta',
        text: 'record numeric-meta',
        timestamp: '2026-01-01T10:30:00.000Z', // top-level inside [from, to]
        embedding: [1, 0, 0],
        sourceTypes: ['accessibility'],
        // frameTimestamp is a number — must NOT be used; fallback to top-level
        metadata: { frameTimestamp: 1735734600000 as unknown as string }
      },
      {
        id: 'outside-window',
        text: 'record outside-window',
        timestamp: '2026-01-01T12:00:00.000Z',
        embedding: [1, 0, 0],
        sourceTypes: ['accessibility'],
        metadata: { frameTimestamp: null as unknown as string }
      }
    ]);

    const deleted = await store.deleteByTimestampRange(
      '2026-01-01T10:00:00.000Z',
      '2026-01-01T11:00:00.000Z'
    );

    expect(deleted).toBe(1);
    const remaining = await store.query({ queryEmbedding: [1, 0, 0], limit: 10 });
    expect(remaining.map((r) => r.id)).toEqual(['outside-window']);
  });

  it('compares ISO timestamps with mixed timezone suffixes correctly', async () => {
    // 10:30+00:00 == 10:30Z; 18:30+08:00 == 10:30Z; 09:30-01:00 == 10:30Z.
    // All three records should fall inside the same UTC window after parse.
    const store = new InMemoryVectorStore(VECTOR_CONFIG);
    await store.upsert([
      buildRecord({ id: 'utc', frameTimestamp: '2026-01-01T10:30:00Z' }),
      buildRecord({ id: 'plus8', frameTimestamp: '2026-01-01T18:30:00+08:00' }),
      buildRecord({ id: 'minus1', frameTimestamp: '2026-01-01T09:30:00-01:00' })
    ]);

    const deleted = await store.deleteByTimestampRange(
      '2026-01-01T10:00:00.000Z',
      '2026-01-01T11:00:00.000Z'
    );

    expect(deleted).toBe(3);
    const remaining = await store.query({ queryEmbedding: [1, 0, 0], limit: 10 });
    expect(remaining).toHaveLength(0);
  });

  it('returns 0 when no record falls in the range', async () => {
    const store = new InMemoryVectorStore(VECTOR_CONFIG);
    await store.upsert([buildRecord({ id: 'a', frameTimestamp: '2026-02-01T00:00:00.000Z' })]);

    const deleted = await store.deleteByTimestampRange(
      '2026-01-01T00:00:00.000Z',
      '2026-01-31T23:59:59.999Z'
    );

    expect(deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FileBackedVectorStore — persistence integration
// ---------------------------------------------------------------------------

describe('FileBackedVectorStore deletion persists changes via .tmp rename', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it('deleteByFrameIds persists the new record set to disk', async () => {
    const tempStore = await createTempVectorStorePath('vs-delete-by-frame-id-');
    cleanups.push(() => tempStore.cleanup());

    const filePath = join(tempStore.path, 'vector-store.json');
    const first = new FileBackedVectorStore(
      { kind: 'chroma', path: tempStore.path },
      filePath
    );
    await first.upsert([
      buildRecord({ id: 'keep', frameId: 1 }),
      buildRecord({ id: 'drop', frameId: 2 })
    ]);

    const deleted = await first.deleteByFrameIds([2]);
    expect(deleted).toBe(1);
    await first.close();

    // ── Reopen a fresh store from the same file and verify persistence ──
    const second = new FileBackedVectorStore(
      { kind: 'chroma', path: tempStore.path },
      filePath
    );
    const remaining = await second.query({ queryEmbedding: [1, 0, 0], limit: 10 });
    expect(remaining.map((r) => r.id)).toEqual(['keep']);
    await second.close();

    // Sanity check: file does not contain the removed record.
    const raw = await readFile(filePath, 'utf8');
    expect(raw).not.toContain('"drop"');
  });

  it('deleteByTimestampRange persists the new record set to disk', async () => {
    const tempStore = await createTempVectorStorePath('vs-delete-by-ts-range-');
    cleanups.push(() => tempStore.cleanup());

    const filePath = join(tempStore.path, 'vector-store.json');
    const first = new FileBackedVectorStore(
      { kind: 'chroma', path: tempStore.path },
      filePath
    );
    await first.upsert([
      buildRecord({ id: 'before', frameTimestamp: '2026-01-01T09:00:00.000Z' }),
      buildRecord({ id: 'inside', frameTimestamp: '2026-01-01T10:30:00.000Z' }),
      buildRecord({ id: 'after', frameTimestamp: '2026-01-01T12:00:00.000Z' })
    ]);

    const deleted = await first.deleteByTimestampRange(
      '2026-01-01T10:00:00.000Z',
      '2026-01-01T11:00:00.000Z'
    );
    expect(deleted).toBe(1);
    await first.close();

    const second = new FileBackedVectorStore(
      { kind: 'chroma', path: tempStore.path },
      filePath
    );
    const remaining = await second.query({ queryEmbedding: [1, 0, 0], limit: 10 });
    expect(remaining.map((r) => r.id).sort()).toEqual(['after', 'before']);
    await second.close();
  });

  it('deleteByFrameIds with no matches does not rewrite the file (returns 0)', async () => {
    const tempStore = await createTempVectorStorePath('vs-delete-noop-');
    cleanups.push(() => tempStore.cleanup());

    const filePath = join(tempStore.path, 'vector-store.json');
    const store = new FileBackedVectorStore(
      { kind: 'chroma', path: tempStore.path },
      filePath
    );
    await store.upsert([buildRecord({ id: 'keep', frameId: 1 })]);

    const deleted = await store.deleteByFrameIds([999]);
    expect(deleted).toBe(0);

    const remaining = await store.query({ queryEmbedding: [1, 0, 0], limit: 10 });
    expect(remaining.map((r) => r.id)).toEqual(['keep']);
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// Property 15: vectorStore deleteByFrameIds 完整性
// **Validates: Requirements 5.3**
// ---------------------------------------------------------------------------

/**
 * Generates a list of records (each with a `frameId` drawn from a small pool
 * to encourage overlap with the deleted frame-id set) and a subset F of frame
 * ids to delete.
 */
const recordsWithFrameIdSetArb: fc.Arbitrary<{
  records: VectorStoreRecord[];
  framesToDelete: number[];
}> = fc
  .tuple(
    fc.array(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 16 }).map((s) => `r-${s}`),
        // frameId drawn from a small pool (1..10) so deletions actually hit
        frameId: fc.integer({ min: 1, max: 10 }),
        frameTimestamp: fc
          .date({
            min: new Date('2026-01-01T00:00:00Z'),
            max: new Date('2026-01-31T23:59:59Z')
          })
          .map((d) => d.toISOString())
      }),
      { minLength: 0, maxLength: 30 }
    ),
    // F: a subset of the frame-id pool to delete
    fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 0, maxLength: 10 })
  )
  .map(([recordSpecs, framesToDelete]) => {
    // Deduplicate by id so upsert doesn't merge them away
    const seen = new Set<string>();
    const records: VectorStoreRecord[] = [];
    for (const spec of recordSpecs) {
      if (seen.has(spec.id)) continue;
      seen.add(spec.id);
      records.push(buildRecord({
        id: spec.id,
        frameId: spec.frameId,
        frameTimestamp: spec.frameTimestamp
      }));
    }
    return { records, framesToDelete };
  });

describe('Property 15: deleteByFrameIds completeness', () => {
  it(
    'after deleteByFrameIds(F), no queried record carries metadata.frameId ∈ F',
    async () => {
      await fc.assert(
        fc.asyncProperty(recordsWithFrameIdSetArb, async ({ records, framesToDelete }) => {
          const store = new InMemoryVectorStore(VECTOR_CONFIG);
          if (records.length > 0) {
            await store.upsert(records);
          }

          const targetSet = new Set(framesToDelete.map(String));

          // Compute expected delete count BEFORE invoking the method.
          const expectedDeleted = records.filter((r) => {
            const frameId = r.metadata?.frameId;
            return frameId !== undefined && targetSet.has(String(frameId));
          }).length;

          const actualDeleted = await store.deleteByFrameIds(framesToDelete);

          // ── Assertion 1: returned count matches expectation ──
          expect(actualDeleted).toBe(expectedDeleted);

          // ── Assertion 2: no remaining record has frameId ∈ F ──
          const remaining = await store.query({ queryEmbedding: [1, 0, 0], limit: 1000 });
          for (const item of remaining) {
            // The result type doesn't include metadata, but the id must match
            // a kept input record.
            const sourceRecord = records.find((r) => r.id === item.id);
            expect(sourceRecord).toBeDefined();
            const frameId = sourceRecord?.metadata?.frameId;
            if (frameId !== undefined) {
              expect(targetSet.has(String(frameId))).toBe(false);
            }
          }
        }),
        { numRuns: 100 }
      );
    },
    30_000
  );
});

// ---------------------------------------------------------------------------
// Property 16: vectorStore deleteByTimestampRange 完整性
// **Validates: Requirements 5.3**
// ---------------------------------------------------------------------------

/**
 * Generates a list of records (each with a `frameTimestamp` and disjoint id)
 * plus a [from, to] window that may or may not overlap the records' timestamps.
 */
const recordsWithTimestampRangeArb: fc.Arbitrary<{
  records: VectorStoreRecord[];
  from: string;
  to: string;
}> = fc
  .tuple(
    fc.array(
      fc.record({
        idSeed: fc.string({ minLength: 1, maxLength: 16 }),
        frameTimestamp: fc
          .date({
            min: new Date('2026-01-01T00:00:00Z'),
            max: new Date('2026-12-31T23:59:59Z')
          })
          .map((d) => d.toISOString())
      }),
      { minLength: 0, maxLength: 30 }
    ),
    fc.tuple(
      fc.date({
        min: new Date('2026-01-01T00:00:00Z'),
        max: new Date('2026-12-31T23:59:59Z')
      }),
      fc.integer({ min: 0, max: 60 * 60 * 24 * 30 }) // window width in seconds (up to ~30 days)
    )
  )
  .map(([recordSpecs, [windowStart, widthSeconds]]) => {
    const seen = new Set<string>();
    const records: VectorStoreRecord[] = [];
    for (const spec of recordSpecs) {
      const id = `r-${spec.idSeed}`;
      if (seen.has(id)) continue;
      seen.add(id);
      records.push(buildRecord({
        id,
        frameTimestamp: spec.frameTimestamp
      }));
    }
    const from = windowStart.toISOString();
    const to = new Date(windowStart.getTime() + widthSeconds * 1000).toISOString();
    return { records, from, to };
  });

describe('Property 16: deleteByTimestampRange completeness', () => {
  it(
    'after deleteByTimestampRange(from, to), no queried record carries timestamp ∈ [from, to]',
    async () => {
      await fc.assert(
        fc.asyncProperty(recordsWithTimestampRangeArb, async ({ records, from, to }) => {
          const store = new InMemoryVectorStore(VECTOR_CONFIG);
          if (records.length > 0) {
            await store.upsert(records);
          }

          const fromMillis = Date.parse(from);
          const toMillis = Date.parse(to);

          // Compute expected count using the same fallback rule as the impl:
          //   metadata.frameTimestamp ?? record.timestamp
          const inRange = (r: VectorStoreRecord): boolean => {
            const metaTs = r.metadata?.frameTimestamp;
            const ts =
              typeof metaTs === 'string' && metaTs.length > 0 ? metaTs : r.timestamp;
            const millis = Date.parse(ts);
            return millis >= fromMillis && millis <= toMillis;
          };
          const expectedDeleted = records.filter(inRange).length;

          const actualDeleted = await store.deleteByTimestampRange(from, to);

          // ── Assertion 1: returned count matches expectation ──
          expect(actualDeleted).toBe(expectedDeleted);

          // ── Assertion 2: no remaining record has timestamp ∈ [from, to] ──
          const remaining = await store.query({ queryEmbedding: [1, 0, 0], limit: 1000 });
          for (const item of remaining) {
            const sourceRecord = records.find((r) => r.id === item.id);
            expect(sourceRecord).toBeDefined();
            if (sourceRecord) {
              expect(inRange(sourceRecord)).toBe(false);
            }
          }
        }),
        { numRuns: 100 }
      );
    },
    30_000
  );
});
