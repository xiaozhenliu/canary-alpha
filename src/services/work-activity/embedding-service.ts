/**
 * Embedding service for the work-activity-analysis pipeline.
 *
 * Task 5.2 (work-activity-analysis): the service sits between the
 * extraction layer and the vector store. For every per-frame
 * `ExtractionResult` the indexing pipeline produces, this service:
 *
 *   1. Skips the frame entirely when the extraction is empty
 *      (`Empty_Extraction`, R5.5 / **Empty_Skip** / W14).
 *   2. Looks the SHA256 hash of `extractedText` up in the
 *      `embedding_hash_index` cache, reusing the cached embedding
 *      when the same text was already embedded by a previous frame
 *      (R5.1 / **Hash_Dedup** / W13).
 *   3. Otherwise calls the configured `EmbeddingProvider`, persisting
 *      both the new embedding (in the hash cache) and a per-frame
 *      vector-store record so `Cascade_Delete` can later remove it
 *      by `frameId`.
 *   4. Treats provider failures as a soft, recoverable degradation —
 *      the indexer keeps running and downstream `find(mode='keyword')`
 *      remains intact (R5.6).
 *
 * Per design §5.1 the vector-store record id is `extracted:${frameId}`.
 * The hash is **not** used as the record id: two frames with the same
 * extracted text share an embedding vector but produce distinct
 * vector-store rows so `Cascade_Delete` can remove evidence by frame
 * without orphaning embeddings or accidentally evicting another frame's
 * row.
 *
 * **Validates: Requirements 5.1, 5.2, 5.5, 5.6**
 */

import { createHash } from 'node:crypto';

import { buildCaptureId } from '../capture/types.js';
import type {
  EmbeddingProvider,
  VectorStore,
  VectorStoreRecord
} from '../retrieval/types.js';
import type { ExtractionResult } from './extraction/types.js';
import type { HashIndex } from './hash-index.js';
import type { ProviderHealthRegistry } from './observability/provider-health-registry.js';
import type { Logger } from '../../types/app-config.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Outcome of `EmbeddingService.embedExtraction`. The discriminated
 * union mirrors the four execution branches in design §5.1 and lets
 * callers (the indexing service, observability) classify the run
 * without inspecting provider internals.
 *
 *   - `skipped-empty`: the extraction was an `Empty_Extraction`. The
 *     provider was not called and no vector-store row was written.
 *   - `reused-hash`: the SHA256 hash was already in the cache; the
 *     embedding was reused but a fresh per-frame row was upserted to
 *     the vector store so `Cascade_Delete` works on the new frame.
 *   - `embedded`: a brand-new embedding was generated and persisted to
 *     both the hash cache and the vector store.
 *   - `provider-unavailable`: the embedding provider threw. The
 *     wrapper carries the original error so callers can surface it via
 *     observability without coupling on a specific HTTP error type.
 */
export type EmbeddingOutcome =
  | { kind: 'skipped-empty' }
  | { kind: 'reused-hash'; embedding: number[] }
  | { kind: 'embedded'; embedding: number[] }
  | { kind: 'provider-unavailable'; error: unknown };

/**
 * Outcome of `EmbeddingService.computeEmbedding`. Mirrors
 * `EmbeddingOutcome` but omits any vector-store interaction — the
 * hash and embedding are returned so callers can decide whether and
 * where to persist them.
 *
 *   - `skipped-empty`: the extraction was an `Empty_Extraction`.
 *   - `reused-hash`: the SHA256 hash was already in the cache; the
 *     cached embedding and its hash are returned.
 *   - `computed`: a brand-new embedding was generated and persisted to
 *     the hash cache only (no vector-store write).
 *   - `provider-unavailable`: the embedding provider threw.
 */
export type ComputeEmbeddingOutcome =
  | { kind: 'skipped-empty' }
  | { kind: 'reused-hash'; embedding: number[]; extractedTextHash: string }
  | { kind: 'computed'; embedding: number[]; extractedTextHash: string }
  | { kind: 'provider-unavailable'; error: unknown };

/**
 * Public surface of the embedding service. The interface stays small
 * — `embedExtraction` is the only verb the indexing service calls per
 * frame. Pulling it out of the concrete class makes testing the
 * indexing wiring (task 6.x) easy: a stub can return any outcome
 * without re-implementing the SHA256 / hash-cache / vector-store
 * orchestration.
 */
export interface EmbeddingService {
  embedExtraction(e: ExtractionResult): Promise<EmbeddingOutcome>;
  computeEmbedding(e: ExtractionResult): Promise<ComputeEmbeddingOutcome>;
}

