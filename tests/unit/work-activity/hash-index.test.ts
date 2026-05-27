/**
 * Unit tests for `SqliteHashIndex` (work-activity-analysis task 5.1).
 *
 * The hash index is a tiny content-addressed cache backed by the
 * `embedding_hash_index` SQLite table. These tests cover every
 * behaviour the Embedding_Service depends on:
 *
 *   - `insert` + `lookup` round-trip (R5.1)
 *   - `lookup` returns `null` on a miss (R5.1)
 *   - `insert` uses `INSERT OR IGNORE` so duplicate inserts on the
 *     same hash do not overwrite the cached embedding (design §5.2)
 *   - Float32 BLOB round-trip preserves bit-for-bit precision when
 *     inputs are pre-coerced to f32 (the design contract)
 *
 * The store is a synchronous SQLite wrapper, so example-based tests
 * are the right tool here. The PBT layer for the embedding pipeline
 * (Hash_Dedup / W13, Empty_Skip / W14) lives in task 5.2's
 * `embedding-service.test.ts`.
 *
 * **Validates: Requirements 5.1**
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteHashIndex } from '../../../src/services/work-activity/hash-index.js';
import {
  initDerivedSchema,
  openDerivedDatabase,
  type DerivedDatabase
} from '../../../src/services/work-activity/derived-database.js';

// ---------------------------------------------------------------------------
// Per-test fixture — fresh in-memory derived database
// ---------------------------------------------------------------------------

let db: DerivedDatabase;
let index: SqliteHashIndex;

beforeEach(() => {
  db = openDerivedDatabase(':memory:');
  initDerivedSchema(db);
  index = new SqliteHashIndex(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HASH_A =
  'a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e'; // SHA256('hello')
const HASH_B =
  '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae'; // SHA256('foo')

/**
 * Coerces a `number[]` to its f32 representation (round-trip through
 * `Float32Array`) so test expectations match what the BLOB encoding
 * preserves. f32 has 23 bits of mantissa, while a JavaScript
 * `number` carries 52 bits — values like `0.1` round to a different
 * IEEE-754 float at f32 precision, so the comparison must be done
 * post-coercion to avoid spurious failures.
 */
function asFloat32(values: number[]): number[] {
  return Array.from(new Float32Array(values));
}

// ---------------------------------------------------------------------------
// `insert` + `lookup` round-trip
// ---------------------------------------------------------------------------

describe('SqliteHashIndex.insert + lookup', () => {
  it('round-trips a stored embedding through lookup (R5.1)', async () => {
    const embedding = asFloat32([0.1, -0.2, 0.3, -0.4, 0.5]);
    await index.insert(HASH_A, embedding);

    const fetched = await index.lookup(HASH_A);
    expect(fetched).not.toBeNull();
    expect(fetched).toEqual(embedding);
  });

  it('returns null for a hash that has never been inserted', async () => {
    expect(await index.lookup(HASH_B)).toBeNull();
  });

  it('returns null for a hash that has been inserted under a different key', async () => {
    await index.insert(HASH_A, asFloat32([0.5, 0.5]));
    expect(await index.lookup(HASH_B)).toBeNull();
  });

  it('returns an independent number[] on each lookup (no aliasing)', async () => {
    const embedding = asFloat32([0.25, 0.5, 0.75]);
    await index.insert(HASH_A, embedding);

    const first = await index.lookup(HASH_A);
    const second = await index.lookup(HASH_A);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Mutating one returned array MUST NOT affect a subsequent lookup —
    // the BLOB → number[] decoder must produce a fresh array per call.
    first![0] = 99;
    const third = await index.lookup(HASH_A);
    expect(third).toEqual(embedding);
    expect(second).toEqual(embedding);
  });

  it('handles an empty embedding (zero dimensions) without crashing', async () => {
    // Edge case: providers should never return an empty embedding,
    // but the BLOB encoding (`Float32Array.byteLength === 0`) is
    // legal SQL. The store must round-trip it as `[]` rather than
    // raising a misalignment error.
    await index.insert(HASH_A, []);
    const fetched = await index.lookup(HASH_A);
    expect(fetched).toEqual([]);
  });

  it('handles large embeddings (1536 dims, OpenAI text-embedding-3-small shape)', async () => {
    const dims = 1536;
    const embedding = asFloat32(
      Array.from({ length: dims }, (_, i) => (i % 2 === 0 ? i / 1000 : -i / 1000))
    );
    await index.insert(HASH_A, embedding);
    const fetched = await index.lookup(HASH_A);
    expect(fetched).not.toBeNull();
    expect(fetched).toHaveLength(dims);
    expect(fetched).toEqual(embedding);
  });
});

