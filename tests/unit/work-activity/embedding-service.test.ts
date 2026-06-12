/**
 * Unit tests for `DefaultEmbeddingService` (work-activity-analysis
 * task 5.2).
 *
 * The service composes three collaborators (an `EmbeddingProvider`,
 * a `VectorStore`, a `HashIndex`) and dispatches between four
 * `EmbeddingOutcome` branches. The tests exercise every branch and
 * the two correctness properties pulled from design §14:
 *
 *   - **Empty_Skip** (W14, R5.5): empty `extractedText` MUST short-
 *     circuit before the provider / vector store / hash index are
 *     touched.
 *   - **Hash_Dedup** (W13, R5.1): N consecutive frames whose
 *     `extractedText` is byte-identical MUST trigger exactly one
 *     `embeddingProvider.embed` call (the rest reuse the cached
 *     embedding).
 *   - Provider failure (R5.6): a thrown provider MUST yield
 *     `provider-unavailable` without bubbling the error to the
 *     caller, and MUST NOT mutate the hash cache or vector store.
 *
 * Where useful the tests also verify the per-frame metadata written
 * to the vector store row — design §5.1 names the exact keys
 * (`frameId`, `frameTimestamp`, `extractedTextHash`, `appName`,
 * `contextKey`, `sourceTypes`) so downstream Cascade_Delete and
 * find-tool metadata filters work.
 *
 * **Validates: Requirements 5.1, 5.2, 5.5, 5.6**
 */

import { createHash } from 'node:crypto';

import * as fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DefaultEmbeddingService,
  computeExtractedTextHash,
  type EmbeddingOutcome
} from '../../../src/services/work-activity/embedding-service.js';
import type {
  EmbeddingProvider,
  VectorStore,
  VectorStoreRecord
} from '../../../src/services/retrieval/types.js';
import type { ExtractionResult } from '../../../src/services/work-activity/extraction/types.js';
import type { HashIndex } from '../../../src/services/work-activity/hash-index.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * In-memory `HashIndex` stub. Mirrors the `INSERT OR IGNORE`
 * semantics of the SQLite-backed implementation: a duplicate insert
 * for the same hash is a no-op (the cached value wins).
 */
class StubHashIndex implements HashIndex {
  readonly store = new Map<string, number[]>();
  readonly lookups: string[] = [];
  readonly inserts: Array<{ hash: string; embedding: number[] }> = [];

  async lookup(hash: string): Promise<number[] | null> {
    this.lookups.push(hash);
    const cached = this.store.get(hash);
    return cached ? [...cached] : null;
  }

  async insert(hash: string, embedding: number[]): Promise<void> {
    this.inserts.push({ hash, embedding: [...embedding] });
    if (!this.store.has(hash)) {
      this.store.set(hash, [...embedding]);
    }
  }
}

/**
 * Minimal `VectorStore` stub used to assert what the embedding
 * service writes. Only `upsert` is exercised — every other method
 * throws so an accidental call surfaces as a clear failure rather
 * than a silent mismatch.
 */
class StubVectorStore implements VectorStore {
  readonly kind = 'stub';
  readonly records: VectorStoreRecord[] = [];

  async upsert(records: VectorStoreRecord[]): Promise<void> {
    // Mirror `InMemoryVectorStore.upsert` semantics: existing rows
    // with the same id are replaced. The service writes `extracted:${frameId}`
    // ids so the same frame upserted twice updates in place.
    const incoming = new Map(records.map((record) => [record.id, record]));
    const retained = this.records.filter((record) => !incoming.has(record.id));
    this.records.splice(0, this.records.length, ...retained, ...records);
  }

  async reset(): Promise<void> {
    this.records.splice(0, this.records.length);
  }

  async query(): Promise<never> {
    throw new Error('query is not part of the embedding service contract');
  }
}

/**
 * Embedding provider stub whose `embed` is a `vi.fn`. Each call
 * returns a deterministic vector derived from the input length so
 * tests can assert on the cached value without arbitrary fixtures.
 */
function buildProvider(): EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(async (input: string) => {
    return [input.length, input.length / 10, input.length / 100];
  });
  return {
    kind: 'stub',
    embed
  } as EmbeddingProvider & { embed: typeof embed };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal `ExtractionResult` for `extractedText`. The hash
 * is computed via the same SHA256 helper the service uses so tests
 * reflect the production contract instead of duplicating the algorithm
 * locally.
 */
