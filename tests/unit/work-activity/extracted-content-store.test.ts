/**
 * Unit tests for `SqliteExtractedContentStore` (work-activity-analysis
 * task 3.4).
 *
 * The store wraps the `extracted_content` SQLite table behind a small
 * Promise-based interface. These tests exercise every method against a
 * fresh in-memory derived database created via {@link openDerivedDatabase}
 * + {@link initDerivedSchema}, covering:
 *
 *   - `upsert` insert + INSERT OR REPLACE behaviour (R1.8 — re-running
 *     extraction overwrites the existing row)
 *   - `getByFrameIds` for one id, multiple ids, deduplicated input,
 *     missing ids, and the empty-array fast path
 *   - `deleteByFrameIds` returning the actual `changes` count and
 *     the empty-array fast path
 *   - `listByTimeWindow` ordering + inclusive bound semantics
 *   - `countByTimeWindow` returning `{ total, empty }` correctly even
 *     when every row is Empty_Extraction (and zero rows in window)
 *   - `findLastExtractedAt` ignoring Empty_Extraction rows (R2.1)
 *
 * The store is intentionally simple, so the tests are example-based —
 * property-based tests are not the right tool when the operations are
 * single-statement SQL wrappers. The PBT for the registry that produces
 * `ExtractionResult`s (Determinism / Coverage / Refinement_Override)
 * lives in task 3.3's `extraction-registry.test.ts`.
 *
 * **Validates: Requirements 1.1, 2.1**
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteExtractedContentStore } from '../../../src/services/work-activity/extraction/extracted-content-store.js';
import type { ExtractionResult } from '../../../src/services/work-activity/extraction/types.js';
import {
  initDerivedSchema,
  openDerivedDatabase,
  type DerivedDatabase
} from '../../../src/services/work-activity/derived-database.js';

// ---------------------------------------------------------------------------
// Per-test fixture — fresh in-memory derived database
// ---------------------------------------------------------------------------

let db: DerivedDatabase;
let store: SqliteExtractedContentStore;

beforeEach(() => {
  db = openDerivedDatabase(':memory:');
  initDerivedSchema(db);
  store = new SqliteExtractedContentStore(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds an `ExtractionResult` with sensible defaults the tests can
 * override per-case. The default produces a non-empty extraction so
 * `findLastExtractedAt` and similar paths see usable data; tests that
 * need Empty_Extraction pass `extractedText: ''` and
 * `extractedTextHash: null` explicitly.
 */
function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    frameId: 1,
    frameTimestamp: '2026-05-25T10:00:00.000Z',
    appName: 'TestApp',
    contextLabel: 'TestWindow.txt',
    contextKey: 'TestApp::testwindow.txt',
    extractedText: 'hello world',
    extractedTextHash:
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    extractionRuleKind: 'generic',
    sourceTypes: ['accessibility'],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// `upsert`
// ---------------------------------------------------------------------------

describe('SqliteExtractedContentStore.upsert', () => {
  it('inserts a new row that round-trips through getByFrameIds', async () => {
    const e = makeExtraction({ frameId: 7 });
    await store.upsert(e);
    const fetched = await store.getByFrameIds([7]);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toEqual(e);
  });

  it('round-trips the original capture cursor for checkpoint recovery', async () => {
    const e = makeExtraction({ frameId: 8, captureCursor: 'capture-8' });
    await store.upsert(e);

    const fetched = await store.getByFrameIds([8]);
    expect(fetched[0].captureCursor).toBe('capture-8');
  });

  it('replaces an existing row keyed by frameId (INSERT OR REPLACE)', async () => {
    const initial = makeExtraction({
      frameId: 7,
      extractedText: 'first version',
      extractedTextHash:
        'a' + '0'.repeat(63) // any non-null sentinel; we just check it changes
    });
    await store.upsert(initial);

    const replaced = makeExtraction({
      frameId: 7,
      extractedText: 'second version',
      extractedTextHash:
        'b' + '0'.repeat(63),
      contextLabel: 'updated label'
    });
    await store.upsert(replaced);

    const fetched = await store.getByFrameIds([7]);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].extractedText).toBe('second version');
    expect(fetched[0].extractedTextHash).toBe('b' + '0'.repeat(63));
    expect(fetched[0].contextLabel).toBe('updated label');
  });

  it('persists Empty_Extraction with empty text and null hash', async () => {
    const empty = makeExtraction({
      frameId: 9,
      extractedText: '',
      extractedTextHash: null
    });
    await store.upsert(empty);
    const fetched = await store.getByFrameIds([9]);
    expect(fetched[0].extractedText).toBe('');
    expect(fetched[0].extractedTextHash).toBeNull();
  });

  it('persists missing appName as undefined on the round trip', async () => {
    // The SQL column allows NULL; the contract surfaces it as undefined
    // because the `ExtractionResult` shape declares `appName?: string`.
    const e = makeExtraction({ frameId: 11, appName: undefined });
    await store.upsert(e);
    const fetched = await store.getByFrameIds([11]);
    expect(fetched[0].appName).toBeUndefined();
  });

  it('round-trips sourceTypes as a JSON-encoded array', async () => {
    const e = makeExtraction({
      frameId: 13,
      sourceTypes: ['accessibility', 'ocr']
    });
    await store.upsert(e);
    const fetched = await store.getByFrameIds([13]);
    expect(fetched[0].sourceTypes).toEqual(['accessibility', 'ocr']);
  });
});