/**
 * Constructor dependencies for {@link DefaultEmbeddingService}. The
 * `now` injectable is reserved for future provider-health timestamps;
 * it is not consumed by the current implementation but is part of the
 * design contract (§5.1) so we keep it in the shape rather than break
 * the signature later.
 */
export interface EmbeddingServiceDependencies {
  embeddingProvider: EmbeddingProvider;
  vectorStore: VectorStore;
  hashIndex: HashIndex;
  now: () => Date;
  /** Provider name used to build the neutral captureId metadata field. */
  captureProviderName: string;
  providerHealth?: ProviderHealthRegistry;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Concrete `EmbeddingService`. The class is a thin orchestrator: it
 * has no state of its own beyond the injected collaborators and treats
 * `EmbeddingProvider`, `VectorStore` and `HashIndex` as the only side
 * effects. That keeps unit tests simple — every branch is exercised by
 * stubbing two or three methods.
 *
 * Concurrency note: when two frames carrying the **same** brand-new
 * extracted text race through `embedExtraction`, both can miss the
 * cache, both can call the provider, and both can call `insert`. The
 * `INSERT OR IGNORE` semantics in {@link SqliteHashIndex} make the
 * second insert a no-op (the hash is content-addressed; both
 * embeddings are equivalent for the same input). The vector store
 * upserts are keyed by `extracted:${frameId}`, so the two frames
 * produce two distinct rows as designed. This is the worst-case
 * scenario: one extra HTTP call. Eliminating it would require an
 * in-process lock keyed by hash — not worth the complexity given the
 * indexer processes frames serially within a single `runOnce()`.
 */
export class DefaultEmbeddingService implements EmbeddingService {
  constructor(private readonly deps: EmbeddingServiceDependencies) {}

  async embedExtraction(e: ExtractionResult): Promise<EmbeddingOutcome> {
    // Delegate the embedding computation to `computeEmbedding` and
    // then write the result to the vector store. This keeps the two
    // concerns (embedding vs. persistence) separated and avoids
    // duplicating the hash-dedup / provider-unavailable logic.
    const result = await this.computeEmbedding(e);
    switch (result.kind) {
      case 'skipped-empty':
        return { kind: 'skipped-empty' };
      case 'provider-unavailable':
        return { kind: 'provider-unavailable', error: result.error };
      case 'reused-hash':
      case 'computed': {
        // Both branches produce an embedding that must be upserted to
        // the vector store so Cascade_Delete can later remove the row
        // by frameId (R9). A write failure is treated as
        // provider-unavailable from the indexer's perspective —
        // identical to a fresh-embed provider failure (design §3).
        try {
          await this.deps.vectorStore.upsert([
            this.toRecord(e, result.extractedTextHash, result.embedding)
          ]);
        } catch (error) {
          return { kind: 'provider-unavailable', error };
        }
        return {
          kind: result.kind === 'reused-hash' ? 'reused-hash' : 'embedded',
          embedding: result.embedding
        };
      }
    }
  }

  async computeEmbedding(e: ExtractionResult): Promise<ComputeEmbeddingOutcome> {
    // Branch 1 — Empty_Extraction (R5.5 / W14).
    //
    // Empty-skip is decided **solely** by `extractedText === ''` —
    // the upstream `e.extractedTextHash` is a denormalisation cache
    // and the service is not allowed to trust it (a buggy or
    // stale-null hash on a non-empty text MUST still be embedded).
    // The hash is recomputed below so this single check is enough.
    if (e.extractedText === '') {
      return { kind: 'skipped-empty' };
    }

    // Re-compute SHA256 from the text rather than trusting the
    // upstream `e.extractedTextHash`. R5.1 names the *Embedding_Service*
    // as the authority for the hash — the field carried on
    // `ExtractionResult` is a denormalisation persisted to the
    // `extracted_content` table for SQL queries. Recomputing here
    // ensures the cache key always corresponds to the actual text we
    // would embed; a stale or buggy upstream hash cannot make us
    // serve the wrong cached vector.
    const extractedTextHash = computeExtractedTextHash(e.extractedText);

    // Branch 2 — Hash_Dedup (R5.1 / W13).
    //
    // Cache hit: a previous frame already paid the embedding cost for
    // this exact text. Return the cached vector and hash without
    // touching the vector store — callers decide whether to persist.
    //
    // Per design §3 "Embedding 层" error handling: `HashIndex.lookup`
    // failures are caught and treated as a miss (the hash cache is a
    // perf optimisation, not a correctness guarantee).
    let cached: number[] | null = null;
    try {
      cached = await this.deps.hashIndex.lookup(extractedTextHash);
    } catch {
      cached = null;
    }
    if (cached !== null) {
      return { kind: 'reused-hash', embedding: cached, extractedTextHash };
    }

    // Branch 3 — fresh embed.
    //
    // The provider call is the only step that can fail in a way the
    // indexer must observe (network / quota / process down). Wrap it
    // in try/catch and translate to `provider-unavailable` (R5.6) so
    // the caller can surface the failure via observability without
    // tearing down `runOnce()`. The hash cache write happens after
    // the provider succeeds, so a provider failure leaves the cache
    // untouched and the next frame retries cleanly.
    let embedding: number[];
    const startMs = performance.now();
    try {
      embedding = await this.deps.embeddingProvider.embed(e.extractedText);
      const latencyMs = Math.round(performance.now() - startMs);
      this.deps.providerHealth?.recordOk('embedding', latencyMs);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.deps.providerHealth?.recordFailure('embedding', errorMessage);
      return { kind: 'provider-unavailable', error };
    }

    // Per design §3: `HashIndex.insert` failures do not block the
    // pipeline — the next frame will simply re-embed (a perf
    // regression, not a correctness one). Swallow the error and
    // return the computed embedding so the caller can still persist it.
    try {
      await this.deps.hashIndex.insert(extractedTextHash, embedding);
    } catch {
      /* hash cache write best-effort — ignore */
    }

    return { kind: 'computed', embedding, extractedTextHash };
  }

