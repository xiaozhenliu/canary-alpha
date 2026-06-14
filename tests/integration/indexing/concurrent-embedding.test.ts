/**
 * Integration tests for the concurrent embedding pool added to
 * `DefaultIndexingService.runOnce()` (Phase 1 / Task 2).
 *
 * The tests wire a stripped-down but real production stack:
 *   - Real `createIndexingService` (no legacy shim)
 *   - Stub capture client with controlled records
 *   - In-memory checkpoint store
 *   - Recording vector store that tracks upsert calls
 *   - Custom `EmbeddingService` that wraps `computeEmbedding()` with
 *     artificial delays or failure injection so timing / correctness can
 *     be verified without a live embedding provider
 *
 * The session aggregator, extraction registry, and extracted-content store
 * use no-op stubs to keep the tests focused on the concurrent embedding path
 * rather than the upstream pipeline stages.
 *
 * **Validates**: concurrent embedding pool behaviour (sliding-window, batch
 * upsert, checkpoint advancement on partial failure, timing improvement
 * vs. serial baseline).
 */

import { describe, expect, it } from 'vitest';

import { createIndexingService } from '../../../src/services/retrieval/indexing-service.js';
import type {
  CheckpointStore,
  EmbeddingProvider,
  IndexedCheckpoint,
  ScreenpipeRecord,
  VectorStore,
  VectorStoreRecord,
  VectorSearchRequest,
  RetrievalEvidenceItem
} from '../../../src/services/retrieval/types.js';
import type {
  ExtractionInput,
  ExtractionRegistry,
  ExtractionResult
} from '../../../src/services/work-activity/extraction/types.js';
import type {
  ExtractedContentStore
} from '../../../src/services/work-activity/extraction/extracted-content-store.js';
import type {
  SessionAggregator,
  HandleExtractionResult,
  FlushIdleResult
} from '../../../src/services/work-activity/sessions/aggregator.js';
import type {
  EmbeddingService,
  EmbeddingOutcome,
  ComputeEmbeddingOutcome
} from '../../../src/services/work-activity/embedding-service.js';
import {
  buildContextKey,
  deriveContextLabel
} from '../../../src/services/work-activity/sessions/context-key.js';
import { hashStringToNumericId } from '../../../src/services/retrieval/indexing-service.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class InMemoryCheckpointStore implements CheckpointStore {
  private checkpoint: IndexedCheckpoint | null = null;

  async readLatest(): Promise<IndexedCheckpoint | null> {
    return this.checkpoint;
  }

  async writeLatest(checkpoint: IndexedCheckpoint): Promise<void> {
    this.checkpoint = checkpoint;
  }

  async reset(): Promise<void> {
    this.checkpoint = null;
  }
}

/**
 * Records all `upsert` call batches so tests can assert on how many
 * batches landed and what records each batch contained.
 */
class RecordingVectorStore implements VectorStore {
  readonly kind = 'recording';
  readonly upserts: VectorStoreRecord[][] = [];

  async upsert(records: VectorStoreRecord[]): Promise<void> {
    this.upserts.push([...records]);
  }

  async reset(): Promise<void> {
    this.upserts.length = 0;
  }

  async query(_: VectorSearchRequest): Promise<RetrievalEvidenceItem[]> {
    return [];
  }
}

/**
 * Simple capture client backed by a pre-built record list. Supports
 * both `recent()` and `search()` so both normal and backlog paths work.
 */
class StubCaptureClient {
  readonly kind = 'stub';
  recentCalls: number[] = [];

  constructor(private readonly records: ScreenpipeRecord[]) {}

  async recent(_minutes: number): Promise<ScreenpipeRecord[]> {
    this.recentCalls.push(_minutes);
    return [...this.records];
  }

  async search(_req: { from?: string; to?: string; limit?: number; offset?: number }): Promise<ScreenpipeRecord[]> {
    return [...this.records];
  }
}

/**
 * Passthrough extraction registry: maps each frame to an `ExtractionResult`
 * with `extractedText` set to the record's `text` field so
 * `computeEmbedding()` has a non-empty string to act on.
 */
class PassthroughExtractionRegistry implements ExtractionRegistry {
  extract(input: ExtractionInput): ExtractionResult {
    return {
      frameId: input.frameId,
      frameTimestamp: input.frameTimestamp,
      appName: input.appName,
      contextLabel: deriveContextLabel(input.windowTitle, input.appName),
      contextKey: buildContextKey(input.appName, input.windowTitle),
      extractedText: `text-for-frame-${input.frameId}`,
      extractedTextHash: null,
      extractionRuleKind: 'generic',
      sourceTypes: input.sourceTypes
    };
  }
}