// ---------------------------------------------------------------------------
// `getByFrameIds`
// ---------------------------------------------------------------------------

describe('SqliteExtractedContentStore.getByFrameIds', () => {
  it('returns an empty array for empty input without touching the database', async () => {
    // Sanity: SQLite would reject `IN ()` as a parse error, so an
    // empty fast path is required. We also assert the result is the
    // correct shape rather than throwing.
    const fetched = await store.getByFrameIds([]);
    expect(fetched).toEqual([]);
  });

  it('returns rows in any order, but all requested ids that exist', async () => {
    await store.upsert(makeExtraction({ frameId: 1, extractedText: 'one' }));
    await store.upsert(makeExtraction({ frameId: 2, extractedText: 'two' }));
    await store.upsert(makeExtraction({ frameId: 3, extractedText: 'three' }));

    const fetched = await store.getByFrameIds([3, 1, 2]);
    const byId = new Map(fetched.map((row) => [row.frameId, row.extractedText]));
    expect(byId.get(1)).toBe('one');
    expect(byId.get(2)).toBe('two');
    expect(byId.get(3)).toBe('three');
    expect(fetched).toHaveLength(3);
  });

  it('skips ids that do not exist without raising', async () => {
    await store.upsert(makeExtraction({ frameId: 1, extractedText: 'one' }));
    const fetched = await store.getByFrameIds([1, 999]);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].frameId).toBe(1);
  });

  it('deduplicates repeated ids in the input array', async () => {
    await store.upsert(makeExtraction({ frameId: 5, extractedText: 'five' }));
    const fetched = await store.getByFrameIds([5, 5, 5]);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].frameId).toBe(5);
  });

  it('handles inputs that exceed the parameter-chunk size by splitting into multiple statements', async () => {
    // Chunk size is 500; insert 1200 rows and request all of them at
    // once. The store must transparently split the IN () query into
    // multiple statements while still returning all rows.
    const ids: number[] = [];
    for (let i = 1; i <= 1200; i++) {
      ids.push(i);
      await store.upsert(
        makeExtraction({ frameId: i, frameTimestamp: tsAt(i) })
      );
    }
    const fetched = await store.getByFrameIds(ids);
    expect(fetched).toHaveLength(1200);
    const fetchedIds = new Set(fetched.map((row) => row.frameId));
    for (let i = 1; i <= 1200; i++) {
      expect(fetchedIds.has(i)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// `deleteByFrameIds`
// ---------------------------------------------------------------------------

describe('SqliteExtractedContentStore.deleteByFrameIds', () => {
  it('returns 0 for empty input without touching the database', async () => {
    const removed = await store.deleteByFrameIds([]);
    expect(removed).toBe(0);
  });

  it('removes the requested rows and reports the actual changes count', async () => {
    await store.upsert(makeExtraction({ frameId: 1 }));
    await store.upsert(makeExtraction({ frameId: 2 }));
    await store.upsert(makeExtraction({ frameId: 3 }));

    const removed = await store.deleteByFrameIds([1, 2]);
    expect(removed).toBe(2);

    const remaining = await store.getByFrameIds([1, 2, 3]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].frameId).toBe(3);
  });

  it('counts only rows that actually existed (silently skips unknown ids)', async () => {
    await store.upsert(makeExtraction({ frameId: 1 }));
    const removed = await store.deleteByFrameIds([1, 999]);
    expect(removed).toBe(1);
  });

  it('handles inputs that exceed the parameter-chunk size', async () => {
    const ids: number[] = [];
    for (let i = 1; i <= 1200; i++) {
      ids.push(i);
      await store.upsert(makeExtraction({ frameId: i, frameTimestamp: tsAt(i) }));
    }
    const removed = await store.deleteByFrameIds(ids);
    expect(removed).toBe(1200);

    const remaining = await store.getByFrameIds(ids);
    expect(remaining).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// `listByTimeWindow`
// ---------------------------------------------------------------------------

describe('SqliteExtractedContentStore.listByTimeWindow', () => {
  it('returns rows ordered by frame_timestamp ascending', async () => {
    await store.upsert(makeExtraction({ frameId: 3, frameTimestamp: tsAt(30) }));
    await store.upsert(makeExtraction({ frameId: 1, frameTimestamp: tsAt(10) }));
    await store.upsert(makeExtraction({ frameId: 2, frameTimestamp: tsAt(20) }));

    const rows = await store.listByTimeWindow(tsAt(0), tsAt(100));
    expect(rows.map((r) => r.frameId)).toEqual([1, 2, 3]);
  });

  it('treats both bounds as inclusive (BETWEEN semantics)', async () => {
    await store.upsert(makeExtraction({ frameId: 1, frameTimestamp: tsAt(10) }));
    await store.upsert(makeExtraction({ frameId: 2, frameTimestamp: tsAt(20) }));
    await store.upsert(makeExtraction({ frameId: 3, frameTimestamp: tsAt(30) }));

    const rows = await store.listByTimeWindow(tsAt(10), tsAt(30));
    expect(rows.map((r) => r.frameId)).toEqual([1, 2, 3]);
  });

  it('matches rows stored with UTC timestamps against UTC-Z window bounds', async () => {
    // After Phase 0 timestamp normalization, all timestamps stored in
    // derived.sqlite are canonical UTC Z-suffix. The write path
    // (indexing-service.ts) normalizes before upsert, so raw string
    // BETWEEN comparison works correctly.
    await store.upsert(
      makeExtraction({ frameId: 42, frameTimestamp: '2026-05-25T10:01:00.000Z' })
    );
    const rows = await store.listByTimeWindow(
      '2026-05-25T10:00:00.000Z',
      '2026-05-25T10:02:00.000Z'
    );
    expect(rows.map((r) => r.frameId)).toEqual([42]);
  });

  it('returns an empty array when the window contains no rows', async () => {
    await store.upsert(makeExtraction({ frameId: 1, frameTimestamp: tsAt(10) }));
    const rows = await store.listByTimeWindow(tsAt(50), tsAt(100));
    expect(rows).toEqual([]);
  });

  it('includes Empty_Extraction rows that fall in the window', async () => {
    await store.upsert(
      makeExtraction({
        frameId: 1,
        frameTimestamp: tsAt(10),
        extractedText: '',
        extractedTextHash: null
      })
    );
    await store.upsert(makeExtraction({ frameId: 2, frameTimestamp: tsAt(20) }));

    const rows = await store.listByTimeWindow(tsAt(0), tsAt(60));
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// `countByTimeWindow`
// ---------------------------------------------------------------------------

describe('SqliteExtractedContentStore.countByTimeWindow', () => {
  it('returns { total: 0, empty: 0 } when the window is empty', async () => {
    const result = await store.countByTimeWindow(tsAt(0), tsAt(60));
    expect(result).toEqual({ total: 0, empty: 0 });
  });

  it('counts empty rows correctly when every row is Empty_Extraction', async () => {
    await store.upsert(
      makeExtraction({
        frameId: 1,
        frameTimestamp: tsAt(10),
        extractedText: '',
        extractedTextHash: null
      })
    );
    await store.upsert(
      makeExtraction({
        frameId: 2,
        frameTimestamp: tsAt(20),
        extractedText: '',
        extractedTextHash: null
      })
    );
    const result = await store.countByTimeWindow(tsAt(0), tsAt(60));
    expect(result).toEqual({ total: 2, empty: 2 });
  });

  it('separates total and empty counts in a mixed window', async () => {
    await store.upsert(
      makeExtraction({
        frameId: 1,
        frameTimestamp: tsAt(10),
        extractedText: '',
        extractedTextHash: null
      })
    );
    await store.upsert(
      makeExtraction({
        frameId: 2,
        frameTimestamp: tsAt(20),
        extractedText: 'real text'
      })
    );
    await store.upsert(
      makeExtraction({
        frameId: 3,
        frameTimestamp: tsAt(30),
        extractedText: 'more text'
      })
    );

    const result = await store.countByTimeWindow(tsAt(0), tsAt(60));
    expect(result).toEqual({ total: 3, empty: 1 });
  });

  it('respects window bounds (excludes rows outside [from, to])', async () => {
    await store.upsert(makeExtraction({ frameId: 1, frameTimestamp: tsAt(10) }));
    await store.upsert(makeExtraction({ frameId: 2, frameTimestamp: tsAt(50) }));

    const result = await store.countByTimeWindow(tsAt(0), tsAt(20));
    expect(result).toEqual({ total: 1, empty: 0 });
  });
});

// ---------------------------------------------------------------------------
// `findLastExtractedAt`
// ---------------------------------------------------------------------------

describe('SqliteExtractedContentStore.findLastExtractedAt', () => {
  it('returns null when the table is empty', async () => {
    expect(await store.findLastExtractedAt()).toBeNull();
  });

  it('returns null when every row is Empty_Extraction (R2.1)', async () => {
    // R2.1: lastExtractedAt is the most recent SUCCESSFUL extraction —
    // an Empty_Extraction is not a successful extraction even though
    // the row exists.
    await store.upsert(
      makeExtraction({
        frameId: 1,
        frameTimestamp: tsAt(10),
        extractedText: '',
        extractedTextHash: null
      })
    );
    await store.upsert(
      makeExtraction({
        frameId: 2,
        frameTimestamp: tsAt(20),
        extractedText: '',
        extractedTextHash: null
      })
    );
    expect(await store.findLastExtractedAt()).toBeNull();
  });

  it('returns the maximum frame_timestamp across non-empty rows', async () => {
    await store.upsert(
      makeExtraction({ frameId: 1, frameTimestamp: tsAt(10), extractedText: 'one' })
    );
    await store.upsert(
      makeExtraction({ frameId: 2, frameTimestamp: tsAt(30), extractedText: 'three' })
    );
    await store.upsert(
      makeExtraction({ frameId: 3, frameTimestamp: tsAt(20), extractedText: 'two' })
    );

    expect(await store.findLastExtractedAt()).toBe(tsAt(30));
  });

  it('ignores Empty_Extraction rows even when they are the most recent', async () => {
    await store.upsert(
      makeExtraction({
        frameId: 1,
        frameTimestamp: tsAt(10),
        extractedText: 'real'
      })
    );
    // Empty_Extraction at a later timestamp must NOT shadow the earlier
    // successful extraction.
    await store.upsert(
      makeExtraction({
        frameId: 2,
        frameTimestamp: tsAt(60),
        extractedText: '',
        extractedTextHash: null
      })
    );
    expect(await store.findLastExtractedAt()).toBe(tsAt(10));
  });
});

// ---------------------------------------------------------------------------
// Helpers — local to this test file
// ---------------------------------------------------------------------------

/**
 * Builds an ISO 8601 timestamp `secondsAfterEpoch` seconds after the
 * arbitrary base `2026-05-25T10:00:00Z`. Keeps the per-test timeline
 * compact and easy to reason about — `tsAt(10)` is "10 seconds in".
 */
function tsAt(secondsAfterEpoch: number): string {
  const base = Date.UTC(2026, 4, 25, 10, 0, 0); // month is 0-indexed
  return new Date(base + secondsAfterEpoch * 1000).toISOString();
}