function buildExtraction(
  overrides: Partial<ExtractionResult> & { extractedText: string }
): ExtractionResult {
  const extractedText = overrides.extractedText;
  // `??` would coalesce a deliberately-passed `null`/`undefined` to
  // the default, masking branches under test that need to exercise
  // those exact values. Honour an explicit override (including
  // `null`/`undefined`) by checking the key presence instead.
  const has = (key: keyof ExtractionResult) =>
    Object.prototype.hasOwnProperty.call(overrides, key);

  const extractedTextHash = has('extractedTextHash')
    ? (overrides.extractedTextHash ?? null)
    : extractedText === ''
      ? null
      : computeExtractedTextHash(extractedText);
  const appName = has('appName') ? overrides.appName : 'Code';
  return {
    frameId: overrides.frameId ?? 1,
    frameTimestamp: overrides.frameTimestamp ?? '2026-05-25T10:00:00.000Z',
    appName,
    contextLabel: overrides.contextLabel ?? 'main.ts',
    contextKey: overrides.contextKey ?? 'Code::main.ts',
    extractedText,
    extractedTextHash,
    extractionRuleKind: overrides.extractionRuleKind ?? 'generic',
    sourceTypes: overrides.sourceTypes ?? ['accessibility']
  };
}

// ---------------------------------------------------------------------------
// Per-test fixture
// ---------------------------------------------------------------------------

let provider: ReturnType<typeof buildProvider>;
let vectorStore: StubVectorStore;
let hashIndex: StubHashIndex;
let service: DefaultEmbeddingService;

beforeEach(() => {
  provider = buildProvider();
  vectorStore = new StubVectorStore();
  hashIndex = new StubHashIndex();
  service = new DefaultEmbeddingService({
    embeddingProvider: provider,
    vectorStore,
    hashIndex,
    now: () => new Date('2026-05-25T10:00:00.000Z'),
    captureProviderName: 'screenpipe'
  });
});

// ---------------------------------------------------------------------------
// Helper hash exactness check
// ---------------------------------------------------------------------------

describe('computeExtractedTextHash', () => {
  it('matches node:crypto SHA256 hex of the raw string (R5.1)', () => {
    const input = 'hello world';
    expect(computeExtractedTextHash(input)).toBe(
      createHash('sha256').update(input).digest('hex')
    );
  });
});

// ---------------------------------------------------------------------------
// Empty_Skip (W14 / R5.5)
// ---------------------------------------------------------------------------