class NoopExtractedContentStore implements ExtractedContentStore {
  async upsert(): Promise<void> { /* no-op */ }
  async getByFrameIds(): Promise<ExtractionResult[]> { return []; }
  async deleteByFrameIds(): Promise<number> { return 0; }
  async listByTimeWindow(): Promise<ExtractionResult[]> { return []; }
  async countByTimeWindow(): Promise<{ total: number; empty: number }> {
    return { total: 0, empty: 0 };
  }
  async findLastExtractedAt(): Promise<string | null> { return null; }
}

class NoopSessionAggregator implements SessionAggregator {
  async handleExtraction(e: ExtractionResult): Promise<HandleExtractionResult> {
    return { sessionId: `noop:${e.frameId}`, created: true };
  }
  async flushIdleOpenSessions(): Promise<FlushIdleResult> {
    return { closed: 0 };
  }
}

/**
 * Stub embedding provider for use with `DelayedEmbeddingService`.
 * Each `embed()` call resolves with a distinct deterministic vector.
 */
class StubEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'stub';

  async embed(input: string): Promise<number[]> {
    return [input.length, 0.1, 0.2];
  }
}

/**
 * Embedding service wrapper that adds an artificial delay to each
 * `computeEmbedding()` call. Used to verify that the sliding-window pool
 * actually overlaps I/O-bound work (total wall time < serial * n).
 *
 * `embedExtraction()` delegates to `computeEmbedding()` and then
 * upserts to the provided store so the blocked-records re-check path
 * still works.
 */
class DelayedEmbeddingService implements EmbeddingService {
  private readonly provider: StubEmbeddingProvider;

  constructor(
    private readonly delayMs: number,
    private readonly vectorStore: VectorStore,
    private readonly resolveOrFail?: (frameId: number) => 'ok' | 'fail'
  ) {
    this.provider = new StubEmbeddingProvider();
  }

  async computeEmbedding(e: ExtractionResult): Promise<ComputeEmbeddingOutcome> {
    if (e.extractedText === '') {
      return { kind: 'skipped-empty' };
    }

    // Simulate controlled failure for specific frames.
    if (this.resolveOrFail && this.resolveOrFail(e.frameId) === 'fail') {
      await delay(this.delayMs);
      return {
        kind: 'provider-unavailable',
        error: new Error(`simulated embedding failure for frame ${e.frameId}`)
      };
    }

    await delay(this.delayMs);
    const embedding = await this.provider.embed(e.extractedText);
    return { kind: 'computed', embedding, extractedTextHash: `hash:${e.frameId}` };
  }

  async embedExtraction(e: ExtractionResult): Promise<EmbeddingOutcome> {
    const result = await this.computeEmbedding(e);
    switch (result.kind) {
      case 'skipped-empty':
        return { kind: 'skipped-empty' };
      case 'provider-unavailable':
        return { kind: 'provider-unavailable', error: result.error };
      case 'reused-hash':
      case 'computed':
        await this.vectorStore.upsert([{
          id: `extracted:${e.frameId}`,
          text: e.extractedText,
          timestamp: e.frameTimestamp,
          sourceTypes: e.sourceTypes,
          embedding: result.embedding,
          metadata: { frameId: e.frameId, extractedTextHash: result.extractedTextHash }
        }]);
        return { kind: 'embedded', embedding: result.embedding };
    }
  }
}

/**
 * Always-failing embedding service. Every `computeEmbedding()` call
 * resolves to `provider-unavailable`.
 */
class AlwaysFailingEmbeddingService implements EmbeddingService {
  async computeEmbedding(e: ExtractionResult): Promise<ComputeEmbeddingOutcome> {
    if (e.extractedText === '') return { kind: 'skipped-empty' };
    return { kind: 'provider-unavailable', error: new Error('provider down') };
  }

  async embedExtraction(e: ExtractionResult): Promise<EmbeddingOutcome> {
    if (e.extractedText === '') return { kind: 'skipped-empty' };
    return { kind: 'provider-unavailable', error: new Error('provider down') };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Builds `n` synthetic capture records with sequential timestamps starting
 * from `baseMs`. Each record carries a unique `text` and `id`.
 */
function makeRecords(n: number, baseMs = 1_700_000_000_000): ScreenpipeRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `record-${i}`,
    text: `content for record ${i}`,
    timestamp: new Date(baseMs + i * 1_000).toISOString(),
    appName: 'TestApp',
    windowName: 'Test Window',
    frameId: i + 1,
    sourceTypes: ['ocr'] as string[]
  }));
}