// ---------------------------------------------------------------------------
// `INSERT OR IGNORE` semantics
// ---------------------------------------------------------------------------

describe('SqliteHashIndex.insert (INSERT OR IGNORE)', () => {
  it('does not overwrite an existing row when the same hash is inserted twice', async () => {
    // The hash is content-addressed: in production the second
    // embedding would be byte-equal to the first because the
    // SHA256 input is identical. The test deliberately uses
    // *different* values to verify the no-overwrite guarantee — if
    // the implementation accidentally used `INSERT OR REPLACE`, the
    // second value would clobber the first.
    const original = asFloat32([1.0, 2.0, 3.0]);
    const conflicting = asFloat32([9.0, 8.0, 7.0]);

    await index.insert(HASH_A, original);
    await index.insert(HASH_A, conflicting);

    const fetched = await index.lookup(HASH_A);
    expect(fetched).toEqual(original);
  });

  it('does not raise on duplicate insert (idempotent for callers)', async () => {
    const embedding = asFloat32([0.1, 0.2]);
    await index.insert(HASH_A, embedding);
    // Repeated insert must resolve cleanly so the Embedding_Service
    // can fire-and-forget without wrapping each call in try/catch.
    await expect(index.insert(HASH_A, embedding)).resolves.toBeUndefined();
    await expect(index.insert(HASH_A, embedding)).resolves.toBeUndefined();
  });

  it('keeps independent rows for distinct hashes', async () => {
    const a = asFloat32([0.1, 0.2, 0.3]);
    const b = asFloat32([-0.4, -0.5, -0.6]);

    await index.insert(HASH_A, a);
    await index.insert(HASH_B, b);

    expect(await index.lookup(HASH_A)).toEqual(a);
    expect(await index.lookup(HASH_B)).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Float32 precision round-trip
// ---------------------------------------------------------------------------

describe('SqliteHashIndex Float32 BLOB round-trip', () => {
  it('preserves bit-for-bit precision for f32-coerced values', async () => {
    // After coercion to f32, the round trip MUST be exact — Float32
    // → Uint8Array → SQLite BLOB → Uint8Array → Float32 is a copy of
    // the byte representation. Any drift would indicate the encoding
    // is materialising values through f64 somewhere.
    const original = asFloat32([
      0.0,
      1.0,
      -1.0,
      Math.PI, // non-trivial mantissa
      Math.E,
      1e-10, // small magnitude
      1e10, // large magnitude
      -3.14159,
      0.1, // not exactly representable in f64; matters here only
      // because we already coerced to f32 above
      0.2,
      0.3
    ]);

    await index.insert(HASH_A, original);
    const fetched = await index.lookup(HASH_A);
    expect(fetched).not.toBeNull();

    // toEqual gives bit-equality on numbers; we additionally use
    // toBe per-element to make a precision regression easy to read
    // in test output.
    expect(fetched).toEqual(original);
    for (let i = 0; i < original.length; i++) {
      expect(fetched![i]).toBe(original[i]);
    }
  });

  it('handles f32 special values (Infinity, -Infinity, NaN)', async () => {
    // Embedding providers should never return these, but the codec
    // path uses raw bytes so it MUST handle them transparently —
    // catching a malformed embedding upstream is the Embedding_Service's
    // job, not the cache's.
    const original = [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN
    ];

    await index.insert(HASH_A, original);
    const fetched = await index.lookup(HASH_A);
    expect(fetched).not.toBeNull();
    expect(fetched![0]).toBe(Number.POSITIVE_INFINITY);
    expect(fetched![1]).toBe(Number.NEGATIVE_INFINITY);
    // NaN !== NaN, so use Number.isNaN explicitly.
    expect(Number.isNaN(fetched![2])).toBe(true);
  });

  it('rejects a stored BLOB whose byte length is not a multiple of 4', async () => {
    // Defence-in-depth: a hand-edited or corrupted database row could
    // have a BLOB whose length is not a multiple of 4. The decoder
    // must raise a clear error rather than returning a silently
    // truncated embedding (which would poison semantic search). We
    // bypass `insert` to write the corrupted row directly.
    const corruptedBytes = new Uint8Array([0x01, 0x02, 0x03]); // 3 bytes
    db.prepare(
      `INSERT INTO embedding_hash_index (extracted_text_hash, embedding) VALUES (?, ?)`
    ).run(HASH_A, corruptedBytes);

    await expect(index.lookup(HASH_A)).rejects.toThrow(/multiple of 4/);
  });
});
