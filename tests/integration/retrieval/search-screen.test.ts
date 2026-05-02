import { describe, expect, it, vi } from 'vitest';

import type { PrivacyState, PrivacyStateReader } from '../../../src/services/privacy/types.js';
import { createFreshnessPolicy } from '../../../src/services/retrieval/freshness-policy.js';
import { createSearchScreenService } from '../../../src/services/retrieval/search-screen-service.js';
import type {
  CheckpointStore,
  EmbeddingProvider,
  IndexedCheckpoint,
  ScreenpipeClient,
  ScreenpipeRecord,
  ScreenpipeSearchRequest,
  VectorSearchRequest,
  VectorStore
} from '../../../src/services/retrieval/types.js';


class StubEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'stub';
  readonly baseUrl = 'http://stub.local';
  readonly model = 'stub-model';

  async embed(_input: string): Promise<number[]> {
    return [0.1, 0.2, 0.3];
  }
}

class RecordingEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'recording-stub';
  readonly baseUrl = 'http://stub.local';
  readonly model = 'stub-model';
  readonly inputs: string[] = [];

  async embed(input: string): Promise<number[]> {
    this.inputs.push(input);
    return [0.1, 0.2, 0.3];
  }
}

class ThrowingEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'throwing-stub';
  readonly baseUrl = 'http://stub.local';
  readonly model = 'stub-model';

  async embed(): Promise<number[]> {
    throw new Error('embedding unavailable');
  }
}

class StubCheckpointStore implements CheckpointStore {
  constructor(private readonly checkpoint: IndexedCheckpoint | null = {
    cursor: 'checkpoint-1',
    timestamp: new Date(Date.now() - 10 * 60_000).toISOString()
  }) {}

  async readLatest() {
    return this.checkpoint;
  }

  async writeLatest(): Promise<void> {}

  async reset(): Promise<void> {}
}

class StubPrivacyStateReader implements PrivacyStateReader {
  constructor(private readonly state: PrivacyState = { paused: false, excludedApps: [] }) {}

  async read(): Promise<PrivacyState> {
    return this.state;
  }
}

class MutablePrivacyStateReader implements PrivacyStateReader {
  private readCount = 0;

  constructor(private readonly states: PrivacyState[]) {}

  async read(): Promise<PrivacyState> {
    const index = Math.min(this.readCount, this.states.length - 1);
    const state = this.states[index] ?? { paused: false, excludedApps: [] };
    this.readCount += 1;
    return state;
  }
}

class SequencePrivacyStateReader implements PrivacyStateReader {
  private readCount = 0;

  constructor(private readonly steps: Array<PrivacyState | Error>) {}

  async read(): Promise<PrivacyState> {
    const index = Math.min(this.readCount, this.steps.length - 1);
    const step = this.steps[index] ?? { paused: false, excludedApps: [] };
    this.readCount += 1;

    if (step instanceof Error) {
      throw step;
    }

    return step;
  }
}

class ThrowingPrivacyStateReader implements PrivacyStateReader {
  async read(): Promise<PrivacyState> {
    throw new Error('privacy state unavailable');
  }
}

class StubScreenpipeClient implements ScreenpipeClient {
  readonly searchCalls: ScreenpipeSearchRequest[] = [];

  constructor(private readonly records: ScreenpipeRecord[]) {}

  async search(request: ScreenpipeSearchRequest): Promise<ScreenpipeRecord[]> {
    this.searchCalls.push(request);
    const limit = request.limit ?? this.records.length;
    const offset = request.offset ?? 0;

    return this.records
      .filter((record) => {
        const matchesQuery = request.query
          ? record.text.toLowerCase().includes(request.query.toLowerCase())
          : true;
        const matchesApp = request.appName ? record.appName === request.appName : true;
        const matchesFrom = request.from ? record.timestamp >= request.from : true;
        const matchesTo = request.to ? record.timestamp <= request.to : true;
        return matchesQuery && matchesApp && matchesFrom && matchesTo;
      })
      .slice(offset, offset + limit);
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    return this.records;
  }
}

class StubPartialFailureScreenpipeClient implements ScreenpipeClient {
  readonly searchCalls: ScreenpipeSearchRequest[] = [];

  constructor(
    private readonly firstPage: ScreenpipeRecord[],
    private readonly failureMessage = 'screenpipe page failed'
  ) {}

  async search(request: ScreenpipeSearchRequest): Promise<ScreenpipeRecord[]> {
    this.searchCalls.push(request);
    if ((request.offset ?? 0) === 0) {
      return this.firstPage;
    }

    throw new Error(this.failureMessage);
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    return this.firstPage;
  }
}


class StubPrivacyAwareScreenpipeClient implements ScreenpipeClient {
  readonly searchCalls: ScreenpipeSearchRequest[] = [];

  constructor(private readonly pages: ScreenpipeRecord[][]) {}

  async search(request: ScreenpipeSearchRequest): Promise<ScreenpipeRecord[]> {
    this.searchCalls.push(request);
    const pageIndex = Math.floor((request.offset ?? 0) / (request.limit ?? 10));
    return this.pages[pageIndex] ?? [];
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    return this.pages.flat();
  }
}

class InsertingTimeBoundScreenpipeClient implements ScreenpipeClient {
  readonly searchCalls: ScreenpipeSearchRequest[] = [];

  constructor(
    private readonly firstPage: ScreenpipeRecord[],
    private readonly insertedPage: ScreenpipeRecord[],
    private readonly stableSecondPage: ScreenpipeRecord[]
  ) {}

  async search(request: ScreenpipeSearchRequest): Promise<ScreenpipeRecord[]> {
    this.searchCalls.push(request);

    if ((request.offset ?? 0) === 0) {
      return this.firstPage;
    }

    if (!request.to) {
      return this.insertedPage;
    }

    return this.stableSecondPage;
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    return [...this.firstPage, ...this.stableSecondPage];
  }
}

class OffsetRestartingScreenpipeClient implements ScreenpipeClient {
  readonly searchCalls: ScreenpipeSearchRequest[] = [];

  constructor(
    private readonly firstPage: ScreenpipeRecord[],
    private readonly offsetInsertedPage: ScreenpipeRecord[],
    private readonly stableSecondPage: ScreenpipeRecord[]
  ) {}

  async search(request: ScreenpipeSearchRequest): Promise<ScreenpipeRecord[]> {
    this.searchCalls.push(request);

    if ((request.offset ?? 0) === 0) {
      return this.firstPage;
    }

    if (!request.to) {
      return this.offsetInsertedPage;
    }

    return this.stableSecondPage;
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    return [...this.firstPage, ...this.stableSecondPage];
  }
}

class FutureBoundedBackfillScreenpipeClient implements ScreenpipeClient {
  readonly searchCalls: ScreenpipeSearchRequest[] = [];

  constructor(
    private readonly firstPage: ScreenpipeRecord[],
    private readonly boundedSecondPage: ScreenpipeRecord[],
    private readonly unboundedSecondPage: ScreenpipeRecord[]
  ) {}

  async search(request: ScreenpipeSearchRequest): Promise<ScreenpipeRecord[]> {
    this.searchCalls.push(request);

    if ((request.offset ?? 0) === 0 && !request.to) {
      return this.firstPage;
    }

    return request.to ? this.boundedSecondPage : this.unboundedSecondPage;
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    return [...this.firstPage, ...this.unboundedSecondPage];
  }
}

class MultiPageFallbackOffsetScreenpipeClient implements ScreenpipeClient {
  readonly searchCalls: ScreenpipeSearchRequest[] = [];

  constructor(
    private readonly firstPage: ScreenpipeRecord[],
    private readonly boundedPages: ScreenpipeRecord[][],
    private readonly fallbackPages: Map<number, ScreenpipeRecord[]>
  ) {}

  async search(request: ScreenpipeSearchRequest): Promise<ScreenpipeRecord[]> {
    this.searchCalls.push(request);

    if ((request.offset ?? 0) === 0) {
      return this.firstPage;
    }

    if (request.to) {
      const pageSize = request.limit ?? 10;
      const pageIndex = Math.floor(((request.offset ?? 0) - 8) / pageSize);
      return this.boundedPages[pageIndex] ?? [];
    }

    return this.fallbackPages.get(request.offset ?? 0) ?? [];
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    return [this.firstPage, ...this.boundedPages, ...this.fallbackPages.values()].flat();
  }
}

class SnapshotVectorStore implements VectorStore {
  readonly kind = 'snapshot-vector';
  readonly queryCalls: VectorSearchRequest[] = [];
  readonly querySnapshotCalls: VectorSearchRequest[] = [];

  constructor(
    private readonly snapshotRecords: Array<{ id: string; text: string; timestamp: string; appName?: string; score?: number }>,
    private readonly liveRecords: Array<{ id: string; text: string; timestamp: string; appName?: string; score?: number }>
  ) {}

  async upsert(): Promise<void> {}

  async reset(): Promise<void> {}

  async query(request: VectorSearchRequest) {
    this.queryCalls.push(request);
    const limit = request.limit ?? this.liveRecords.length;
    const offset = request.offset ?? 0;

    return this.liveRecords.slice(offset, offset + limit).map((record) => ({
      id: record.id,
      text: record.text,
      timestamp: record.timestamp,
      appName: record.appName,
      score: record.score,
      source: 'semantic' as const
    }));
  }

  async querySnapshot(request: VectorSearchRequest) {
    this.querySnapshotCalls.push(request);
    const limit = request.limit ?? this.snapshotRecords.length;
    const offset = request.offset ?? 0;

    return this.snapshotRecords.slice(offset, offset + limit).map((record) => ({
      id: record.id,
      text: record.text,
      timestamp: record.timestamp,
      appName: record.appName,
      score: record.score,
      source: 'semantic' as const
    }));
  }
}


