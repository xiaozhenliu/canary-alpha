import { describe, expect, it } from 'vitest';

import type { PrivacyState, PrivacyStateReader } from '../../../src/services/privacy/types.js';
import { createIndexingService } from '../../../src/services/retrieval/indexing-service.js';
import type {
  CheckpointStore,
  EmbeddingProvider,
  IndexedCheckpoint,
  ScreenpipeClient,
  ScreenpipeRecord,
  VectorStore,
  VectorStoreRecord
} from '../../../src/services/retrieval/types.js';

class StubEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'stub';

  constructor(private readonly values = new Map<string, number[]>()) {}

  async embed(input: string): Promise<number[]> {
    return this.values.get(input) ?? [input.length, 0, 0];
  }
}

class PartiallyFailingEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'partially-failing';

  constructor(private readonly failingInputs: Set<string>) {}

  async embed(input: string): Promise<number[]> {
    if (this.failingInputs.has(input)) {
      throw new Error(`embedding failed for ${input}`);
    }

    return [input.length, 1, 0];
  }
}

class AlwaysFailingEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'always-failing';

  async embed(): Promise<number[]> {
    throw new Error('embedding unavailable');
  }
}

class MutatingPrivacyEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'mutating-privacy';

  constructor(
    private readonly privacy: { current: PrivacyState },
    private readonly nextState: PrivacyState
  ) {}

  async embed(input: string): Promise<number[]> {
    this.privacy.current = this.nextState;
    return [input.length, 2, 0];
  }
}
class StubCheckpointStore implements CheckpointStore {
  constructor(private checkpoint: IndexedCheckpoint | null = null) {}

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

class StubPrivacyStateReader implements PrivacyStateReader {
  constructor(private readonly state: PrivacyState = { paused: false, excludedApps: [] }) {}

  async read(): Promise<PrivacyState> {
    return this.state;
  }
}

class ThrowingPrivacyStateReader implements PrivacyStateReader {
  async read(): Promise<PrivacyState> {
    throw new Error('privacy state unavailable');
  }
}

class MutablePrivacyRefReader implements PrivacyStateReader {
  constructor(private readonly ref: { current: PrivacyState }) {}

  async read(): Promise<PrivacyState> {
    return this.ref.current;
  }
}

class StubScreenpipeClient implements ScreenpipeClient {
  recentCalls: number[] = [];
  searchCalls: Array<{ from?: string; to?: string; limit?: number; offset?: number }> = [];

  constructor(private readonly records: ScreenpipeRecord[]) {}

  async search(request: { from?: string; to?: string; limit?: number; offset?: number }): Promise<ScreenpipeRecord[]> {
    this.searchCalls.push(request);
    const filtered = this.records.filter((record) => {
      const recordTime = Date.parse(record.timestamp);
      const matchesFrom = request.from ? recordTime >= Date.parse(request.from) : true;
      const matchesTo = request.to ? recordTime <= Date.parse(request.to) : true;
      return matchesFrom && matchesTo;
    });

    const offset = request.offset ?? 0;
    const limit = request.limit;
    if (typeof limit === 'number') {
      return filtered.slice(offset, offset + limit);
    }
    return filtered.slice(offset);
  }