describe('DefaultEmbeddingService.embedExtraction — Empty_Skip (W14)', () => {
  it('returns skipped-empty for an Empty_Extraction without touching collaborators', async () => {
    const empty = buildExtraction({
      extractedText: '',
      // The contract says hash MUST be null when text is empty, but
      // we set it explicitly so the assertion stands on its own.
      extractedTextHash: null
    });

    const outcome = await service.embedExtraction(empty);

    expect(outcome).toEqual<EmbeddingOutcome>({ kind: 'skipped-empty' });
    expect(provider.embed).not.toHaveBeenCalled();
    expect(hashIndex.lookups).toEqual([]);
    expect(hashIndex.inserts).toEqual([]);
    expect(vectorStore.records).toEqual([]);
  });

  it('ignores a stale null hash and still embeds when extractedText is non-empty (R5.5)', async () => {
    // The service is the authority for `extractedTextHash`. If an
    // upstream extraction registry drift produces a record with
    // `extractedText = 'x'` but `extractedTextHash = null`, the
    // service MUST recompute and embed — `Empty_Skip` is gated on
    // the *text* being empty, not on the cached hash being null.
    const oddRecord = buildExtraction({ extractedText: 'x', extractedTextHash: null });
    const outcome = await service.embedExtraction(oddRecord);

    expect(outcome.kind).toBe('embedded');
    expect(provider.embed).toHaveBeenCalledWith('x');
    // The hash written to the cache is the freshly-computed one,
    // not the stale null upstream value.
    const expected = computeExtractedTextHash('x');
    expect(hashIndex.inserts).toHaveLength(1);
    expect(hashIndex.inserts[0].hash).toBe(expected);
    expect(vectorStore.records[0].metadata?.extractedTextHash).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Hash_Dedup (W13 / R5.1)
// ---------------------------------------------------------------------------

describe('DefaultEmbeddingService.embedExtraction — Hash_Dedup (W13)', () => {
  it('embeds once and reuses the cached embedding for repeated text', async () => {
    const a = buildExtraction({ frameId: 1, extractedText: 'shared body' });
    const b = buildExtraction({ frameId: 2, extractedText: 'shared body' });

    const first = await service.embedExtraction(a);
    const second = await service.embedExtraction(b);

    expect(first.kind).toBe('embedded');
    expect(second.kind).toBe('reused-hash');
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(hashIndex.inserts).toHaveLength(1);

    // The reused embedding MUST be byte-equal to the freshly embedded
    // one (the cache is content-addressed).
    if (first.kind === 'embedded' && second.kind === 'reused-hash') {
      expect(second.embedding).toEqual(first.embedding);
    }
  });

  it('persists distinct vector-store rows per frame even when sharing a hash', async () => {
    // Cascade_Delete (R9) deletes by `frameId`, so each frame MUST
    // own its own vector-store row. Reusing the embedding does not
    // mean reusing the row.
    const a = buildExtraction({ frameId: 1, extractedText: 'shared body' });
    const b = buildExtraction({ frameId: 2, extractedText: 'shared body' });
    const c = buildExtraction({ frameId: 3, extractedText: 'shared body' });

    await service.embedExtraction(a);
    await service.embedExtraction(b);
    await service.embedExtraction(c);

    expect(vectorStore.records).toHaveLength(3);
    expect(vectorStore.records.map((r) => r.id).sort()).toEqual([
      'extracted:1',
      'extracted:2',
      'extracted:3'
    ]);
    // Embeddings are identical across the three rows.
    const [v1, v2, v3] = vectorStore.records.map((r) => r.embedding);
    expect(v2).toEqual(v1);
    expect(v3).toEqual(v1);
  });

  it('property: N frames sharing a hash trigger exactly 1 provider call (PBT for W13)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        async (n, body) => {
          // Reset state per-property-iteration. We rebuild the
          // service so the cache and call counter start fresh; the
          // vitest `beforeEach` only runs once per `it`.
          const localProvider = buildProvider();
          const localVectorStore = new StubVectorStore();
          const localHashIndex = new StubHashIndex();
          const localService = new DefaultEmbeddingService({
            embeddingProvider: localProvider,
            vectorStore: localVectorStore,
            hashIndex: localHashIndex,
            now: () => new Date('2026-05-25T10:00:00.000Z'),
            captureProviderName: 'screenpipe'
          });

          for (let i = 0; i < n; i++) {
            await localService.embedExtraction(
              buildExtraction({ frameId: i + 1, extractedText: body })
            );
          }

          // Hash_Dedup: the provider was called for the *first*
          // frame only; the remaining N-1 frames went through the
          // cache.
          expect(localProvider.embed).toHaveBeenCalledTimes(1);
          // Each frame MUST own a vector-store row.
          expect(localVectorStore.records).toHaveLength(n);
        }
      ),
      { numRuns: 25 }
    );
  });
});

// ---------------------------------------------------------------------------
// Fresh embed branch
// ---------------------------------------------------------------------------