class StubPrivacyAwareVectorStore implements VectorStore {
  readonly kind = 'privacy-aware-vector';
  readonly queryCalls: VectorSearchRequest[] = [];

  constructor(private readonly pages: Array<Array<{ id: string; text: string; timestamp: string; appName?: string; score?: number }>>) {}

  async upsert(): Promise<void> {}

  async reset(): Promise<void> {}

  async query(request: VectorSearchRequest) {
    this.queryCalls.push(request);
    const limit = request.limit ?? this.pages.flat().length;
    const offset = request.offset ?? 0;

    return this.pages
      .flat()
      .slice(offset, offset + limit)
      .map((record) => ({
        id: record.id,
        text: record.text,
        timestamp: record.timestamp,
        appName: record.appName,
        score: record.score,
        source: 'semantic' as const
      }));
  }
}

class StubHybridBackfillScreenpipeClient implements ScreenpipeClient {
  readonly searchCalls: ScreenpipeSearchRequest[] = [];

  constructor(
    private readonly firstPage: ScreenpipeRecord[],
    private readonly laterPages: ScreenpipeRecord[][],
    private readonly failingOffsets: Set<number> = new Set()
  ) {}

  async search(request: ScreenpipeSearchRequest): Promise<ScreenpipeRecord[]> {
    this.searchCalls.push(request);
    const offset = request.offset ?? 0;
    if (this.failingOffsets.has(offset)) {
      throw new Error(`screenpipe page failed at offset ${offset}`);
    }

    if (offset === 0) {
      return this.firstPage;
    }

    const pageIndex = Math.floor(offset / (request.limit ?? 10)) - 1;
    return this.laterPages[pageIndex] ?? [];
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    return [this.firstPage, ...this.laterPages].flat();
  }
}

class StubHybridBackfillVectorStore implements VectorStore {
  readonly kind = 'stub-hybrid-backfill-vector';
  readonly queryCalls: VectorSearchRequest[] = [];

  constructor(
    private readonly firstPage: Array<{ id: string; text: string; timestamp: string; appName?: string; score?: number }>,
    private readonly laterPages: Array<Array<{ id: string; text: string; timestamp: string; appName?: string; score?: number }>>,
    private readonly failingOffsets: Set<number> = new Set()
  ) {}

  async upsert(): Promise<void> {}

  async reset(): Promise<void> {}

  async query(request: VectorSearchRequest) {
    this.queryCalls.push(request);
    const offset = request.offset ?? 0;
    if (this.failingOffsets.has(offset)) {
      throw new Error(`vector page failed at offset ${offset}`);
    }

    const limit = request.limit ?? this.firstPage.length;
    return [this.firstPage, ...this.laterPages]
      .flat()
      .slice(offset, offset + limit)
      .map((record) => ({
        id: record.id,
        text: record.text,
        timestamp: record.timestamp,
        appName: record.appName,
        score: record.score,
        source: 'semantic' as const
      }));
  }
}


class ThrowingScreenpipeClient implements ScreenpipeClient {
  async search(): Promise<never> {
    throw new Error('screenpipe search should not run while paused');
  }

  async recent(): Promise<never> {
    throw new Error('screenpipe recent should not run while paused');
  }
}

class StubVectorStore implements VectorStore {
  readonly kind = 'stub-vector';
  readonly queryCalls: VectorSearchRequest[] = [];

  constructor(private readonly records: Array<{ id: string; text: string; timestamp: string; appName?: string; score?: number }>) {}

  async upsert(): Promise<void> {}

  async reset(): Promise<void> {}

  async query(request: VectorSearchRequest) {
    this.queryCalls.push(request);
    const limit = request.limit ?? this.records.length;
    const offset = request.offset ?? 0;

    return this.records
      .filter((record) => {
        const matchesApp = request.appName ? record.appName === request.appName : true;
        const matchesFrom = request.from ? record.timestamp >= request.from : true;
        const matchesTo = request.to ? record.timestamp <= request.to : true;
        return matchesApp && matchesFrom && matchesTo;
      })
      .map((record) => ({
        id: record.id,
        text: record.text,
        timestamp: record.timestamp,
        appName: record.appName,
        score: record.score,
        source: 'semantic' as const
      }))
      .slice(offset, offset + limit);
  }
}

class ThrowingVectorStore implements VectorStore {
  readonly kind = 'throwing-vector';

  async upsert(): Promise<void> {}

  async reset(): Promise<void> {}

  async query(): Promise<never> {
    throw new Error('vector lookup should not run while paused');
  }
}