  /**
   * Builds the per-frame `VectorStoreRecord`. The `id` is derived
   * from `frameId` (not from `extractedTextHash`) so distinct frames
   * sharing the same text still produce distinct rows — see the
   * design rationale in §5.1.
   *
   * Metadata mirrors the design contract for downstream consumers:
   *
   *   - `frameId` / `frameTimestamp`: Cascade_Delete keys.
   *   - `extractedTextHash`: lets observability count unique-text
   *     embeddings without re-hashing.
   *   - `appName` / `contextKey`: used by the find-tool's metadata
   *     filtering and by the ingestionMix observability. R5.2 names
   *     `appName` as required, so we coerce `undefined` to `''` —
   *     `JSON.stringify` would otherwise drop the key entirely on
   *     persistence (`FileBackedVectorStore` writes JSON), violating
   *     the contract for downstream consumers that read it back.
   *   - `sourceTypes`: kept on metadata so vector-store consumers
   *     that strip the top-level fields can still see capture
   *     provenance.
   *
   * The `extractedTextHash` argument is the service-recomputed hash
   * (see `embedExtraction`) — passing it explicitly avoids leaking
   * the recompute responsibility to a second site.
   */
  private toRecord(
    e: ExtractionResult,
    extractedTextHash: string,
    embedding: number[]
  ): VectorStoreRecord {
    return {
      id: `extracted:${e.frameId}`,
      text: e.extractedText,
      timestamp: e.frameTimestamp,
      // The top-level `appName` follows the upstream `CaptureRecord`
      // convention where the field is optional — leave it `undefined`
      // when the extraction did not have one. R5.2 names `appName` as
      // *metadata*-required, which is what the next block enforces.
      appName: e.appName,
      sourceTypes: e.sourceTypes,
      embedding,
      metadata: {
        sourceTypes: e.sourceTypes,
        // Legacy key: kept for one retention cycle so Cascade_Delete
        // still matches records written before the captureId migration.
        frameId: e.frameId,
        // Neutral key: the provider-namespaced identifier written from
        // this migration onward (Task 5 dual-write). Both keys are
        // matched by deleteByFrameIds during the transition window.
        captureId: buildCaptureId(this.deps.captureProviderName, {
          frameId: e.frameId,
          id: String(e.frameId)
        }),
        frameTimestamp: e.frameTimestamp,
        contextKey: e.contextKey,
        extractedTextHash,
        // R5.2: `appName` MUST be present in metadata. Coerce
        // `undefined` to '' so JSON-backed vector stores
        // (`FileBackedVectorStore`) round-trip the key — `JSON.stringify`
        // drops `undefined` valued keys, which would silently violate
        // the contract.
        appName: e.appName ?? ''
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for callers / tests)
// ---------------------------------------------------------------------------

/**
 * SHA256 helper used by both the extraction layer (when populating
 * `ExtractionResult.extractedTextHash`) and any caller that needs the
 * same hash convention. Centralising the helper keeps the algorithm
 * choice in one place — task 5.1's design contract names SHA256
 * explicitly, but if the constant ever changes (it shouldn't), a
 * single import-site change suffices.
 *
 * Empty input is a programming error in this context — callers MUST
 * skip empty `extractedText` before reaching the hash computation
 * (see the `Empty_Extraction` branch above). The helper does not
 * special-case it; passing `''` returns the SHA256 of the empty
 * string and a downstream embed call would still happen.
 */
export function computeExtractedTextHash(extractedText: string): string {
  return createHash('sha256').update(extractedText).digest('hex');
}