describe('DefaultEmbeddingService.embedExtraction — fresh embed', () => {
  it('returns embedded and persists hash + vector row for new text', async () => {
    const result = buildExtraction({ frameId: 42, extractedText: 'a fresh body' });

    const outcome = await service.embedExtraction(result);

    expect(outcome.kind).toBe('embedded');
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(provider.embed).toHaveBeenCalledWith('a fresh body');
    expect(hashIndex.inserts).toHaveLength(1);
    expect(hashIndex.inserts[0].hash).toBe(computeExtractedTextHash('a fresh body'));
    expect(vectorStore.records).toHaveLength(1);
    expect(vectorStore.records[0].id).toBe('extracted:42');
  });

  it('recomputes SHA256 internally and ignores any stale value on the input record (R5.1)', async () => {
    // Defence-in-depth: the upstream `ExtractionResult.extractedTextHash`
    // is a denormalised cache. The service is the authority for the
    // hash — passing a deliberately wrong value MUST NOT cause the
    // wrong embedding to be cached or served.
    const stale = buildExtraction({
      frameId: 51,
      extractedText: 'real text',
      // Force a stale hash that does not match the real text.
      extractedTextHash: 'deadbeef'.repeat(8)
    });

    await service.embedExtraction(stale);

    const expected = computeExtractedTextHash('real text');
    expect(hashIndex.inserts).toHaveLength(1);
    expect(hashIndex.inserts[0].hash).toBe(expected);
    expect(vectorStore.records[0].metadata?.extractedTextHash).toBe(expected);

    // A second frame carrying the *correct* hash for the same text
    // must hit the cache (proves the first store really used the
    // recomputed hash).
    const sibling = buildExtraction({ frameId: 52, extractedText: 'real text' });
    const second = await service.embedExtraction(sibling);
    expect(second.kind).toBe('reused-hash');
    expect(provider.embed).toHaveBeenCalledTimes(1);
  });

  it('writes the design §5.1 metadata payload on the vector-store row (R5.2)', async () => {
    const result = buildExtraction({
      frameId: 7,
      extractedText: 'metadata check',
      appName: 'Cursor',
      contextKey: 'Cursor::main.ts',
      contextLabel: 'main.ts',
      sourceTypes: ['accessibility', 'ocr'],
      frameTimestamp: '2026-05-25T11:30:00.000Z'
    });

    await service.embedExtraction(result);

    const [row] = vectorStore.records;
    expect(row).toBeDefined();
    expect(row.text).toBe('metadata check');
    expect(row.appName).toBe('Cursor');
    expect(row.timestamp).toBe('2026-05-25T11:30:00.000Z');
    expect(row.sourceTypes).toEqual(['accessibility', 'ocr']);
    expect(row.embedding).toEqual(await provider.embed('metadata check'));
    expect(row.metadata).toMatchObject({
      frameId: 7,
      frameTimestamp: '2026-05-25T11:30:00.000Z',
      contextKey: 'Cursor::main.ts',
      extractedTextHash: computeExtractedTextHash('metadata check'),
      appName: 'Cursor',
      sourceTypes: ['accessibility', 'ocr']
    });
  });

  it('dual-writes metadata.captureId and keeps legacy metadata.frameId (Task 5)', async () => {
    // After the captureId migration, each new vector-store record MUST
    // carry BOTH the legacy `frameId` key (for backward-compat Cascade_Delete
    // during the retention window) AND the neutral `captureId` key.
    const result = buildExtraction({ frameId: 42, extractedText: 'dual-write check' });

    await service.embedExtraction(result);

    const [row] = vectorStore.records;
    expect(row).toBeDefined();
    expect(row.metadata?.frameId).toBe(42);
    expect(row.metadata?.captureId).toBe('screenpipe:frame:42');
  });

  it('coerces metadata.appName to "" when the extraction has no appName so JSON-backed stores keep the key (R5.2)', async () => {
    // `FileBackedVectorStore` persists records via `JSON.stringify`,
    // which drops keys whose value is `undefined`. R5.2 names
    // `appName` as required metadata, so the service writes `''` as
    // a placeholder rather than letting the key disappear silently.
    const result = buildExtraction({
      frameId: 5,
      extractedText: 'no app',
      appName: undefined
    });

    await service.embedExtraction(result);

    const [row] = vectorStore.records;
    expect(row.metadata).toBeDefined();
    expect(row.metadata!.appName).toBe('');
    // Round-trip through JSON to mimic the file-backed store: the
    // key MUST still be present after serialisation.
    const reparsed = JSON.parse(JSON.stringify(row));
    expect(Object.prototype.hasOwnProperty.call(reparsed.metadata, 'appName')).toBe(true);
    expect(reparsed.metadata.appName).toBe('');
  });
});

// ---------------------------------------------------------------------------
// provider-unavailable (R5.6)
// ---------------------------------------------------------------------------

describe('DefaultEmbeddingService.embedExtraction — provider-unavailable (R5.6)', () => {
  it('translates a thrown provider into provider-unavailable without raising', async () => {
    const thrown = new Error('connection refused');
    provider.embed.mockRejectedValueOnce(thrown);
    const e = buildExtraction({ frameId: 11, extractedText: 'body that will fail' });

    const outcome = await service.embedExtraction(e);

    expect(outcome.kind).toBe('provider-unavailable');
    if (outcome.kind === 'provider-unavailable') {
      expect(outcome.error).toBe(thrown);
    }
    // The provider was attempted, but the cache and vector store
    // were left untouched so a subsequent retry can succeed cleanly.
    // Asserting the persistent cache state (`store`) — not just the
    // write-call log — guards against an implementation that
    // accidentally inserts before checking the provider succeeded.
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(hashIndex.inserts).toEqual([]);
    expect(hashIndex.store.size).toBe(0);
    expect(vectorStore.records).toEqual([]);
  });

  it('does not fall back to keyword: a retry after recovery still embeds the same text', async () => {
    provider.embed.mockRejectedValueOnce(new Error('temporarily down'));
    const e = buildExtraction({ frameId: 99, extractedText: 'retry me' });

    const first = await service.embedExtraction(e);
    expect(first.kind).toBe('provider-unavailable');

    // Provider recovers — second attempt embeds normally.
    const second = await service.embedExtraction(e);
    expect(second.kind).toBe('embedded');
    expect(provider.embed).toHaveBeenCalledTimes(2);
    expect(hashIndex.inserts).toHaveLength(1);
    expect(vectorStore.records).toHaveLength(1);
  });

  it('treats a non-Error throwable (e.g. a string) as a provider-unavailable error payload', async () => {
    // Some HTTP libraries reject with non-Error values; the service
    // must not crash trying to read `.message` off of them.
    provider.embed.mockRejectedValueOnce('boom');
    const e = buildExtraction({ frameId: 1, extractedText: 'odd error' });

    const outcome = await service.embedExtraction(e);
    expect(outcome.kind).toBe('provider-unavailable');
    if (outcome.kind === 'provider-unavailable') {
      expect(outcome.error).toBe('boom');
    }
  });
});