  async recent(minutes: number): Promise<ScreenpipeRecord[]> {
    this.recentCalls.push(minutes);
    const now = new Date('2026-04-13T12:00:00.000Z').getTime();
    const cutoff = now - minutes * 60_000;
    return this.records.filter((record) => Date.parse(record.timestamp) >= cutoff);
  }
}

class ThrowingScreenpipeClient implements ScreenpipeClient {
  async search(): Promise<ScreenpipeRecord[]> {
    throw new Error('search should not run while paused');
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    throw new Error('recent should not run while paused');
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

class RecordingVectorStore implements VectorStore {
  readonly kind = 'recording';
  readonly upserts: VectorStoreRecord[][] = [];

  async upsert(records: VectorStoreRecord[]): Promise<void> {
    this.upserts.push(records);
  }

  async reset(): Promise<void> {}

  async query() {
    return [];
  }
}

describe('indexing core service', () => {
  it('supports forced backlog rebuilds from a full-history window after checkpoint reset', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore(null);
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-oldest',
        text: 'Oldest retained note',
        timestamp: '2026-04-13T09:00:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-newest',
        text: 'Newest retained note',
        timestamp: '2026-04-13T11:58:00.000Z',
        appName: 'Claude'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(
        new Map([
          ['Oldest retained note', [1, 0, 0]],
          ['Newest retained note', [0, 1, 0]]
        ])
      ),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10
    });

    const result = await service.runOnce(
      new Date('2026-04-13T12:00:00.000Z'),
      {
        from: '1970-01-01T00:00:00.000Z',
        to: '2026-04-13T12:00:00.000Z',
        nextOffset: 0
      }
    );

    expect(result.fetched).toBe(2);
    expect(result.indexed).toBe(2);
    expect(screenpipeClient.searchCalls).toEqual([
      {
        from: '1970-01-01T00:00:00.000Z',
        to: '2026-04-13T12:00:00.000Z',
        limit: 10,
        offset: 0
      }
    ]);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-oldest', 'record-newest']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-newest',
      timestamp: '2026-04-13T11:58:00.000Z'
    });
  });

  it('bounds first-run catch-up to the configured backlog window', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore(null);
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-old',
        text: 'Outside catch-up window',
        timestamp: '2026-04-13T11:10:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-1',
        text: 'First indexed note',
        timestamp: '2026-04-13T11:55:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-2',
        text: 'Second indexed note',
        timestamp: '2026-04-13T11:58:00.000Z',
        appName: 'Claude'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(
        new Map([
          ['First indexed note', [1, 0, 0]],
          ['Second indexed note', [0, 1, 0]]
        ])
      ),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.fetched).toBe(2);
    expect(result.indexed).toBe(2);
    expect(screenpipeClient.searchCalls).toEqual([
      {
        from: '2026-04-13T11:15:00.000Z',
        to: '2026-04-13T12:00:00.000Z',
        limit: 10,
        offset: 0
      }
    ]);
    expect(vectorStore.upserts).toHaveLength(1);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-1', 'record-2']);
    expect(vectorStore.upserts[0]?.[0]?.embedding).toEqual([1, 0, 0]);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-2',
      timestamp: '2026-04-13T11:58:00.000Z'
    });
  });

  it('indexes only records newer than the checkpoint', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-1',
      timestamp: '2026-04-13T11:55:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Already indexed note',
        timestamp: '2026-04-13T11:55:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-2',
        text: 'New note after checkpoint',
        timestamp: '2026-04-13T11:56:00.000Z',
        appName: 'Claude'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.fetched).toBe(2);
    expect(result.indexed).toBe(1);
    expect(screenpipeClient.recentCalls).toEqual([15]);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-2']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-2',
      timestamp: '2026-04-13T11:56:00.000Z'
    });
  });

  it('preserves sub-minute lag when polling recent records', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-1',
      timestamp: '2026-04-13T11:44:30.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Already indexed note',
        timestamp: '2026-04-13T11:44:30.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-2',
        text: 'New note within sub-minute gap',
        timestamp: '2026-04-13T11:44:40.000Z',
        appName: 'Claude'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.fetched).toBe(2);
    expect(result.indexed).toBe(1);
    expect(screenpipeClient.recentCalls).toEqual([16]);
    expect(screenpipeClient.searchCalls).toEqual([]);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-2']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-2',
      timestamp: '2026-04-13T11:44:40.000Z'
    });
  });

  it('keeps backlog scan progress separate from latest indexed checkpoint when catch-up remains incomplete', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T10:00:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-3',
        text: 'Three',
        timestamp: '2026-04-13T11:59:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-2',
        text: 'Two',
        timestamp: '2026-04-13T11:58:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-window-start',
        text: 'Inside bounded window',
        timestamp: '2026-04-13T11:50:00.000Z',
        appName: 'Claude'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 1,
      maxCatchUpRecords: 2
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.fetched).toBe(2);
    expect(result.indexed).toBe(2);
    expect(screenpipeClient.searchCalls).toEqual([
      {
        from: '2026-04-13T11:45:00.000Z',
        to: '2026-04-13T12:00:00.000Z',
        limit: 2,
        offset: 0
      }
    ]);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-2', 'record-3']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-3',
      timestamp: '2026-04-13T11:59:00.000Z',
      backlog: {
        from: '2026-04-13T11:45:00.000Z',
        to: '2026-04-13T12:00:00.000Z',
        nextOffset: 2
      }
    });
  });

  it('resumes backlog catch-up from the saved offset on the next run', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-3',
      timestamp: '2026-04-13T11:59:00.000Z',
      backlog: {
        from: '2026-04-13T11:45:00.000Z',
        to: '2026-04-13T12:00:00.000Z',
        nextOffset: 2
      }
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-3',
        text: 'Three',
        timestamp: '2026-04-13T11:59:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-2',
        text: 'Two',
        timestamp: '2026-04-13T11:58:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-window-start',
        text: 'Inside bounded window',
        timestamp: '2026-04-13T11:50:00.000Z',
        appName: 'Claude'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 1,
      maxCatchUpRecords: 2
    });

    const result = await service.runOnce(new Date('2026-04-13T12:01:00.000Z'));

    expect(result.fetched).toBe(1);
    expect(result.indexed).toBe(1);
    expect(screenpipeClient.searchCalls).toEqual([
      {
        from: '2026-04-13T11:45:00.000Z',
        to: '2026-04-13T12:00:00.000Z',
        limit: 2,
        offset: 2
      }
    ]);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-window-start']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-3',
      timestamp: '2026-04-13T11:59:00.000Z'
    });
  });

  it('advances backlog catch-up while paused without indexing paused records', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T10:00:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Captured while paused one',
        timestamp: '2026-04-13T11:58:00.000Z',
        appName: 'Terminal'
      },
      {
        id: 'record-2',
        text: 'Captured while paused two',
        timestamp: '2026-04-13T11:59:00.000Z',
        appName: 'Terminal'
      },
      {
        id: 'record-window-start',
        text: 'Older backlog record',
        timestamp: '2026-04-13T11:50:00.000Z',
        appName: 'Terminal'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 1,
      maxCatchUpRecords: 2,
      privacyState: new StubPrivacyStateReader({
        paused: true,
        excludedApps: [],
        pauseStartedAt: '2026-04-13T11:55:00.000Z'
      })
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.fetched).toBe(2);
    expect(result.indexed).toBe(0);
    expect(screenpipeClient.searchCalls).toEqual([
      {
        from: '2026-04-13T11:45:00.000Z',
        to: '2026-04-13T12:00:00.000Z',
        limit: 2,
        offset: 0
      }
    ]);
    expect(vectorStore.upserts).toEqual([]);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-2',
      timestamp: '2026-04-13T11:59:00.000Z',
      backlog: {
        from: '2026-04-13T11:45:00.000Z',
        to: '2026-04-13T12:00:00.000Z',
        nextOffset: 2
      }
    });
  });

  it('does not treat legacy paused states without pauseStartedAt as blocking all indexing history', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T10:00:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Visible legacy paused record one',
        timestamp: '2026-04-13T11:58:00.000Z',
        appName: 'Terminal'
      },
      {
        id: 'record-2',
        text: 'Visible legacy paused record two',
        timestamp: '2026-04-13T11:59:00.000Z',
        appName: 'Terminal'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
      privacyState: new StubPrivacyStateReader({
        paused: true,
        excludedApps: []
      })
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.fetched).toBe(2);
    expect(result.indexed).toBe(2);
    expect(vectorStore.upserts).toHaveLength(1);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-1', 'record-2']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-2',
      timestamp: '2026-04-13T11:59:00.000Z'
    });
  });

  it('skips excluded apps while still advancing the checkpoint', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Skip Claude record',
        timestamp: '2026-04-13T11:20:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-2',
        text: 'Keep terminal record',
        timestamp: '2026-04-13T11:21:00.000Z',
        appName: 'Terminal'
      },
      {
        id: 'record-3',
        text: 'Skip Claude later record',
        timestamp: '2026-04-13T11:22:00.000Z',
        appName: 'Claude'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['Claude']
      })
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.fetched).toBe(3);
    expect(result.indexed).toBe(1);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-2']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-3',
      timestamp: '2026-04-13T11:22:00.000Z'
    });
  });

  it('skips excluded apps case-insensitively with locale-invariant normalization', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-iina',
        text: 'Skip IINA record',
        timestamp: '2026-04-13T11:20:00.000Z',
        appName: 'IINA'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['iina']
      })
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.fetched).toBe(1);
    expect(result.indexed).toBe(0);
    expect(vectorStore.upserts).toEqual([]);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-iina',
      timestamp: '2026-04-13T11:20:00.000Z'
    });
  });

  it('skips suppressed records while still advancing the checkpoint', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Suppressed paused record',
        timestamp: '2026-04-13T11:58:00.000Z',
        appName: 'Notes'
      },
      {
        id: 'record-2',
        text: 'Visible resumed record',
        timestamp: '2026-04-13T12:06:00.000Z',
        appName: 'Terminal'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
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

    const result = await service.runOnce(new Date('2026-04-13T12:10:00.000Z'));

    expect(result.fetched).toBe(2);
    expect(result.indexed).toBe(1);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-2']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-2',
      timestamp: '2026-04-13T12:06:00.000Z'
    });
  });

  it('skips suppressed offset-form timestamps while still advancing the checkpoint', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Suppressed paused record with offset timestamp',
        timestamp: '2026-04-13T20:00:00+08:00',
        appName: 'Notes'
      },
      {
        id: 'record-2',
        text: 'Visible resumed record with offset timestamp',
        timestamp: '2026-04-13T20:06:00+08:00',
        appName: 'Terminal'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
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

    const result = await service.runOnce(new Date('2026-04-13T12:10:00.000Z'));

    expect(result.fetched).toBe(2);
    expect(result.indexed).toBe(1);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-2']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-2',
      timestamp: '2026-04-13T20:06:00+08:00'
    });
  });

  it('stops indexing records captured after privacy is paused mid-run while still advancing the checkpoint', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Visible before pause',
        timestamp: '2026-04-13T11:20:00.000Z',
        appName: 'Terminal'
      },
      {
        id: 'record-2',
        text: 'Captured after pause',
        timestamp: '2026-04-13T11:26:00.000Z',
        appName: 'Terminal'
      }
    ]);
    const privacyState = new MutablePrivacyStateReader([
      {
        paused: false,
        excludedApps: []
      },
      {
        paused: true,
        excludedApps: [],
        pauseStartedAt: '2026-04-13T11:25:00.000Z'
      },
      {
        paused: true,
        excludedApps: [],
        pauseStartedAt: '2026-04-13T11:25:00.000Z'
      },
      {
        paused: true,
        excludedApps: [],
        pauseStartedAt: '2026-04-13T11:25:00.000Z'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
      privacyState
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.fetched).toBe(2);
    expect(result.indexed).toBe(1);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-1']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-2',
      timestamp: '2026-04-13T11:26:00.000Z'
    });
  });

  it('re-indexes earlier blocked records when privacy becomes less restrictive mid-batch', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Earlier Claude record',
        timestamp: '2026-04-13T11:20:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-2',
        text: 'Later Terminal record',
        timestamp: '2026-04-13T11:21:00.000Z',
        appName: 'Terminal'
      }
    ]);
    const privacyState = new MutablePrivacyStateReader([
      {
        paused: false,
        excludedApps: []
      },
      {
        paused: false,
        excludedApps: ['Claude']
      },
      {
        paused: false,
        excludedApps: ['Claude']
      },
      {
        paused: false,
        excludedApps: []
      },
      {
        paused: false,
        excludedApps: []
      },
      {
        paused: false,
        excludedApps: []
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
      privacyState
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.fetched).toBe(2);
    expect(result.indexed).toBe(2);
    expect(vectorStore.upserts).toHaveLength(1);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-1', 'record-2']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-2',
      timestamp: '2026-04-13T11:21:00.000Z'
    });
  });

  it('applies newly excluded apps before embedding later records in the same batch', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Visible terminal record',
        timestamp: '2026-04-13T11:20:00.000Z',
        appName: 'Terminal'
      },
      {
        id: 'record-2',
        text: 'Late excluded Claude record',
        timestamp: '2026-04-13T11:21:00.000Z',
        appName: 'Claude'
      }
    ]);
    const privacyState = new MutablePrivacyStateReader([
      {
        paused: false,
        excludedApps: []
      },
      {
        paused: false,
        excludedApps: []
      },
      {
        paused: false,
        excludedApps: []
      },
      {
        paused: false,
        excludedApps: ['Claude']
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
      privacyState
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.fetched).toBe(2);
    expect(result.indexed).toBe(1);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-1']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-2',
      timestamp: '2026-04-13T11:21:00.000Z'
    });
  });

  it('stops indexing offset-form timestamps captured after privacy is paused mid-run', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Visible before offset pause',
        timestamp: '2026-04-13T20:24:00+08:00',
        appName: 'Terminal'
      },
      {
        id: 'record-2',
        text: 'Captured after offset pause',
        timestamp: '2026-04-13T20:26:00+08:00',
        appName: 'Terminal'
      }
    ]);
    const privacyState = new MutablePrivacyStateReader([
      {
        paused: false,
        excludedApps: []
      },
      {
        paused: true,
        excludedApps: [],
        pauseStartedAt: '2026-04-13T12:25:00.000Z'
      },
      {
        paused: true,
        excludedApps: [],
        pauseStartedAt: '2026-04-13T12:25:00.000Z'
      },
      {
        paused: true,
        excludedApps: [],
        pauseStartedAt: '2026-04-13T12:25:00.000Z'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
      privacyState
    });

    const result = await service.runOnce(new Date('2026-04-13T12:30:00.000Z'));

    expect(result.fetched).toBe(2);
    expect(result.indexed).toBe(1);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-1']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-2',
      timestamp: '2026-04-13T20:26:00+08:00'
    });
  });

  it('re-checks privacy after embedding before persisting records', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Hidden after embed',
        timestamp: '2026-04-13T11:20:00.000Z',
        appName: 'Claude'
      }
    ]);
    const privacyRef: { current: PrivacyState } = {
      current: {
        paused: false,
        excludedApps: []
      }
    };
    const service = createIndexingService({
      embeddingProvider: new MutatingPrivacyEmbeddingProvider(privacyRef, {
        paused: false,
        excludedApps: ['Claude']
      }),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
      privacyState: new MutablePrivacyRefReader(privacyRef)
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.fetched).toBe(1);
    expect(result.indexed).toBe(0);
    expect(vectorStore.upserts).toEqual([]);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-1',
      timestamp: '2026-04-13T11:20:00.000Z'
    });
  });


  it('re-reads privacy before checkpointing a fully hidden batch', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Temporarily hidden note',
        timestamp: '2026-04-13T11:20:00.000Z',
        appName: 'Claude'
      }
    ]);
    const privacyState = new MutablePrivacyStateReader([
      {
        paused: false,
        excludedApps: []
      },
      {
        paused: false,
        excludedApps: ['Claude']
      },
      {
        paused: false,
        excludedApps: []
      },
      {
        paused: false,
        excludedApps: []
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
      privacyState
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.fetched).toBe(1);
    expect(result.indexed).toBe(1);
    expect(vectorStore.upserts).toHaveLength(1);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-1']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-1',
      timestamp: '2026-04-13T11:20:00.000Z'
    });
  });
  it('fails closed when privacy persistence is unreadable', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Readable without privacy state',
        timestamp: '2026-04-13T11:20:00.000Z',
        appName: 'Claude'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new StubEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
      privacyState: new ThrowingPrivacyStateReader()
    });

    await expect(service.runOnce(new Date('2026-04-13T12:00:00.000Z'))).rejects.toThrow(
      'Privacy controls could not be loaded while processing indexing.'
    );
    expect(vectorStore.upserts).toEqual([]);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
  });


  it('continues indexing other records when one embedding fails', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Good one',
        timestamp: '2026-04-13T11:20:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-2',
        text: 'Bad one',
        timestamp: '2026-04-13T11:21:00.000Z',
        appName: 'Claude'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new PartiallyFailingEmbeddingProvider(new Set(['Bad one'])),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.indexed).toBe(1);
    expect(vectorStore.upserts).toHaveLength(1);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-1']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-1',
      timestamp: '2026-04-13T11:20:00.000Z'
    });
  });

  it('continues indexing later successful records and advances checkpoint to the last success', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Good one',
        timestamp: '2026-04-13T11:20:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-2',
        text: 'Bad one',
        timestamp: '2026-04-13T11:21:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-3',
        text: 'Good two',
        timestamp: '2026-04-13T11:22:00.000Z',
        appName: 'Claude'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new PartiallyFailingEmbeddingProvider(new Set(['Bad one'])),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));

    expect(result.indexed).toBe(2);
    expect(vectorStore.upserts).toHaveLength(1);
    expect(vectorStore.upserts[0]?.map((record) => record.id)).toEqual(['record-1', 'record-3']);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-3',
      timestamp: '2026-04-13T11:22:00.000Z'
    });
  });

  it('does not checkpoint past a failed embedding when later blocked records remain', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:49:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Good one',
        timestamp: '2026-04-13T11:50:00.000Z',
        appName: 'Notes'
      },
      {
        id: 'record-2',
        text: 'Bad one',
        timestamp: '2026-04-13T11:51:00.000Z',
        appName: 'Notes'
      },
      {
        id: 'record-3',
        text: 'Hidden one',
        timestamp: '2026-04-13T11:52:00.000Z',
        appName: 'Claude'
      },
      {
        id: 'record-4',
        text: 'Hidden two',
        timestamp: '2026-04-13T11:53:00.000Z',
        appName: 'Claude'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new PartiallyFailingEmbeddingProvider(new Set(['Bad one'])),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['Claude']
      })
    });

    const result = await service.runOnce(new Date('2026-04-13T12:00:00.000Z'));
    expect(result.indexed).toBe(1);
    expect(vectorStore.upserts).toEqual([
      [
        expect.objectContaining({ id: 'record-1' })
      ]
    ]);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-1',
      timestamp: '2026-04-13T11:50:00.000Z'
    });
  });

  it('fails the run when late privacy filtering removes all persisted writes after an earlier embedding failure', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Bad one',
        timestamp: '2026-04-13T11:20:00.000Z',
        appName: 'Notes'
      },
      {
        id: 'record-2',
        text: 'Good one',
        timestamp: '2026-04-13T11:21:00.000Z',
        appName: 'Notes'
      }
    ]);
    const privacyRef: { current: PrivacyState } = {
      current: {
        paused: false,
        excludedApps: []
      }
    };
    const service = createIndexingService({
      embeddingProvider: {
        kind: 'late-privacy-filter',
        async embed(input: string): Promise<number[]> {
          if (input === 'Bad one') {
            throw new Error('embedding failed for Bad one');
          }

          privacyRef.current = {
            paused: false,
            excludedApps: ['Notes']
          };
          return [input.length, 3, 0];
        }
      },
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10,
      privacyState: new MutablePrivacyRefReader(privacyRef)
    });

    await expect(service.runOnce(new Date('2026-04-13T12:00:00.000Z'))).rejects.toThrow('embedding failed for Bad one');
    expect(vectorStore.upserts).toEqual([]);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
  });

  it('fails the run when every embedding in the batch fails', async () => {
    const vectorStore = new RecordingVectorStore();
    const checkpointStore = new StubCheckpointStore({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
    const screenpipeClient = new StubScreenpipeClient([
      {
        id: 'record-1',
        text: 'Always broken',
        timestamp: '2026-04-13T11:20:00.000Z',
        appName: 'Claude'
      }
    ]);
    const service = createIndexingService({
      embeddingProvider: new AlwaysFailingEmbeddingProvider(),
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessWindowMinutes: 15,
      maxCatchUpBatches: 3,
      maxCatchUpRecords: 10
    });

    await expect(service.runOnce(new Date('2026-04-13T12:00:00.000Z'))).rejects.toThrow('embedding unavailable');
    expect(vectorStore.upserts).toEqual([]);
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'record-0',
      timestamp: '2026-04-13T11:10:00.000Z'
    });
  });
});