/** Shared deps factory. Callers override individual fields as needed. */
function makeDeps(overrides: {
  records?: ScreenpipeRecord[];
  vectorStore?: VectorStore;
  embeddingService?: EmbeddingService;
  embeddingConcurrency?: number;
  checkpointStore?: CheckpointStore;
}) {
  const records = overrides.records ?? makeRecords(5);
  const vectorStore = overrides.vectorStore ?? new RecordingVectorStore();
  const embeddingService = overrides.embeddingService
    ?? new DelayedEmbeddingService(0, vectorStore);

  return {
    captureClient: new StubCaptureClient(records),
    vectorStore,
    checkpointStore: overrides.checkpointStore ?? new InMemoryCheckpointStore(),
    embeddingProvider: new StubEmbeddingProvider(),
    freshnessWindowMinutes: 60,
    maxCatchUpBatches: 10,
    maxCatchUpRecords: 100,
    extractionRegistry: new PassthroughExtractionRegistry(),
    extractedContentStore: new NoopExtractedContentStore(),
    sessionAggregator: new NoopSessionAggregator(),
    embeddingService,
    embeddingConcurrency: overrides.embeddingConcurrency ?? 3,
    captureProviderName: 'screenpipe' as const
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('concurrent embedding pool', () => {
  it('processes multiple records with concurrency > 1 and indexes all of them', async () => {
    const n = 10;
    const perRecordDelayMs = 40;
    const vectorStore = new RecordingVectorStore();
    const embeddingService = new DelayedEmbeddingService(perRecordDelayMs, vectorStore);

    const deps = makeDeps({
      records: makeRecords(n),
      vectorStore,
      embeddingService,
      embeddingConcurrency: 3
    });

    const service = createIndexingService(deps);
    const now = new Date(Date.now() + 60 * 60_000);
    const start = Date.now();
    const result = await service.runOnce(now);
    const elapsed = Date.now() - start;

    // All records should be indexed.
    expect(result.indexed).toBe(n);

    // One batch upsert for the entire run.
    expect(vectorStore.upserts.length).toBe(1);
    expect(vectorStore.upserts[0]).toHaveLength(n);

    // Wall time should be much less than serial time (n * perRecordDelayMs).
    // With concurrency=3 and 10 records we expect ~4 rounds of 40ms ≈ 160ms,
    // well below the serial 400ms. Use a generous bound (serial * 0.8).
    const serialTimeMs = n * perRecordDelayMs;
    expect(elapsed).toBeLessThan(serialTimeMs * 0.85);
  });

  it('advances checkpoint to the newest successful record when some records fail', async () => {
    // 5 records at T1..T5. Record at index 2 (T3) will fail embedding.
    // Checkpoint should advance to T5 (the newest successful record).
    const baseMs = 1_700_000_000_000;
    const records = makeRecords(5, baseMs);

    const vectorStore = new RecordingVectorStore();
    // Record with frameId=3 (index 2) fails.
    const embeddingService = new DelayedEmbeddingService(0, vectorStore, (frameId) =>
      frameId === 3 ? 'fail' : 'ok'
    );

    const checkpointStore = new InMemoryCheckpointStore();
    const deps = makeDeps({
      records,
      vectorStore,
      embeddingService,
      checkpointStore,
      embeddingConcurrency: 2
    });

    const service = createIndexingService(deps);
    const now = new Date(baseMs + 10 * 1_000);

    await service.runOnce(now);

    // Checkpoint should be at the last record (frameId=5, index=4) because
    // records T4 and T5 succeeded — the checkpoint advances past the failure.
    const checkpoint = await checkpointStore.readLatest();
    expect(checkpoint).not.toBeNull();
    // The timestamp of record index 4 (T5, frameId=5)
    const expectedTs = new Date(baseMs + 4 * 1_000).toISOString();
    expect(checkpoint!.timestamp).toBe(expectedTs);
    // 4 records succeed (all except frameId=3)
    expect(vectorStore.upserts[0]).toHaveLength(4);
  });

  it('batches vector-store upsert into a single call per runOnce()', async () => {
    const n = 5;
    const vectorStore = new RecordingVectorStore();
    const embeddingService = new DelayedEmbeddingService(0, vectorStore);

    const deps = makeDeps({
      records: makeRecords(n),
      vectorStore,
      embeddingService,
      embeddingConcurrency: 3
    });

    const service = createIndexingService(deps);
    const now = new Date(Date.now() + 60 * 60_000);
    await service.runOnce(now);

    // Exactly one batch upsert call, regardless of concurrency.
    expect(vectorStore.upserts.length).toBe(1);
    expect(vectorStore.upserts[0]).toHaveLength(n);
  });

  it('produces correct output with concurrency=1 (serial fallback)', async () => {
    const n = 4;
    const vectorStore = new RecordingVectorStore();
    const embeddingService = new DelayedEmbeddingService(0, vectorStore);

    const deps = makeDeps({
      records: makeRecords(n),
      vectorStore,
      embeddingService,
      embeddingConcurrency: 1
    });

    const service = createIndexingService(deps);
    const now = new Date(Date.now() + 60 * 60_000);
    const result = await service.runOnce(now);

    expect(result.indexed).toBe(n);
    expect(vectorStore.upserts.length).toBe(1);
    expect(vectorStore.upserts[0]).toHaveLength(n);
  });

  it('throws when all records fail and no records were indexed', async () => {
    const n = 3;
    const vectorStore = new RecordingVectorStore();

    const deps = makeDeps({
      records: makeRecords(n),
      vectorStore,
      embeddingService: new AlwaysFailingEmbeddingService(),
      embeddingConcurrency: 2
    });

    const service = createIndexingService(deps);
    const now = new Date(Date.now() + 60 * 60_000);

    await expect(service.runOnce(now)).rejects.toThrow();

    // No successful embeddings so nothing was upserted.
    expect(vectorStore.upserts.length).toBe(0);
  });

  it('records have correct vector-store id format (extracted:<frameId>)', async () => {
    const records = makeRecords(3);
    const vectorStore = new RecordingVectorStore();
    const embeddingService = new DelayedEmbeddingService(0, vectorStore);

    const deps = makeDeps({
      records,
      vectorStore,
      embeddingService,
      embeddingConcurrency: 3
    });

    const service = createIndexingService(deps);
    const now = new Date(Date.now() + 60 * 60_000);
    await service.runOnce(now);

    const ids = vectorStore.upserts[0]?.map((r) => r.id).sort();
    // frameIds are 1-based (makeRecords sets frameId = i + 1)
    expect(ids).toEqual(['extracted:1', 'extracted:2', 'extracted:3']);
  });

  it('resets all indexed outcomes when batch vector-store upsert fails', async () => {
    const n = 4;
    let upsertCallCount = 0;
    const failingVectorStore: VectorStore = {
      kind: 'failing',
      async upsert(): Promise<void> {
        upsertCallCount += 1;
        throw new Error('disk full');
      },
      async reset(): Promise<void> { /* no-op */ },
      async query(): Promise<RetrievalEvidenceItem[]> { return []; }
    };

    const embeddingService = new DelayedEmbeddingService(0, failingVectorStore);
    const checkpointStore = new InMemoryCheckpointStore();

    const deps = makeDeps({
      records: makeRecords(n),
      vectorStore: failingVectorStore,
      embeddingService,
      checkpointStore,
      embeddingConcurrency: 2
    });

    const service = createIndexingService(deps);
    const now = new Date(Date.now() + 60 * 60_000);

    await expect(service.runOnce(now)).rejects.toThrow('disk full');

    // The batch upsert was attempted exactly once.
    expect(upsertCallCount).toBe(1);

    // Checkpoint should not have advanced (all outcomes were reset).
    const checkpoint = await checkpointStore.readLatest();
    expect(checkpoint).toBeNull();
  });

  it('handles records without frameId via FNV-1a hash fallback', async () => {
    // Records with no explicit frameId — the indexing service falls back to
    // `hashStringToNumericId(record.id)` when computing the extraction input.
    const records: ScreenpipeRecord[] = [
      { id: 'no-frame-a', text: 'alpha', timestamp: new Date(1_700_000_001_000).toISOString(), sourceTypes: ['ocr'] },
      { id: 'no-frame-b', text: 'beta', timestamp: new Date(1_700_000_002_000).toISOString(), sourceTypes: ['ocr'] }
    ];

    const vectorStore = new RecordingVectorStore();
    const embeddingService = new DelayedEmbeddingService(0, vectorStore);

    const deps = makeDeps({
      records,
      vectorStore,
      embeddingService,
      embeddingConcurrency: 2
    });

    const service = createIndexingService(deps);
    const now = new Date(1_700_000_010_000);
    const result = await service.runOnce(now);

    expect(result.indexed).toBe(2);

    const ids = vectorStore.upserts[0]?.map((r) => r.id).sort();
    const expectedA = `extracted:${hashStringToNumericId('no-frame-a')}`;
    const expectedB = `extracted:${hashStringToNumericId('no-frame-b')}`;
    expect(ids).toEqual([expectedA, expectedB].sort());
  });
});
