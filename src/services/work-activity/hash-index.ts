/**
 * Derived-database adapter for the `embedding_hash_index` table.
 *
 * Task 5.1 (work-activity-analysis): a tiny content-addressed cache
 * keyed by `SHA256(extracted_text)`. The Embedding_Service consults
 * this index before calling the embedding provider so two frames whose
 * `extractedText` hashes are equal share a single embedding (R5.1 +
 * **Hash_Dedup** / W13).
 *
 * Schema (defined in {@link ../work-activity/derived-database.ts}):
 *
 *   CREATE TABLE embedding_hash_index (
 *     extracted_text_hash  TEXT PRIMARY KEY,
 *     embedding            BLOB NOT NULL,        -- Float32Array bytes
 *     inserted_at          TEXT NOT NULL DEFAULT (...)
 *   );
 *
 * The BLOB column stores the embedding as the raw byte representation
 * of a `Float32Array` (4 bytes per dimension). Float32 is the standard
 * precision used by mainstream embedding providers (OpenAI, Cohere,
 * Ollama nomic-embed-text, etc.); narrowing to f32 halves storage
 * versus f64 with no observable accuracy loss for cosine retrieval.
 *
 * Cascade_Delete intentionally does **not** touch this table (design
 * §5.2): the hash is a content-addressed cache. Even if every frame
 * referencing a particular hash is deleted, keeping the cached
 * embedding around is harmless — the vectorStore records that exposed
 * the hash to queries are removed by the regular cascade, so a deleted
 * frame's text cannot resurface in `find` results just because the
 * hash row remains.
 *
 * **Validates: Requirements 5.1**
 */

import type { DerivedDatabase } from './derived-database.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Lookup-and-insert facade for the `embedding_hash_index` table.
 *
 * Both methods are `Promise`-based for symmetry with the rest of the
 * work-activity adapters even though `node:sqlite` is synchronous —
 * the Embedding_Service composes the calls with provider HTTP calls
 * which are genuinely async, so a uniform shape simplifies the
 * caller.
 *
 *   - `lookup(hash)` returns the cached embedding as a freshly
 *     allocated `number[]`, or `null` when the hash has not been
 *     embedded yet.
 *   - `insert(hash, embedding)` stores the embedding under the hash.
 *     Implementations use `INSERT OR IGNORE` so concurrent inserts on
 *     the same hash from multiple frames are safe — collisions cannot
 *     produce a different embedding because the hash is content-
 *     addressed (same `extractedText` → same hash → same embedding).
 *     The first writer wins; subsequent attempts are silent no-ops.
 */
export interface HashIndex {
  lookup(hash: string): Promise<number[] | null>;
  insert(hash: string, embedding: number[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Concrete `HashIndex` backed by `node:sqlite` against the same
 * `derived.sqlite` database used by the rest of the work-activity
 * adapters.
 *
 * The class holds a reference to the `DerivedDatabase` instance —
 * lifecycle (open/close) is the caller's responsibility, matching the
 * convention used by {@link ../extraction/extracted-content-store.ts}.
 */
export class SqliteHashIndex implements HashIndex {
  constructor(private readonly db: DerivedDatabase) {}

  async lookup(hash: string): Promise<number[] | null> {
    const stmt = this.db.prepare(
      `SELECT embedding FROM embedding_hash_index WHERE extracted_text_hash = ?`
    );
    // `node:sqlite` returns BLOB columns as `Uint8Array`. The runtime
    // typings are loose (`SQLOutputValue`), so a narrow cast through
    // `unknown` keeps TypeScript happy without leaking the driver's
    // shape into our public API.
    const row = stmt.get(hash) as { embedding: Uint8Array } | undefined;
    if (row === undefined) return null;
    return blobToEmbedding(row.embedding);
  }

  async insert(hash: string, embedding: number[]): Promise<void> {
    // INSERT OR IGNORE: multiple frames may concurrently try to insert
    // the same hash (the upstream SHA256 dedup is a read-then-insert
    // pattern, not a single atomic upsert). When the hash is the
    // same, the embedding is by definition the same content — there
    // is nothing to overwrite, and the duplicate write is a benign
    // no-op rather than a uniqueness error.
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO embedding_hash_index (extracted_text_hash, embedding)
       VALUES (?, ?)`
    );
    stmt.run(hash, embeddingToBlob(embedding));
  }
}

// ---------------------------------------------------------------------------
// BLOB ↔ Float32Array conversion helpers
// ---------------------------------------------------------------------------

/**
 * Serialises `embedding` to its `Float32Array` byte representation.
 *
 * The returned `Uint8Array` is a *view* over a freshly-allocated
 * `ArrayBuffer` (because `new Float32Array(number[])` always allocates
 * its own buffer at offset 0). `node:sqlite`'s prepared-statement
 * binding accepts any `Uint8Array` for BLOB parameters, so we hand the
 * view directly without an extra copy.
 *
 * Float32 round-trip note: input `number[]` values are coerced to f32
 * by the `Float32Array` constructor. Embedding providers already
 * return f32-precision floats, so the coercion is a no-op for the
 * intended use case. Tests that round-trip arbitrary `number[]` MUST
 * pre-coerce via `Array.from(new Float32Array(...))` before comparing.
 */
function embeddingToBlob(embedding: number[]): Uint8Array {
  const float32 = new Float32Array(embedding);
  // Wrap the underlying ArrayBuffer in a Uint8Array view so the
  // `node:sqlite` driver sees a BLOB-bindable value. `byteOffset` is
  // always 0 for a freshly-constructed typed array, but pass it
  // explicitly to keep the contract obvious.
  return new Uint8Array(float32.buffer, float32.byteOffset, float32.byteLength);
}

/**
 * Deserialises a BLOB from `embedding_hash_index.embedding` back to a
 * plain `number[]`.
 *
 * The BLOB stores raw `Float32Array` bytes, so `byteLength` MUST be a
 * multiple of 4. If the underlying buffer is not 4-byte aligned (which
 * can happen when the driver hands back a `Uint8Array` over a pooled
 * buffer), copy the bytes into a fresh `ArrayBuffer` before viewing
 * them as `Float32Array` — `new Float32Array(buf, byteOffset, length)`
 * throws a `RangeError` on misaligned offsets.
 *
 * The result is built via `Array.from` so the caller receives an
 * independent `number[]` that does not alias the SQLite-owned buffer.
 */
function blobToEmbedding(blob: Uint8Array): number[] {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(
      `embedding_hash_index BLOB has length ${blob.byteLength} which is not a multiple of 4 (Float32Array requires 4 bytes per element)`
    );
  }
  const length = blob.byteLength / 4;

  // Fast path: the driver-owned buffer is already 4-byte aligned, so
  // we can construct a `Float32Array` view directly. `Array.from`
  // copies the values out, so the caller does not alias the BLOB.
  if (blob.byteOffset % 4 === 0) {
    const view = new Float32Array(blob.buffer, blob.byteOffset, length);
    return Array.from(view);
  }

  // Slow path: misaligned offset. Copy the bytes to a fresh, aligned
  // ArrayBuffer first. This branch is unlikely on `node:sqlite`'s
  // current behaviour but is cheap insurance against future driver
  // changes — and it keeps the failure mode "extra allocation"
  // rather than "RangeError".
  const aligned = new ArrayBuffer(blob.byteLength);
  new Uint8Array(aligned).set(blob);
  return Array.from(new Float32Array(aligned, 0, length));
}
