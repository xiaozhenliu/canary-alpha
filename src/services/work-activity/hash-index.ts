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
import { blobToFloat32Array, float32ArrayToBlob } from '../../lib/blob.js';

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
    return blobToFloat32Array(row.embedding);
  }

  async insert(hash: string, embedding: number[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO embedding_hash_index (extracted_text_hash, embedding)
       VALUES (?, ?)`
    );
    stmt.run(hash, float32ArrayToBlob(embedding));
  }
}