// ---------------------------------------------------------------------------
// Collaborator failure modes (design §3 "Embedding 层")
// ---------------------------------------------------------------------------

describe('DefaultEmbeddingService.embedExtraction — collaborator failures', () => {
  it('treats hashIndex.lookup throw as a cache miss and proceeds to embed', async () => {
    // Per design §3 "Embedding 层": `HashIndex.lookup` failure MUST
    // be caught and treated as "hash not found" — the cache is a
    // perf optimisation, not a correctness requirement, and a
    // failing lookup MUST NOT block indexing.
    hashIndex.lookup = vi.fn(async () => {
      throw new Error('sqlite locked');
    }) as unknown as HashIndex['lookup'];

    const e = buildExtraction({ frameId: 21, extractedText: 'lookup fails' });
    const outcome = await service.embedExtraction(e);

    expect(outcome.kind).toBe('embedded');
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(vectorStore.records).toHaveLength(1);
  });

  it('does not block indexing when hashIndex.insert throws (vector row still written)', async () => {
    // Per design §3: `HashIndex.insert` failure is best-effort. The
    // vector store MUST still receive the row so the embedding is
    // queryable; the next frame with the same text will simply
    // re-embed (perf regression, not correctness).
    hashIndex.insert = vi.fn(async () => {
      throw new Error('disk full');
    }) as unknown as HashIndex['insert'];

    const e = buildExtraction({ frameId: 22, extractedText: 'insert fails' });
    const outcome = await service.embedExtraction(e);

    expect(outcome.kind).toBe('embedded');
    expect(vectorStore.records).toHaveLength(1);
    expect(vectorStore.records[0].id).toBe('extracted:22');
  });

  it('maps vectorStore.upsert throw to provider-unavailable on the fresh-embed path', async () => {
    // Per design §3: `vectorStore.upsert` failure is treated like a
    // provider failure from the indexer's perspective — the
    // embedding may have been generated, but it is not queryable, so
    // the partial-failure book-keeping in the indexer should treat
    // it identically to a provider-down event.
    const writeError = new Error('vector store write failed');
    vectorStore.upsert = vi.fn(async () => {
      throw writeError;
    }) as unknown as VectorStore['upsert'];

    const e = buildExtraction({ frameId: 23, extractedText: 'upsert fails' });
    const outcome = await service.embedExtraction(e);

    expect(outcome.kind).toBe('provider-unavailable');
    if (outcome.kind === 'provider-unavailable') {
      expect(outcome.error).toBe(writeError);
    }
  });

  it('maps vectorStore.upsert throw to provider-unavailable on the reused-hash path', async () => {
    // Pre-seed the cache so the second call takes the reused-hash
    // branch; then sabotage `upsert` to verify both branches share
    // the same error contract.
    const seed = buildExtraction({ frameId: 30, extractedText: 'shared' });
    await service.embedExtraction(seed);
    expect(vectorStore.records).toHaveLength(1);

    const writeError = new Error('write failed on reuse');
    vectorStore.upsert = vi.fn(async () => {
      throw writeError;
    }) as unknown as VectorStore['upsert'];

    const sibling = buildExtraction({ frameId: 31, extractedText: 'shared' });
    const outcome = await service.embedExtraction(sibling);

    expect(outcome.kind).toBe('provider-unavailable');
    if (outcome.kind === 'provider-unavailable') {
      expect(outcome.error).toBe(writeError);
    }
    // The reused-hash branch did not call the provider.
    expect(provider.embed).toHaveBeenCalledTimes(1);
  });
});