describe('search screen service', () => {
  const keywordRecords: ScreenpipeRecord[] = [
    {
      id: 'keyword-1',
      text: 'Claude code review notes for lifecapture',
      timestamp: '2026-04-13T11:10:00.000Z',
      appName: 'Claude'
    },
    {
      id: 'keyword-2',
      text: 'Screenpipe indexing dashboard status',
      timestamp: '2026-04-13T11:20:00.000Z',
      appName: 'Screenpipe'
    }
  ];

  const semanticRecords = [
    {
      id: 'semantic-1',
      text: 'Hybrid retrieval architecture sketch',
      timestamp: '2026-04-13T11:12:00.000Z',
      appName: 'Notes',
      score: 0.91
    },
    {
      id: 'keyword-1',
      text: 'Claude code review notes for lifecapture',
      timestamp: '2026-04-13T11:10:00.000Z',
      appName: 'Claude',
      score: 0.87
    }
  ];

  const service = createSearchScreenService({
    embeddingProvider: new StubEmbeddingProvider(),
    screenpipeClient: new StubScreenpipeClient(keywordRecords),
    vectorStore: new StubVectorStore(semanticRecords),
    checkpointStore: new StubCheckpointStore(),
    freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 })
  });

  it('returns keyword results for keyword mode and app filter', async () => {
    const result = await service.search({
      query: 'claude',
      mode: 'keyword',
      appName: 'Claude'
    });

    expect(result.summary).toContain('claude');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.source).toBe('keyword');
    expect(result.evidence[0]?.appName).toBe('Claude');
    expect(result.freshness?.status).toBe('fresh');
  });

  it('returns semantic results for semantic mode and time filters', async () => {
    const result = await service.search({
      query: 'retrieval',
      mode: 'semantic',
      from: '2026-04-13T11:11:00.000Z',
      to: '2026-04-13T11:13:00.000Z'
    });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.source).toBe('semantic');
    expect(result.evidence[0]?.id).toBe('semantic-1');
  });

  it('fuses keyword and semantic results for hybrid mode with ranking hints', async () => {
    const result = await service.search({
      query: 'review',
      mode: 'hybrid'
    });

    expect(result.evidence.length).toBeGreaterThanOrEqual(2);
    expect(result.evidence.some((item) => item.source === 'hybrid')).toBe(true);
    expect(result.evidence.every((item) => item.source === 'keyword' || item.source === 'semantic' || item.source === 'hybrid')).toBe(true);
    expect(result.evidence.some((item) => typeof item.score === 'number')).toBe(true);
  });

  it('filters excluded apps from keyword and semantic results', async () => {
    const filteredService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient(keywordRecords),
      vectorStore: new StubVectorStore(semanticRecords),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['Claude']
      })
    });

    const result = await filteredService.search({
      query: 'review',
      mode: 'hybrid'
    });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.id).toBe('semantic-1');
    expect(result.evidence.every((item) => item.appName !== 'Claude')).toBe(true);
  });

  it('filters excluded apps case-insensitively from keyword and semantic results', async () => {
    const filteredService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient(keywordRecords),
      vectorStore: new StubVectorStore(semanticRecords),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['claude']
      })
    });

    const result = await filteredService.search({
      query: 'review',
      mode: 'hybrid'
    });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.id).toBe('semantic-1');
    expect(result.evidence.every((item) => item.appName !== 'Claude')).toBe(true);
  });


  it('filters records captured inside suppressed privacy windows after resume', async () => {
    const suppressedService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'keyword-suppressed',
          text: 'review note hidden by pause window',
          timestamp: '2026-04-13T11:58:00.000Z',
          appName: 'Notes'
        },
        {
          id: 'keyword-visible',
          text: 'review note visible after resume',
          timestamp: '2026-04-13T12:06:00.000Z',
          appName: 'Terminal'
        }
      ]),
      vectorStore: new StubVectorStore([
        {
          id: 'semantic-suppressed',
          text: 'semantic hidden by pause window',
          timestamp: '2026-04-13T11:59:00.000Z',
          appName: 'Notes',
          score: 0.95
        },
        {
          id: 'semantic-visible',
          text: 'semantic visible after resume',
          timestamp: '2026-04-13T12:06:00.000Z',
          appName: 'Terminal',
          score: 0.94
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: [],
        suppressedRanges: [
          {
            from: '2026-04-13T11:55:00.000Z',
            to: '2026-04-13T12:05:00.000Z'
          }
        ]
      })
    });

    const result = await suppressedService.search({
      query: 'review',
      mode: 'hybrid'
    });

    expect(result.evidence.some((item) => item.id === 'keyword-suppressed')).toBe(false);
    expect(result.evidence.some((item) => item.id === 'semantic-suppressed')).toBe(false);
    expect(result.evidence.some((item) => item.id === 'keyword-visible' || item.id === 'semantic-visible')).toBe(true);
  });

  it('filters suppressed records when provider timestamps use timezone offsets', async () => {
    const offsetSuppressedService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'keyword-offset-suppressed',
          text: 'review note hidden by offset pause window',
          timestamp: '2026-04-13T20:00:00+08:00',
          appName: 'Notes'
        },
        {
          id: 'keyword-offset-visible',
          text: 'review note visible after offset resume',
          timestamp: '2026-04-13T20:06:00+08:00',
          appName: 'Terminal'
        }
      ]),
      vectorStore: new StubVectorStore([
        {
          id: 'semantic-offset-suppressed',
          text: 'semantic hidden by offset pause window',
          timestamp: '2026-04-13T20:00:00+08:00',
          appName: 'Notes',
          score: 0.95
        },
        {
          id: 'semantic-offset-visible',
          text: 'semantic visible after offset resume',
          timestamp: '2026-04-13T20:06:00+08:00',
          appName: 'Terminal',
          score: 0.94
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: [],
        suppressedRanges: [
          {
            from: '2026-04-13T11:55:00.000Z',
            to: '2026-04-13T12:05:00.000Z'
          }
        ]
      })
    });

    const result = await offsetSuppressedService.search({
      query: 'review',
      mode: 'hybrid'
    });

    expect(result.evidence.some((item) => item.id === 'keyword-offset-suppressed')).toBe(false);
    expect(result.evidence.some((item) => item.id === 'semantic-offset-suppressed')).toBe(false);
    expect(result.evidence.some((item) => item.id === 'keyword-offset-visible' || item.id === 'semantic-offset-visible')).toBe(true);
  });

  it('applies newly excluded apps before returning search results', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'keyword-visible',
          text: 'review note visible',
          timestamp: '2026-04-13T12:06:00.000Z',
          appName: 'Notes'
        },
        {
          id: 'keyword-late-excluded',
          text: 'review note excluded later',
          timestamp: '2026-04-13T12:07:00.000Z',
          appName: 'Terminal'
        }
      ]),
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['terminal'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['keyword-visible']);
    expect(result.evidence.every((item) => item.appName !== 'Terminal')).toBe(true);
  });

  it('hides only records captured during an active pause before search returns', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'keyword-before-pause',
          text: 'review note before pause',
          timestamp: '2026-04-13T11:50:00.000Z',
          appName: 'Notes'
        },
        {
          id: 'keyword-during-pause',
          text: 'review note during pause',
          timestamp: '2026-04-13T11:57:00.000Z',
          appName: 'Claude'
        }
      ]),
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: true, excludedApps: [], pauseStartedAt: '2026-04-13T11:55:00.000Z' }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['keyword-before-pause']);
    expect(result.error).toBeUndefined();
  });


  it('does not hide all search history for legacy paused states without pauseStartedAt', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'legacy-paused-visible',
          text: 'review legacy paused visible',
          timestamp: '2026-04-13T11:50:00.000Z',
          appName: 'Notes'
        }
      ]),
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: true, excludedApps: [] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['legacy-paused-visible']);
    expect(result.error).toBeUndefined();
  });


  it('still embeds semantic queries while paused and filters the active pause window', async () => {
    const embeddingProvider = new RecordingEmbeddingProvider();
    const service = createSearchScreenService({
      embeddingProvider,
      screenpipeClient: new StubScreenpipeClient([]),
      vectorStore: new StubVectorStore([
        {
          id: 'semantic-before-pause',
          text: 'review semantic before pause',
          timestamp: '2026-04-13T11:50:00.000Z',
          appName: 'Notes',
          score: 0.9
        },
        {
          id: 'semantic-during-pause',
          text: 'review semantic during pause',
          timestamp: '2026-04-13T11:57:00.000Z',
          appName: 'Claude',
          score: 0.8
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: true, excludedApps: [], pauseStartedAt: '2026-04-13T11:55:00.000Z' }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'semantic'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['semantic-before-pause']);
    expect(result.error).toBeUndefined();
    expect(embeddingProvider.inputs).toEqual(['review']);
  });


  it('re-checks privacy before embedding hybrid queries after keyword paging and preserves pre-pause history', async () => {
    const embeddingProvider = new RecordingEmbeddingProvider();
    const screenpipeClient = new StubPrivacyAwareScreenpipeClient([
      [
        {
          id: 'keyword-before-pause',
          text: 'review note before pause',
          timestamp: '2026-04-13T11:50:00.000Z',
          appName: 'Notes'
        },
        {
          id: 'keyword-during-pause',
          text: 'review note during pause',
          timestamp: '2026-04-13T11:57:00.000Z',
          appName: 'Claude'
        }
      ]
    ]);
    const service = createSearchScreenService({
      embeddingProvider,
      screenpipeClient,
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: true, excludedApps: [], pauseStartedAt: '2026-04-13T11:55:00.000Z' },
        { paused: true, excludedApps: [], pauseStartedAt: '2026-04-13T11:55:00.000Z' }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'hybrid'
    });

    expect(result.evidence.map((item) => item.id)).toContain('keyword-before-pause');
    expect(result.evidence.map((item) => item.id)).not.toContain('keyword-during-pause');
    expect(result.error).toBeUndefined();
    expect(embeddingProvider.inputs).toEqual(['review']);
  });


  it('re-reads privacy between keyword pages while search is in flight', async () => {
    const hiddenFirstPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-hidden-${index + 1}`,
      text: `review note ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Claude'
    }));
    const screenpipeClient = new StubPrivacyAwareScreenpipeClient([
      hiddenFirstPage,
      [
        {
          id: 'keyword-hidden-later',
          text: 'review note later page',
          timestamp: '2026-04-13T12:07:00.000Z',
          appName: 'Terminal'
        }
      ]
    ]);
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['Claude'] },
        { paused: false, excludedApps: ['Claude', 'Terminal'] },
        { paused: false, excludedApps: ['Claude', 'Terminal'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence).toEqual([]);
    expect(screenpipeClient.searchCalls).toHaveLength(2);
  });

  it('stops paging when privacy becomes less restrictive before requesting another keyword page', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-restore-visible-${index + 1}`,
      text: `review note visible ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
      appName: index < 5 ? 'Claude' : 'Terminal'
    }));
    const screenpipeClient = new StubPartialFailureScreenpipeClient(firstPage);
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: ['Claude'] },
        { paused: false, excludedApps: [] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `keyword-restore-visible-${index + 1}`)
    );
    expect(result.degraded).toBeUndefined();
    expect(screenpipeClient.searchCalls).toHaveLength(1);
  });

  it('applies latest privacy to keyword fallback results when embeddings fail', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new ThrowingEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'keyword-visible',
          text: 'review note visible',
          timestamp: '2026-04-13T12:06:00.000Z',
          appName: 'Notes'
        },
        {
          id: 'keyword-fallback-excluded',
          text: 'review note excluded on fallback',
          timestamp: '2026-04-13T12:07:00.000Z',
          appName: 'Terminal'
        }
      ]),
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['terminal'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'semantic'
    });

    expect(result.summary).toContain('using keyword search');
    expect(result.evidence.map((item) => item.id)).toEqual(['keyword-visible']);
    expect(result.degraded).toEqual({
      reason: 'Embedding provider failed; returned keyword-backed results instead.',
      fallbackMode: 'keyword'
    });
  });


  it('captures an implicit upper time bound before keyword paging and backfill', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-hidden-${index + 1}`,
      text: `review hidden keyword ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Notes'
    }));
    const secondPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-visible-${index + 1}`,
      text: `review visible keyword ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index + 10).padStart(2, '0')}:00.000Z`,
      appName: 'Terminal'
    }));
    const insertedPage = [
      {
        id: 'keyword-drifted',
        text: 'review drifted keyword',
        timestamp: '2026-04-13T12:30:00.000Z',
        appName: 'Drift'
      },
      ...secondPage.slice(0, 9)
    ];
    const screenpipeClient = new InsertingTimeBoundScreenpipeClient(firstPage, insertedPage, secondPage);
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['Notes'] },
        { paused: false, excludedApps: ['Notes'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `keyword-visible-${index + 1}`)
    );
    expect(screenpipeClient.searchCalls).toHaveLength(2);
    expect(screenpipeClient.searchCalls[0]).toMatchObject({ offset: 0, to: undefined });
    expect(screenpipeClient.searchCalls[1]).toMatchObject({ offset: 10 });
    expect(screenpipeClient.searchCalls[1]?.to).toBeTruthy();
  });


  it('compares implicit restart bounds by instant for offset timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:30:00.000Z'));

    try {
      const firstPage = [
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `keyword-notes-${index + 1}`,
          text: `review notes ${index + 1}`,
          timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
          appName: 'Notes'
        })),
        {
          id: 'keyword-offset-visible',
          text: 'review terminal offset visible',
          timestamp: '2026-04-13T19:59:00+08:00',
          appName: 'Terminal'
        }
      ];
      const stableSecondPage = Array.from({ length: 10 }, (_, index) => ({
        id: `keyword-terminal-${index + 1}`,
        text: `review terminal ${index + 1}`,
        timestamp: `2026-04-13T12:${String(index).padStart(2, '0')}:00.000Z`,
        appName: 'Terminal'
      }));
      const screenpipeClient = new OffsetRestartingScreenpipeClient(
        firstPage,
        stableSecondPage,
        stableSecondPage
      );
      const service = createSearchScreenService({
        embeddingProvider: new StubEmbeddingProvider(),
        screenpipeClient,
        vectorStore: new StubVectorStore([]),
        checkpointStore: new StubCheckpointStore(),
        freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
        privacyState: new MutablePrivacyStateReader([
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: ['Notes'] },
          { paused: false, excludedApps: ['Notes'] }
        ])
      });

      const result = await service.search({
        query: 'review',
        mode: 'keyword'
      });

      expect(result.evidence).toHaveLength(10);
      expect(result.evidence.map((item) => item.id)).toContain('keyword-offset-visible');
      expect(screenpipeClient.searchCalls).toHaveLength(2);
      expect(screenpipeClient.searchCalls[1]).toMatchObject({ offset: 10 });
      expect(screenpipeClient.searchCalls[1]?.to).toBe('2026-04-13T12:30:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses an explicit upper time bound across keyword paging and backfill', async () => {
    const upperBound = '2026-04-13T11:30:00.000Z';
    const firstPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-hidden-${index + 1}`,
      text: `review hidden keyword ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Notes'
    }));
    const secondPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-visible-${index + 1}`,
      text: `review visible keyword ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index + 10).padStart(2, '0')}:00.000Z`,
      appName: 'Terminal'
    }));
    const insertedPage = [
      {
        id: 'keyword-drifted',
        text: 'review drifted keyword',
        timestamp: '2026-04-13T12:30:00.000Z',
        appName: 'Drift'
      },
      ...secondPage.slice(0, 9)
    ];
    const screenpipeClient = new InsertingTimeBoundScreenpipeClient(firstPage, insertedPage, secondPage);
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['Notes'] },
        { paused: false, excludedApps: ['Notes'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'keyword',
      to: upperBound
    });

    expect(result.evidence.map((item) => item.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `keyword-visible-${index + 1}`)
    );
    expect(screenpipeClient.searchCalls).toHaveLength(2);
    expect(screenpipeClient.searchCalls[0]?.to).toBe(upperBound);
    expect(screenpipeClient.searchCalls[1]?.to).toBe(upperBound);
  });


  it('restarts keyword backfill from the bounded first page when future hits were only in the implicit first batch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:30:00.000Z'));

    try {
      const records: ScreenpipeRecord[] = [
        {
          id: 'future-1',
          text: 'review future 1',
          timestamp: '2026-04-13T12:31:00.000Z',
          appName: 'Future'
        },
        {
          id: 'future-2',
          text: 'review future 2',
          timestamp: '2026-04-13T12:32:00.000Z',
          appName: 'Future'
        },
        {
          id: 'hidden-1',
          text: 'review hidden 1',
          timestamp: '2026-04-13T12:20:00.000Z',
          appName: 'Hidden'
        },
        {
          id: 'hidden-2',
          text: 'review hidden 2',
          timestamp: '2026-04-13T12:19:00.000Z',
          appName: 'Hidden'
        },
        {
          id: 'visible-1',
          text: 'review visible 1',
          timestamp: '2026-04-13T12:18:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'visible-2',
          text: 'review visible 2',
          timestamp: '2026-04-13T12:17:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'visible-3',
          text: 'review visible 3',
          timestamp: '2026-04-13T12:16:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'visible-4',
          text: 'review visible 4',
          timestamp: '2026-04-13T12:15:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'visible-5',
          text: 'review visible 5',
          timestamp: '2026-04-13T12:14:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'visible-6',
          text: 'review visible 6',
          timestamp: '2026-04-13T12:13:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'replacement-1',
          text: 'review replacement 1',
          timestamp: '2026-04-13T12:12:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'replacement-2',
          text: 'review replacement 2',
          timestamp: '2026-04-13T12:11:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'replacement-3',
          text: 'review replacement 3',
          timestamp: '2026-04-13T12:10:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'replacement-4',
          text: 'review replacement 4',
          timestamp: '2026-04-13T12:09:00.000Z',
          appName: 'Visible'
        }
      ];
      const screenpipeClient = new StubScreenpipeClient(records);
      const service = createSearchScreenService({
        embeddingProvider: new StubEmbeddingProvider(),
        screenpipeClient,
        vectorStore: new StubVectorStore([]),
        checkpointStore: new StubCheckpointStore({
          cursor: 'checkpoint-1',
          timestamp: '2026-04-13T12:20:00.000Z'
        }),
        freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
        privacyState: new MutablePrivacyStateReader([
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: ['Future', 'Hidden'] },
          { paused: false, excludedApps: ['Future', 'Hidden'] },
          { paused: false, excludedApps: ['Future', 'Hidden'] }
        ])
      });

      const result = await service.search({
        query: 'review',
        mode: 'keyword'
      });

      expect(result.evidence.map((item) => item.id)).toEqual([
        'visible-1',
        'visible-2',
        'visible-3',
        'visible-4',
        'visible-5',
        'visible-6',
        'replacement-1',
        'replacement-2',
        'replacement-3',
        'replacement-4'
      ]);
      expect(screenpipeClient.searchCalls).toHaveLength(2);
      expect(screenpipeClient.searchCalls[0]).toMatchObject({ offset: 0, to: undefined });
      expect(screenpipeClient.searchCalls[1]).toMatchObject({ offset: 8, to: '2026-04-13T12:30:00.000Z' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes implicit keyword fallback from the matching unbounded offset after bounded paging', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:30:00.000Z'));

    try {
      const firstPage = [
        {
          id: 'future-1',
          text: 'review future 1',
          timestamp: '2026-04-13T12:31:00.000Z',
          appName: 'Future'
        },
        {
          id: 'future-2',
          text: 'review future 2',
          timestamp: '2026-04-13T12:32:00.000Z',
          appName: 'Future'
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `hidden-${index + 1}`,
          text: `review hidden ${index + 1}`,
          timestamp: `2026-04-13T12:${String(20 - index).padStart(2, '0')}:00.000Z`,
          appName: 'Hidden'
        }))
      ];
      const boundedPages = [
        Array.from({ length: 10 }, (_, index) => ({
          id: `hidden-bounded-${index + 9}`,
          text: `review hidden bounded ${index + 9}`,
          timestamp: `2026-04-13T12:${String(12 - index).padStart(2, '0')}:00.000Z`,
          appName: 'Hidden'
        })),
        Array.from({ length: 10 }, (_, index) => ({
          id: `hidden-bounded-${index + 19}`,
          text: `review hidden bounded ${index + 19}`,
          timestamp: `2026-04-13T11:${String(59 - index).padStart(2, '0')}:00.000Z`,
          appName: 'Hidden'
        })),
        Array.from({ length: 10 }, (_, index) => ({
          id: `hidden-bounded-${index + 29}`,
          text: `review hidden bounded ${index + 29}`,
          timestamp: `2026-04-13T11:${String(49 - index).padStart(2, '0')}:00.000Z`,
          appName: 'Hidden'
        })),
        Array.from({ length: 2 }, (_, index) => ({
          id: `hidden-bounded-tail-${index + 39}`,
          text: `review hidden bounded tail ${index + 39}`,
          timestamp: `2026-04-13T11:${String(39 - index).padStart(2, '0')}:00.000Z`,
          appName: 'Hidden'
        }))
      ];
      const fallbackPages = new Map<number, ScreenpipeRecord[]>([
        [42, Array.from({ length: 10 }, (_, index) => ({
          id: `visible-fallback-${index + 1}`,
          text: `review visible fallback ${index + 1}`,
          timestamp: `2026-04-13T11:${String(20 - index).padStart(2, '0')}:00.000Z`,
          appName: 'Visible'
        }))]
      ]);
      const screenpipeClient = new MultiPageFallbackOffsetScreenpipeClient(firstPage, boundedPages, fallbackPages);
      const service = createSearchScreenService({
        embeddingProvider: new StubEmbeddingProvider(),
        screenpipeClient,
        vectorStore: new StubVectorStore([]),
        checkpointStore: new StubCheckpointStore({
          cursor: 'checkpoint-1',
          timestamp: '2026-04-13T12:20:00.000Z'
        }),
        freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
        privacyState: new MutablePrivacyStateReader([
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: ['Future', 'Hidden'] },
          { paused: false, excludedApps: ['Future', 'Hidden'] },
          { paused: false, excludedApps: ['Future', 'Hidden'] },
          { paused: false, excludedApps: ['Future', 'Hidden'] },
          { paused: false, excludedApps: ['Future', 'Hidden'] },
          { paused: false, excludedApps: ['Future', 'Hidden'] },
          { paused: false, excludedApps: ['Future', 'Hidden'] }
        ])
      });

      const result = await service.search({
        query: 'review',
        mode: 'keyword'
      });

      expect(result.evidence.map((item) => item.id)).toEqual(
        Array.from({ length: 10 }, (_, index) => `visible-fallback-${index + 1}`)
      );
      expect(screenpipeClient.searchCalls).toHaveLength(6);
      expect(screenpipeClient.searchCalls[0]).toMatchObject({ offset: 0, to: undefined });
      expect(screenpipeClient.searchCalls[1]).toMatchObject({ offset: 8, to: '2026-04-13T12:30:00.000Z' });
      expect(screenpipeClient.searchCalls[2]).toMatchObject({ offset: 18, to: '2026-04-13T12:30:00.000Z' });
      expect(screenpipeClient.searchCalls[3]).toMatchObject({ offset: 28, to: '2026-04-13T12:30:00.000Z' });
      expect(screenpipeClient.searchCalls[4]).toMatchObject({ offset: 38, to: '2026-04-13T12:30:00.000Z' });
      expect(screenpipeClient.searchCalls[5]).toMatchObject({ offset: 42, to: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves already visible future hits while restarting implicit keyword backfill', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:30:00.000Z'));

    try {
      const records: ScreenpipeRecord[] = [
        {
          id: 'future-visible-1',
          text: 'review future visible 1',
          timestamp: '2026-04-13T12:31:00.000Z',
          appName: 'Future'
        },
        {
          id: 'future-visible-2',
          text: 'review future visible 2',
          timestamp: '2026-04-13T12:32:00.000Z',
          appName: 'Future'
        },
        {
          id: 'hidden-1',
          text: 'review hidden 1',
          timestamp: '2026-04-13T12:20:00.000Z',
          appName: 'Hidden'
        },
        {
          id: 'hidden-2',
          text: 'review hidden 2',
          timestamp: '2026-04-13T12:19:00.000Z',
          appName: 'Hidden'
        },
        {
          id: 'visible-1',
          text: 'review visible 1',
          timestamp: '2026-04-13T12:18:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'visible-2',
          text: 'review visible 2',
          timestamp: '2026-04-13T12:17:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'visible-3',
          text: 'review visible 3',
          timestamp: '2026-04-13T12:16:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'visible-4',
          text: 'review visible 4',
          timestamp: '2026-04-13T12:15:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'visible-5',
          text: 'review visible 5',
          timestamp: '2026-04-13T12:14:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'visible-6',
          text: 'review visible 6',
          timestamp: '2026-04-13T12:13:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'replacement-1',
          text: 'review replacement 1',
          timestamp: '2026-04-13T12:12:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'replacement-2',
          text: 'review replacement 2',
          timestamp: '2026-04-13T12:11:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'replacement-3',
          text: 'review replacement 3',
          timestamp: '2026-04-13T12:10:00.000Z',
          appName: 'Visible'
        },
        {
          id: 'replacement-4',
          text: 'review replacement 4',
          timestamp: '2026-04-13T12:09:00.000Z',
          appName: 'Visible'
        }
      ];
      const screenpipeClient = new StubScreenpipeClient(records);
      const service = createSearchScreenService({
        embeddingProvider: new StubEmbeddingProvider(),
        screenpipeClient,
        vectorStore: new StubVectorStore([]),
        checkpointStore: new StubCheckpointStore({
          cursor: 'checkpoint-1',
          timestamp: '2026-04-13T12:20:00.000Z'
        }),
        freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
        privacyState: new MutablePrivacyStateReader([
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: ['Hidden'] },
          { paused: false, excludedApps: ['Hidden'] },
          { paused: false, excludedApps: ['Hidden'] }
        ])
      });

      const result = await service.search({
        query: 'review',
        mode: 'keyword'
      });

      expect(result.evidence.map((item) => item.id)).toEqual([
        'future-visible-1',
        'future-visible-2',
        'visible-1',
        'visible-2',
        'visible-3',
        'visible-4',
        'visible-5',
        'visible-6',
        'replacement-1',
        'replacement-2'
      ]);
      expect(screenpipeClient.searchCalls).toHaveLength(2);
      expect(screenpipeClient.searchCalls[0]).toMatchObject({ offset: 0, to: undefined });
      expect(screenpipeClient.searchCalls[1]).toMatchObject({ offset: 8, to: '2026-04-13T12:30:00.000Z' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('pages semantic results from a single vector snapshot', async () => {
    const snapshotRecords = [
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `semantic-hidden-${index + 1}`,
        text: `review hidden semantic ${index + 1}`,
        timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
        appName: 'Notes',
        score: 1 - index / 100
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `semantic-visible-${index + 1}`,
        text: `review visible semantic ${index + 1}`,
        timestamp: `2026-04-13T11:${String(index + 10).padStart(2, '0')}:00.000Z`,
        appName: 'Terminal',
        score: 0.8 - index / 100
      }))
    ];
    const liveRecords = [
      {
        id: 'semantic-drifted',
        text: 'review drifted semantic',
        timestamp: '2026-04-13T12:30:00.000Z',
        appName: 'Drift',
        score: 0.99
      },
      ...snapshotRecords
    ];
    const vectorStore = new SnapshotVectorStore(snapshotRecords, liveRecords);
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([]),
      vectorStore,
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['Notes'] },
        { paused: false, excludedApps: ['Notes'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'semantic'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `semantic-visible-${index + 1}`)
    );
    expect(vectorStore.querySnapshotCalls).toHaveLength(1);
    expect(vectorStore.queryCalls).toEqual([]);
  });

  it('preserves an explicit upper time bound across hybrid keyword and semantic queries', async () => {
    const upperBound = '2026-04-13T11:30:00.000Z';
    const firstKeywordPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-hidden-${index + 1}`,
      text: `review hidden keyword ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Notes'
    }));
    const secondKeywordPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-visible-${index + 1}`,
      text: `review visible keyword ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index + 10).padStart(2, '0')}:00.000Z`,
      appName: 'Terminal'
    }));
    const screenpipeClient = new InsertingTimeBoundScreenpipeClient(firstKeywordPage, secondKeywordPage, secondKeywordPage);
    const vectorStore = new StubVectorStore([
      {
        id: 'semantic-visible',
        text: 'review semantic visible',
        timestamp: '2026-04-13T11:25:00.000Z',
        appName: 'Terminal',
        score: 0.95
      }
    ]);
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['Notes'] },
        { paused: false, excludedApps: ['Notes'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'hybrid',
      to: upperBound
    });

    expect(result.evidence.map((item) => item.id)).toContain('semantic-visible');
    expect(screenpipeClient.searchCalls).toHaveLength(2);
    expect(screenpipeClient.searchCalls[0]?.to).toBe(upperBound);
    expect(screenpipeClient.searchCalls[1]?.to).toBe(upperBound);
    expect(vectorStore.queryCalls).toHaveLength(1);
    expect(vectorStore.queryCalls[0]?.to).toBe(upperBound);
  });
  it('backfills visible keyword results when privacy tightens after the final reread', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-notes-${index + 1}`,
      text: `review note notes ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Notes'
    }));
    const secondPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-terminal-${index + 1}`,
      text: `review note terminal ${index + 1}`,
      timestamp: `2026-04-13T12:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Terminal'
    }));
    const screenpipeClient = new StubPrivacyAwareScreenpipeClient([firstPage, secondPage]);
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['Notes'] },
        { paused: false, excludedApps: ['Notes'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence).toHaveLength(10);
    expect(result.evidence.every((item) => item.appName === 'Terminal')).toBe(true);
    expect(result.evidence.map((item) => item.id)).toEqual(Array.from({ length: 10 }, (_, index) => `keyword-terminal-${index + 1}`));
    expect(screenpipeClient.searchCalls).toHaveLength(2);
  });

  it('keeps implicit keyword privacy backfill unbounded beyond local now when page one was already stable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:30:00.000Z'));

    try {
      const firstPage = Array.from({ length: 10 }, (_, index) => ({
        id: `keyword-hidden-${index + 1}`,
        text: `review hidden keyword ${index + 1}`,
        timestamp: `2026-04-13T12:${String(20 - index).padStart(2, '0')}:00.000Z`,
        appName: 'Hidden'
      }));
      const boundedSecondPage = Array.from({ length: 5 }, (_, index) => ({
        id: `keyword-visible-past-${index + 1}`,
        text: `review visible past ${index + 1}`,
        timestamp: `2026-04-13T12:${String(10 - index).padStart(2, '0')}:00.000Z`,
        appName: 'Visible'
      }));
      const unboundedSecondPage = [
        ...boundedSecondPage,
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `keyword-visible-future-${index + 1}`,
          text: `review visible future ${index + 1}`,
          timestamp: `2026-04-13T12:${String(31 + index).padStart(2, '0')}:00.000Z`,
          appName: 'Visible'
        }))
      ];
      const screenpipeClient = new FutureBoundedBackfillScreenpipeClient(firstPage, boundedSecondPage, unboundedSecondPage);
      const service = createSearchScreenService({
        embeddingProvider: new StubEmbeddingProvider(),
        screenpipeClient,
        vectorStore: new StubVectorStore([]),
        checkpointStore: new StubCheckpointStore(),
        freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
        privacyState: new MutablePrivacyStateReader([
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: ['Hidden'] },
          { paused: false, excludedApps: ['Hidden'] }
        ])
      });

      const result = await service.search({
        query: 'review',
        mode: 'keyword'
      });

      expect(result.evidence.map((item) => item.id)).toEqual([
        ...Array.from({ length: 5 }, (_, index) => `keyword-visible-past-${index + 1}`),
        ...Array.from({ length: 5 }, (_, index) => `keyword-visible-future-${index + 1}`)
      ]);
      expect(screenpipeClient.searchCalls).toHaveLength(3);
      expect(screenpipeClient.searchCalls[0]).toMatchObject({ offset: 0, to: undefined });
      expect(screenpipeClient.searchCalls[1]).toMatchObject({ offset: 10, to: '2026-04-13T12:30:00.000Z' });
      expect(screenpipeClient.searchCalls[2]).toMatchObject({ offset: 15, to: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('dedupes keyword privacy backfill pages when later pages repeat earlier ids', async () => {
    const firstPage = [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `keyword-hidden-${index + 1}`,
        text: `review hidden keyword ${index + 1}`,
        timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
        appName: 'Hidden'
      })),
      {
        id: 'keyword-visible-1',
        text: 'review visible keyword 1',
        timestamp: '2026-04-13T11:08:00.000Z',
        appName: 'Notes'
      },
      {
        id: 'keyword-visible-2',
        text: 'review visible keyword 2',
        timestamp: '2026-04-13T11:09:00.000Z',
        appName: 'Notes'
      }
    ];
    const secondPage = [
      {
        id: 'keyword-visible-2',
        text: 'review visible keyword 2',
        timestamp: '2026-04-13T11:09:00.000Z',
        appName: 'Notes'
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `keyword-visible-${index + 3}`,
        text: `review visible keyword ${index + 3}`,
        timestamp: `2026-04-13T12:${String(index).padStart(2, '0')}:00.000Z`,
        appName: 'Notes'
      }))
    ];
    const screenpipeClient = new StubPrivacyAwareScreenpipeClient([firstPage, secondPage]);
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['Hidden'] },
        { paused: false, excludedApps: ['Hidden'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(Array.from({ length: 10 }, (_, index) => `keyword-visible-${index + 1}`));
    expect(new Set(result.evidence.map((item) => item.id)).size).toBe(10);
    expect(screenpipeClient.searchCalls).toHaveLength(2);
  });

  it('freezes non-snapshot semantic paging into a single bounded query before privacy backfill', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => ({
      id: `semantic-hidden-live-${index + 1}`,
      text: `review hidden semantic live ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Notes',
      score: 1 - index / 100
    }));
    const secondPage = Array.from({ length: 10 }, (_, index) => ({
      id: `semantic-visible-live-${index + 1}`,
      text: `review visible semantic live ${index + 1}`,
      timestamp: `2026-04-13T12:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Terminal',
      score: 0.8 - index / 100
    }));
    const vectorStore = new StubPrivacyAwareVectorStore([firstPage, secondPage]);
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([]),
      vectorStore,
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['Notes'] },
        { paused: false, excludedApps: ['Notes'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'semantic'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `semantic-visible-live-${index + 1}`)
    );
    expect(vectorStore.queryCalls).toHaveLength(1);
    expect(vectorStore.queryCalls[0]).toMatchObject({ limit: 50, offset: 0 });
  });
  it('backfills visible hybrid results when privacy tightens after the final reread', async () => {
    const firstKeywordPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-notes-${index + 1}`,
      text: `review keyword notes ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Notes'
    }));
    const firstSemanticPage = Array.from({ length: 10 }, (_, index) => ({
      id: `semantic-notes-${index + 1}`,
      text: `review semantic notes ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index + 10).padStart(2, '0')}:00.000Z`,
      appName: 'Notes',
      score: 1 - index / 100
    }));
    const secondKeywordPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-terminal-${index + 1}`,
      text: `review keyword terminal ${index + 1}`,
      timestamp: `2026-04-13T12:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Terminal'
    }));
    const secondSemanticPage = Array.from({ length: 10 }, (_, index) => ({
      id: `semantic-terminal-${index + 1}`,
      text: `review semantic terminal ${index + 1}`,
      timestamp: `2026-04-13T12:${String(index + 10).padStart(2, '0')}:00.000Z`,
      appName: 'Terminal',
      score: 0.8 - index / 100
    }));
    const screenpipeClient = new StubHybridBackfillScreenpipeClient(firstKeywordPage, [secondKeywordPage]);
    const vectorStore = new StubHybridBackfillVectorStore(firstSemanticPage, [secondSemanticPage]);
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['Notes'] },
        { paused: false, excludedApps: ['Notes'] },
        { paused: false, excludedApps: ['Notes'] },
        { paused: false, excludedApps: ['Notes'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'hybrid'
    });

    expect(result.evidence).toHaveLength(10);
    expect(result.evidence.every((item) => item.appName === 'Terminal')).toBe(true);
    expect(result.evidence.map((item) => item.id)).toContain('keyword-terminal-1');
    expect(screenpipeClient.searchCalls).toHaveLength(2);
    expect(vectorStore.queryCalls).toHaveLength(1);
    expect(vectorStore.queryCalls[0]).toMatchObject({ limit: 50, offset: 0 });
  });

  it('reports degraded keyword results when privacy-triggered backfill fails', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-hidden-${index + 1}`,
      text: `review hidden keyword ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Claude'
    }));
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubPartialFailureScreenpipeClient(firstPage),
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['Claude'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence).toEqual([]);
    expect(result.degraded).toEqual({
      reason: 'Privacy filtering hid earlier keyword results and a later Screenpipe page failed before replacement results could be collected.'
    });
  });

  it('continues hybrid backfill on the surviving provider and reports degradation when the other side fails', async () => {
    const firstKeywordPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-hidden-${index + 1}`,
      text: `review hidden keyword ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Claude'
    }));
    const firstSemanticPage = Array.from({ length: 10 }, (_, index) => ({
      id: `semantic-hidden-${index + 1}`,
      text: `review hidden semantic ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index + 10).padStart(2, '0')}:00.000Z`,
      appName: 'Notes',
      score: 1 - index / 100
    }));
    const secondSemanticPage = Array.from({ length: 10 }, (_, index) => ({
      id: `semantic-visible-${index + 1}`,
      text: `review visible semantic ${index + 1}`,
      timestamp: `2026-04-13T12:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Terminal',
      score: 0.8 - index / 100
    }));
    const screenpipeClient = new StubHybridBackfillScreenpipeClient(firstKeywordPage, [], new Set([10]));
    const vectorStore = new StubHybridBackfillVectorStore(firstSemanticPage, [secondSemanticPage]);
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['Claude', 'Notes'] },
        { paused: false, excludedApps: ['Claude', 'Notes'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'hybrid'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(Array.from({ length: 10 }, (_, index) => `semantic-visible-${index + 1}`));
    expect(result.degraded).toEqual({
      reason: 'Privacy filtering hid earlier hybrid results and a later Screenpipe page failed before replacement results could be collected.'
    });
    expect(screenpipeClient.searchCalls).toHaveLength(2);
    expect(vectorStore.queryCalls).toHaveLength(1);
    expect(vectorStore.queryCalls[0]).toMatchObject({ limit: 50, offset: 0 });
  });

  it('preserves privacy-backfill degradation when semantic search already fell back to keyword results', async () => {
    const firstKeywordPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-notes-${index + 1}`,
      text: `review visible keyword ${index + 1}`,
      timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Notes'
    }));
    const screenpipeClient = new StubPartialFailureScreenpipeClient(firstKeywordPage);
    const service = createSearchScreenService({
      embeddingProvider: new ThrowingEmbeddingProvider(),
      screenpipeClient,
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['Notes'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'semantic'
    });

    expect(result.evidence).toEqual([]);
    expect(result.degraded).toEqual({
      reason: 'Privacy filtering hid earlier keyword results and a later Screenpipe page failed before replacement results could be collected.',
      fallbackMode: 'keyword'
    });
  });


  it('preserves implicit fallback after privacy relaxes mid-search', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:30:00.000Z'));

    try {
      const firstPage = Array.from({ length: 10 }, (_, index) => ({
        id: `future-hidden-${index + 1}`,
        text: `review future hidden ${index + 1}`,
        timestamp: `2026-04-13T12:${String(31 + index).padStart(2, '0')}:00.000Z`,
        appName: 'Hidden'
      }));
      const visibleFuturePage = Array.from({ length: 10 }, (_, index) => ({
        id: `visible-future-${index + 1}`,
        text: `review visible future ${index + 1}`,
        timestamp: `2026-04-13T12:${String(41 + index).padStart(2, '0')}:00.000Z`,
        appName: 'Visible'
      }));
      const searchCalls: ScreenpipeSearchRequest[] = [];
      const screenpipeClient: ScreenpipeClient = {
        async search(request) {
          searchCalls.push(request);

          if ((request.offset ?? 0) === 0 && !request.to) {
            return firstPage;
          }

          if ((request.offset ?? 0) === 0 && request.to) {
            return [];
          }

          if ((request.offset ?? 0) === 10 && !request.to) {
            return visibleFuturePage;
          }

          return [];
        },
        async recent() {
          return [...firstPage, ...visibleFuturePage];
        }
      };
      const service = createSearchScreenService({
        embeddingProvider: new StubEmbeddingProvider(),
        screenpipeClient,
        vectorStore: new StubVectorStore([]),
        checkpointStore: new StubCheckpointStore(),
        freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
        privacyState: new MutablePrivacyStateReader([
          { paused: false, excludedApps: [] },
          { paused: false, excludedApps: ['Hidden'] },
          { paused: false, excludedApps: ['Hidden'] },
          { paused: false, excludedApps: ['Hidden'] },
          { paused: false, excludedApps: ['Hidden'] }
        ])
      });

      const result = await service.search({
        query: 'review',
        mode: 'keyword'
      });

      expect(result.evidence.map((item) => item.id)).toEqual(
        Array.from({ length: 10 }, (_, index) => `visible-future-${index + 1}`)
      );
      expect(searchCalls).toHaveLength(3);
      expect(searchCalls[0]).toMatchObject({ offset: 0, to: undefined });
      expect(searchCalls[1]).toMatchObject({ offset: 0, to: '2026-04-13T12:30:00.000Z' });
      expect(searchCalls[2]).toMatchObject({ offset: 10, to: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('embeds semantic queries without a redundant privacy reread', async () => {
    const embeddingProvider = new RecordingEmbeddingProvider();
    const vectorStore = new StubVectorStore([]);
    const service = createSearchScreenService({
      embeddingProvider,
      screenpipeClient: new StubScreenpipeClient([]),
      vectorStore,
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new SequencePrivacyStateReader([
        { paused: false, excludedApps: [] },
        new Error('privacy state unavailable')
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'semantic'
    });

    expect(result.summary).toContain('currently unavailable');
    expect(result.evidence).toEqual([]);
    expect(result.error).toMatchObject({
      code: 'RETRIEVAL_FAILED',
      message: 'Privacy controls could not be loaded while processing search.'
    });
    expect(embeddingProvider.inputs).toEqual(['review']);
    expect(vectorStore.queryCalls).toHaveLength(1);
  });

  it('returns an actionable error when privacy reread fails during semantic filtering', async () => {
    const embeddingProvider = new RecordingEmbeddingProvider();
    const service = createSearchScreenService({
      embeddingProvider,
      screenpipeClient: new StubScreenpipeClient([]),
      vectorStore: new StubVectorStore([
        {
          id: 'semantic-visible',
          text: 'review semantic visible',
          timestamp: '2026-04-13T12:06:00.000Z',
          appName: 'Notes',
          score: 0.97
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new SequencePrivacyStateReader([
        { paused: false, excludedApps: [] },
        new Error('privacy state unavailable')
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'semantic'
    });

    expect(result.summary).toContain('currently unavailable');
    expect(result.evidence).toEqual([]);
    expect(result.error).toMatchObject({
      code: 'RETRIEVAL_FAILED',
      message: 'Privacy controls could not be loaded while processing search.'
    });
    expect(embeddingProvider.inputs).toEqual(['review']);
  });

  it('returns an actionable error when privacy reread fails mid-search', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'keyword-visible',
          text: 'review note visible',
          timestamp: '2026-04-13T12:06:00.000Z',
          appName: 'Notes'
        }
      ]),
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new SequencePrivacyStateReader([
        { paused: false, excludedApps: [] },
        new Error('privacy state unavailable')
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.summary).toContain('currently unavailable');
    expect(result.evidence).toEqual([]);
    expect(result.error).toMatchObject({
      code: 'RETRIEVAL_FAILED',
      message: 'Privacy controls could not be loaded while processing search.'
    });
  });

  it('keeps paginating until visible semantic results fill the limit', async () => {
    const pagedSemanticService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([]),
      vectorStore: new StubVectorStore([
        {
          id: 'excluded-1',
          text: 'review note one',
          timestamp: '2026-04-13T11:01:00.000Z',
          appName: 'Claude',
          score: 0.99
        },
        {
          id: 'excluded-2',
          text: 'review note two',
          timestamp: '2026-04-13T11:02:00.000Z',
          appName: 'Claude',
          score: 0.98
        },
        {
          id: 'semantic-visible-1',
          text: 'review note three',
          timestamp: '2026-04-13T11:03:00.000Z',
          appName: 'Notes',
          score: 0.97
        },
        {
          id: 'semantic-visible-2',
          text: 'review note four',
          timestamp: '2026-04-13T11:04:00.000Z',
          appName: 'Terminal',
          score: 0.96
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['Claude']
      })
    });

    const result = await pagedSemanticService.search({
      query: 'review',
      mode: 'semantic'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['semantic-visible-1', 'semantic-visible-2']);
    expect(result.evidence.every((item) => item.appName !== 'Claude')).toBe(true);
  });

  it('keeps paginating until visible keyword results fill the limit', async () => {
    const pagedKeywordService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'excluded-keyword-1',
          text: 'review note one',
          timestamp: '2026-04-13T11:01:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-2',
          text: 'review note two',
          timestamp: '2026-04-13T11:02:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'keyword-visible-1',
          text: 'review note three',
          timestamp: '2026-04-13T11:03:00.000Z',
          appName: 'Notes'
        },
        {
          id: 'keyword-visible-2',
          text: 'review note four',
          timestamp: '2026-04-13T11:04:00.000Z',
          appName: 'Terminal'
        }
      ]),
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['Claude']
      })
    });

    const result = await pagedKeywordService.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['keyword-visible-1', 'keyword-visible-2']);
    expect(result.evidence.every((item) => item.appName !== 'Claude')).toBe(true);
  });

  it('preserves visible keyword hits when a later keyword page fails', async () => {
    const partialKeywordService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubPartialFailureScreenpipeClient([
        {
          id: 'keyword-visible-1',
          text: 'review note one',
          timestamp: '2026-04-13T11:03:00.000Z',
          appName: 'Notes'
        },
        {
          id: 'keyword-visible-2',
          text: 'review note two',
          timestamp: '2026-04-13T11:04:00.000Z',
          appName: 'Terminal'
        },
        {
          id: 'excluded-keyword-1',
          text: 'review note three',
          timestamp: '2026-04-13T11:05:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-2',
          text: 'review note four',
          timestamp: '2026-04-13T11:06:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-3',
          text: 'review note five',
          timestamp: '2026-04-13T11:07:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-4',
          text: 'review note six',
          timestamp: '2026-04-13T11:08:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-5',
          text: 'review note seven',
          timestamp: '2026-04-13T11:09:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-6',
          text: 'review note eight',
          timestamp: '2026-04-13T11:10:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-7',
          text: 'review note nine',
          timestamp: '2026-04-13T11:11:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-8',
          text: 'review note ten',
          timestamp: '2026-04-13T11:12:00.000Z',
          appName: 'Claude'
        }
      ]),
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['Claude']
      })
    });

    const result = await partialKeywordService.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['keyword-visible-1', 'keyword-visible-2']);
    expect(result.degraded).toEqual({
      reason: 'Screenpipe search returned partial keyword results before failing.'
    });
  });

  it('restores keyword hits when privacy becomes less restrictive before a later page fails', async () => {
    const partialKeywordService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubPartialFailureScreenpipeClient([
        {
          id: 'keyword-restore-1',
          text: 'review note one',
          timestamp: '2026-04-13T11:03:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'keyword-restore-2',
          text: 'review note two',
          timestamp: '2026-04-13T11:04:00.000Z',
          appName: 'Terminal'
        }
      ]),
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: ['Claude'] },
        { paused: false, excludedApps: [] }
      ])
    });

    const result = await partialKeywordService.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['keyword-restore-1', 'keyword-restore-2']);
    expect(result.degraded).toBeUndefined();
  });
  it('returns visible semantic hits from a frozen non-snapshot query when excluded apps dominate the window', async () => {
    const vectorStore = new StubVectorStore([
        {
          id: 'semantic-visible-1',
          text: 'review note one',
          timestamp: '2026-04-13T11:03:00.000Z',
          appName: 'Notes',
          score: 0.99
        },
        {
          id: 'semantic-visible-2',
          text: 'review note two',
          timestamp: '2026-04-13T11:04:00.000Z',
          appName: 'Terminal',
          score: 0.98
        },
        {
          id: 'excluded-semantic-1',
          text: 'review note three',
          timestamp: '2026-04-13T11:05:00.000Z',
          appName: 'Claude',
          score: 0.97
        },
        {
          id: 'excluded-semantic-2',
          text: 'review note four',
          timestamp: '2026-04-13T11:06:00.000Z',
          appName: 'Claude',
          score: 0.96
        },
        {
          id: 'excluded-semantic-3',
          text: 'review note five',
          timestamp: '2026-04-13T11:07:00.000Z',
          appName: 'Claude',
          score: 0.95
        },
        {
          id: 'excluded-semantic-4',
          text: 'review note six',
          timestamp: '2026-04-13T11:08:00.000Z',
          appName: 'Claude',
          score: 0.94
        },
        {
          id: 'excluded-semantic-5',
          text: 'review note seven',
          timestamp: '2026-04-13T11:09:00.000Z',
          appName: 'Claude',
          score: 0.93
        },
        {
          id: 'excluded-semantic-6',
          text: 'review note eight',
          timestamp: '2026-04-13T11:10:00.000Z',
          appName: 'Claude',
          score: 0.92
        },
        {
          id: 'excluded-semantic-7',
          text: 'review note nine',
          timestamp: '2026-04-13T11:11:00.000Z',
          appName: 'Claude',
          score: 0.91
        },
        {
          id: 'excluded-semantic-8',
          text: 'review note ten',
          timestamp: '2026-04-13T11:12:00.000Z',
          appName: 'Claude',
          score: 0.9
        }
      ]);
    const semanticService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([]),
      vectorStore,
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['Claude']
      })
    });

    const result = await semanticService.search({
      query: 'review',
      mode: 'semantic'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['semantic-visible-1', 'semantic-visible-2']);
    expect(result.degraded).toBeUndefined();
    expect(vectorStore.queryCalls).toHaveLength(1);
    expect(vectorStore.queryCalls[0]).toMatchObject({ limit: 50, offset: 0 });
  });

  it('caps keyword paging when excluded apps dominate the provider results', async () => {
    const manyExcludedRecords = Array.from({ length: 80 }, (_, index) => ({
      id: `excluded-keyword-${index + 1}`,
      text: 'review note',
      timestamp: `2026-04-13T11:${String(index % 60).padStart(2, '0')}:00.000Z`,
      appName: 'Claude'
    }));

    const screenpipeClient = new StubScreenpipeClient(manyExcludedRecords);
    const cappedKeywordService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['Claude']
      })
    });

    const result = await cappedKeywordService.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence).toEqual([]);
    expect(screenpipeClient.searchCalls).toHaveLength(5);
    expect(screenpipeClient.searchCalls.at(-1)).toMatchObject({
      limit: 10,
      offset: 40
    });
  });

  it('re-applies the visible result cap after privacy-driven keyword paging', async () => {
    const firstPage = [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `keyword-hidden-cap-${index + 1}`,
        text: `review note hidden ${index + 1}`,
        timestamp: `2026-04-13T11:${String(index).padStart(2, '0')}:00.000Z`,
        appName: 'Claude'
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `keyword-visible-cap-${index + 1}`,
        text: `review note visible ${index + 1}`,
        timestamp: `2026-04-13T11:${String(index + 5).padStart(2, '0')}:00.000Z`,
        appName: 'Notes'
      }))
    ];
    const secondPage = Array.from({ length: 10 }, (_, index) => ({
      id: `keyword-visible-overflow-${index + 1}`,
      text: `review note overflow ${index + 1}`,
      timestamp: `2026-04-13T12:${String(index).padStart(2, '0')}:00.000Z`,
      appName: 'Terminal'
    }));
    const screenpipeClient = new StubPrivacyAwareScreenpipeClient([firstPage, secondPage]);
    const cappedService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['Claude']
      })
    });

    const result = await cappedService.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence).toHaveLength(10);
    expect(result.evidence.every((item) => item.appName !== 'Claude')).toBe(true);
    expect(result.evidence.map((item) => item.id)).toEqual([
      ...firstPage.filter((item) => item.appName !== 'Claude').map((item) => item.id),
      ...secondPage.slice(0, 5).map((item) => item.id)
    ]);
    expect(screenpipeClient.searchCalls).toHaveLength(2);
  });

  it('caps semantic paging when excluded apps dominate the provider results', async () => {
    const manyExcludedResults = Array.from({ length: 80 }, (_, index) => ({
      id: `excluded-semantic-${index + 1}`,
      text: 'review note',
      timestamp: `2026-04-13T11:${String(index % 60).padStart(2, '0')}:00.000Z`,
      appName: 'Claude',
      score: 1 - index / 100
    }));

    const vectorStore = new StubVectorStore(manyExcludedResults);
    const cappedSemanticService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([]),
      vectorStore,
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['Claude']
      })
    });

    const result = await cappedSemanticService.search({
      query: 'review',
      mode: 'semantic'
    });

    expect(result.evidence).toEqual([]);
    expect(vectorStore.queryCalls).toHaveLength(1);
    expect(vectorStore.queryCalls[0]).toMatchObject({
      limit: 50,
      offset: 0
    });
  });

  it('uses the fallback mode in degraded hybrid summaries when Screenpipe fails', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubHybridBackfillScreenpipeClient([], [], new Set([0])),
      vectorStore: new StubVectorStore([
        {
          id: 'semantic-only-1',
          text: 'review semantic fallback one',
          timestamp: '2026-04-13T12:06:00.000Z',
          appName: 'Notes',
          score: 0.97
        },
        {
          id: 'semantic-only-2',
          text: 'review semantic fallback two',
          timestamp: '2026-04-13T12:07:00.000Z',
          appName: 'Terminal',
          score: 0.96
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({ paused: false, excludedApps: [] })
    });

    const result = await service.search({
      query: 'review',
      mode: 'hybrid'
    });

    expect(result.summary).toContain('using semantic search');
    expect(result.evidence.map((item) => item.id)).toEqual(['semantic-only-1', 'semantic-only-2']);
    expect(result.degraded).toEqual({
      reason: 'Screenpipe search failed; returned semantic-backed results instead.',
      fallbackMode: 'semantic'
    });
  });


  it('restores keyword hits when privacy becomes less restrictive after a later page fails', async () => {
    const partialKeywordService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubPartialFailureScreenpipeClient([
        {
          id: 'keyword-restore-after-failure-1',
          text: 'review note one',
          timestamp: '2026-04-13T11:03:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'keyword-restore-after-failure-2',
          text: 'review note two',
          timestamp: '2026-04-13T11:04:00.000Z',
          appName: 'Terminal'
        }
      ]),
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: ['Claude'] },
        { paused: false, excludedApps: ['Claude'] },
        { paused: false, excludedApps: [] }
      ])
    });

    const result = await partialKeywordService.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence.map((item) => item.id)).toEqual([
      'keyword-restore-after-failure-1',
      'keyword-restore-after-failure-2'
    ]);
    expect(result.degraded).toBeUndefined();
  });

  it('restores semantic hits when privacy becomes less restrictive after a frozen semantic query', async () => {
    const vectorStore = new StubVectorStore([
      {
        id: 'semantic-restore-after-freeze-1',
        text: 'review note one',
        timestamp: '2026-04-13T11:03:00.000Z',
        appName: 'Claude',
        score: 0.99
      },
      {
        id: 'semantic-restore-after-freeze-2',
        text: 'review note two',
        timestamp: '2026-04-13T11:04:00.000Z',
        appName: 'Terminal',
        score: 0.98
      }
    ]);
    const semanticService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([]),
      vectorStore,
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: ['Claude'] },
        { paused: false, excludedApps: ['Claude'] },
        { paused: false, excludedApps: [] }
      ])
    });

    const result = await semanticService.search({
      query: 'review',
      mode: 'semantic'
    });

    expect(result.evidence.map((item) => item.id)).toEqual([
      'semantic-restore-after-freeze-1',
      'semantic-restore-after-freeze-2'
    ]);
    expect(result.degraded).toBeUndefined();
    expect(vectorStore.queryCalls).toHaveLength(1);
    expect(vectorStore.queryCalls[0]).toMatchObject({ limit: 50, offset: 0 });
  });


  it('re-applies privacy before returning hybrid results when backfill stops without new pages', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubHybridBackfillScreenpipeClient([
        {
          id: 'hybrid-keyword-stale-1',
          text: 'review note one',
          timestamp: '2026-04-13T11:03:00.000Z',
          appName: 'Claude'
        }
      ], []),
      vectorStore: new StubHybridBackfillVectorStore([
        {
          id: 'hybrid-semantic-stale-1',
          text: 'review note two',
          timestamp: '2026-04-13T11:04:00.000Z',
          appName: 'Terminal',
          score: 0.99
        }
      ], []),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['Claude'] }
      ])
    });

    const result = await service.search({
      query: 'review',
      mode: 'hybrid'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['hybrid-semantic-stale-1']);
    expect(result.evidence.every((item) => item.appName !== 'Claude')).toBe(true);
  });

  it('keeps active pause suppression open-ended when the request upper bound extends beyond local now', async () => {
    const pausedService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'keyword-before-pause-future-window',
          text: 'review note before pause',
          timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
          appName: 'Notes'
        },
        {
          id: 'keyword-future-during-pause',
          text: 'review note during pause with future timestamp',
          timestamp: new Date(Date.now() + 60_000).toISOString(),
          appName: 'Claude'
        }
      ]),
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: true,
        excludedApps: [],
        pauseStartedAt: new Date(Date.now() - 5 * 60_000).toISOString()
      })
    });

    const result = await pausedService.search({
      query: 'review',
      mode: 'keyword',
      to: new Date(Date.now() + 2 * 60_000).toISOString()
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['keyword-before-pause-future-window']);
    expect(result.evidence.every((item) => item.id !== 'keyword-future-during-pause')).toBe(true);
  });

  it('does not clamp implicit keyword search windows to the local clock', async () => {
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'keyword-future-visible-without-to',
        text: 'review future visible keyword',
        timestamp: new Date(Date.now() + 60_000).toISOString(),
        appName: 'Notes'
      }
    ]);
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore: new StubVectorStore([]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: []
      })
    });

    const result = await service.search({
      query: 'review',
      mode: 'keyword'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['keyword-future-visible-without-to']);
    expect(screenpipeClient.searchCalls[0]?.to).toBeUndefined();
  });

  it('does not clamp implicit semantic search windows to the local clock', async () => {
    const vectorStore = new StubVectorStore([
      {
        id: 'semantic-future-visible-without-to',
        text: 'review future visible semantic',
        timestamp: new Date(Date.now() + 60_000).toISOString(),
        appName: 'Notes',
        score: 0.95
      }
    ]);
    const service = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient([]),
      vectorStore,
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: []
      })
    });

    const result = await service.search({
      query: 'review',
      mode: 'semantic'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['semantic-future-visible-without-to']);
    expect(vectorStore.queryCalls[0]?.to).toBeUndefined();
  });

  it('still queries providers while paused and filters the active pause window', async () => {
    const embeddingProvider = new RecordingEmbeddingProvider();
    const pausedService = createSearchScreenService({
      embeddingProvider,
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'keyword-before-pause',
          text: 'review note before pause',
          timestamp: '2026-04-13T11:50:00.000Z',
          appName: 'Notes'
        },
        {
          id: 'keyword-during-pause',
          text: 'review note during pause',
          timestamp: '2026-04-13T11:57:00.000Z',
          appName: 'Claude'
        }
      ]),
      vectorStore: new StubVectorStore([
        {
          id: 'semantic-before-pause',
          text: 'review semantic before pause',
          timestamp: '2026-04-13T11:49:00.000Z',
          appName: 'Notes',
          score: 0.9
        },
        {
          id: 'semantic-during-pause',
          text: 'review semantic during pause',
          timestamp: '2026-04-13T11:58:00.000Z',
          appName: 'Claude',
          score: 0.8
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: true,
        excludedApps: [],
        pauseStartedAt: '2026-04-13T11:55:00.000Z'
      })
    });

    const result = await pausedService.search({
      query: 'review',
      mode: 'hybrid'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['keyword-before-pause', 'semantic-before-pause']);
    expect(result.error).toBeUndefined();
    expect(embeddingProvider.inputs).toEqual(['review']);
  });


  it('reports stale-catchup-allowed freshness while backlog catch-up is unfinished', async () => {
    const backlogService = createSearchScreenService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient: new StubScreenpipeClient(keywordRecords),
      vectorStore: new StubVectorStore(semanticRecords),
      checkpointStore: new StubCheckpointStore({
        cursor: 'checkpoint-1',
        timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
        backlog: {
          from: '2026-04-13T11:45:00.000Z',
          to: '2026-04-13T12:00:00.000Z',
          nextOffset: 2
        }
      }),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 })
    });

    const result = await backlogService.search({
      query: 'review',
      mode: 'hybrid'
    });

    expect(result.freshness?.status).toBe('stale-catchup-allowed');
  });
});

