import { describe, expect, it } from 'vitest';

import type { PrivacyState, PrivacyStateReader } from '../../../src/services/privacy/types.js';
import { createFreshnessPolicy } from '../../../src/services/retrieval/freshness-policy.js';
import { createRecentActivityService } from '../../../src/services/retrieval/recent-activity-service.js';
import { createSearchScreenService } from '../../../src/services/retrieval/search-screen-service.js';
import type {
  CheckpointStore,
  EmbeddingProvider,
  ScreenpipeClient,
  ScreenpipeRecord,
  VectorSearchRequest,
  VectorStore
} from '../../../src/services/retrieval/types.js';

class StubCheckpointStore implements CheckpointStore {
  async readLatest() {
    return {
      cursor: 'checkpoint-1',
      timestamp: '2026-04-13T11:58:00.000Z'
    };
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

class FailingEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'failing';

  async embed(): Promise<number[]> {
    throw new Error('embedding unavailable');
  }
}

class HealthyEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'healthy';

  async embed(): Promise<number[]> {
    return [0.9, 0.1, 0];
  }
}

class KeywordFallbackScreenpipeClient implements ScreenpipeClient {
  async search(): Promise<ScreenpipeRecord[]> {
    return [
      {
        id: 'keyword-fallback-1',
        text: 'Keyword fallback result from screen history',
        timestamp: '2026-04-13T11:44:00.000Z',
        appName: 'Claude'
      }
    ];
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    return [];
  }
}

class SemanticFallbackScreenpipeClient implements ScreenpipeClient {
  async search(): Promise<ScreenpipeRecord[]> {
    return [
      {
        id: 'semantic-keyword-fallback-1',
        text: 'Keyword fallback for semantic mode',
        timestamp: '2026-04-13T11:45:00.000Z',
        appName: 'Claude'
      }
    ];
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    return [];
  }
}

class EmptyScreenpipeClient implements ScreenpipeClient {
  async search(): Promise<ScreenpipeRecord[]> {
    return [];
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    return [];
  }
}

class FailingScreenpipeClient implements ScreenpipeClient {
  async search(): Promise<ScreenpipeRecord[]> {
    throw new Error('screenpipe unavailable');
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    throw new Error('screenpipe unavailable');
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

class PausedWindowScreenpipeClient implements ScreenpipeClient {
  async search(): Promise<ScreenpipeRecord[]> {
    return [
      {
        id: 'paused-visible-search',
        text: 'Visible search record before pause',
        timestamp: '2026-04-13T11:50:00.000Z',
        appName: 'Notes'
      },
      {
        id: 'paused-hidden-search',
        text: 'Hidden search record during pause',
        timestamp: '2026-04-13T11:57:00.000Z',
        appName: 'Claude'
      }
    ];
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    return [
      {
        id: 'paused-visible-recent',
        text: 'Visible recent record before pause',
        timestamp: '2026-04-13T11:50:00.000Z',
        appName: 'Notes'
      },
      {
        id: 'paused-hidden-recent',
        text: 'Hidden recent record during pause',
        timestamp: '2026-04-13T11:57:00.000Z',
        appName: 'Claude'
      }
    ];
  }
}

class PartialFailureScreenpipeClient implements ScreenpipeClient {
  constructor(private readonly firstPage: ScreenpipeRecord[]) {}

  async search(request?: { offset?: number }): Promise<ScreenpipeRecord[]> {
    if ((request?.offset ?? 0) === 0) {
      return this.firstPage;
    }

    throw new Error('screenpipe page failed');
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    return [];
  }
}

class RecordingVectorStore implements VectorStore {
  readonly kind = 'recording-vector';
  readonly queryCalls: VectorSearchRequest[] = [];

  constructor(private readonly results: Array<{ id: string; text: string; timestamp: string; appName?: string; score?: number }>) {}

  async upsert(): Promise<void> {}

  async reset(): Promise<void> {}

  async query(request: VectorSearchRequest) {
    this.queryCalls.push(request);
    const limit = request.limit ?? this.results.length;
    const offset = request.offset ?? 0;

    return this.results.slice(offset, offset + limit).map((result) => ({
      ...result,
      source: 'semantic' as const
    }));
  }
}

class StubVectorStore implements VectorStore {
  readonly kind = 'stub-vector';

  constructor(private readonly results: Array<{ id: string; text: string; timestamp: string; appName?: string; score?: number }> = []) {}

  async upsert(): Promise<void> {}

  async reset(): Promise<void> {}

  async query() {
    return this.results.map((result) => ({
      ...result,
      source: 'semantic' as const
    }));
  }
}

class FailingVectorStore implements VectorStore {
  readonly kind = 'failing-vector';

  async upsert(): Promise<void> {}

  async reset(): Promise<void> {}

  async query(): Promise<never> {
    throw new Error('vector store unavailable');
  }
}

class ThrowingVectorStore implements VectorStore {
  readonly kind = 'throwing-vector';

  async upsert(): Promise<void> {}

  async reset(): Promise<void> {}

  async query(): Promise<never> {
    throw new Error('vector store should not be called while paused');
  }
}

describe('retrieval degraded behavior', () => {
  it('falls back to keyword results with degraded metadata when embeddings fail in hybrid mode', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new FailingEmbeddingProvider(),
      screenpipeClient: new KeywordFallbackScreenpipeClient(),
      vectorStore: new StubVectorStore(),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 })
    });

    const result = await service.search({
      query: 'fallback',
      mode: 'hybrid'
    });

    expect(result.error).toBeUndefined();
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.source).toBe('keyword');
    expect(result.degraded).toEqual({
      reason: 'Embedding provider failed; returned keyword-backed results instead.',
      fallbackMode: 'keyword'
    });
  });

  it('falls back to keyword results when embeddings fail in semantic mode', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new FailingEmbeddingProvider(),
      screenpipeClient: new SemanticFallbackScreenpipeClient(),
      vectorStore: new StubVectorStore(),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 })
    });

    const result = await service.search({
      query: 'fallback',
      mode: 'semantic'
    });

    expect(result.error).toBeUndefined();
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.source).toBe('keyword');
    expect(result.degraded).toEqual({
      reason: 'Embedding provider failed; returned keyword-backed results instead.',
      fallbackMode: 'keyword'
    });
  });

  it('does not misreport degradation when keyword search succeeds with zero results in hybrid mode', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new HealthyEmbeddingProvider(),
      screenpipeClient: new EmptyScreenpipeClient(),
      vectorStore: new StubVectorStore([
        {
          id: 'semantic-only-1',
          text: 'Semantic-only result',
          timestamp: '2026-04-13T11:43:00.000Z',
          appName: 'Claude',
          score: 0.92
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 })
    });

    const result = await service.search({
      query: 'semantic-only',
      mode: 'hybrid'
    });

    expect(result.error).toBeUndefined();
    expect(result.degraded).toBeUndefined();
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.source).toBe('semantic');
  });

  it('falls back to semantic results when Screenpipe keyword search fails in hybrid mode', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new HealthyEmbeddingProvider(),
      screenpipeClient: new FailingScreenpipeClient(),
      vectorStore: new StubVectorStore([
        {
          id: 'semantic-fallback-1',
          text: 'Previously indexed semantic result',
          timestamp: '2026-04-13T11:43:00.000Z',
          appName: 'Claude',
          score: 0.92
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 })
    });

    const result = await service.search({
      query: 'fallback',
      mode: 'hybrid'
    });

    expect(result.error).toBeUndefined();
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.source).toBe('semantic');
    expect(result.degraded).toEqual({
      reason: 'Screenpipe search failed; returned semantic-backed results instead.',
      fallbackMode: 'semantic'
    });
  });

  it('returns a retrieval error when semantic vector lookup fails', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new HealthyEmbeddingProvider(),
      screenpipeClient: new EmptyScreenpipeClient(),
      vectorStore: new FailingVectorStore(),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 })
    });

    const result = await service.search({
      query: 'vector-failure',
      mode: 'semantic'
    });

    expect(result.degraded).toBeUndefined();
    expect(result.evidence).toEqual([]);
    expect(result.error).toEqual({
      code: 'RETRIEVAL_FAILED',
      message: 'Semantic retrieval failed while querying the local vector store.',
      action: 'Verify the local vector store is available and retry the query.'
    });
  });

  it('falls back to keyword results when semantic vector lookup fails in hybrid mode', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new HealthyEmbeddingProvider(),
      screenpipeClient: new KeywordFallbackScreenpipeClient(),
      vectorStore: new FailingVectorStore(),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 })
    });

    const result = await service.search({
      query: 'vector-failure',
      mode: 'hybrid'
    });

    expect(result.error).toBeUndefined();
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.source).toBe('keyword');
    expect(result.degraded).toEqual({
      reason: 'Semantic retrieval failed; returned keyword-backed results instead.',
      fallbackMode: 'keyword'
    });
  });

  it('preserves partial keyword results when a later keyword page fails in hybrid mode', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new HealthyEmbeddingProvider(),
      screenpipeClient: new PartialFailureScreenpipeClient([
        {
          id: 'keyword-visible-1',
          text: 'Keyword result one',
          timestamp: '2026-04-13T11:44:00.000Z',
          appName: 'Notes'
        },
        {
          id: 'keyword-visible-2',
          text: 'Keyword result two',
          timestamp: '2026-04-13T11:45:00.000Z',
          appName: 'Terminal'
        },
        {
          id: 'excluded-keyword-1',
          text: 'Keyword result three',
          timestamp: '2026-04-13T11:46:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-2',
          text: 'Keyword result four',
          timestamp: '2026-04-13T11:47:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-3',
          text: 'Keyword result five',
          timestamp: '2026-04-13T11:48:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-4',
          text: 'Keyword result six',
          timestamp: '2026-04-13T11:49:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-5',
          text: 'Keyword result seven',
          timestamp: '2026-04-13T11:50:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-6',
          text: 'Keyword result eight',
          timestamp: '2026-04-13T11:51:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-7',
          text: 'Keyword result nine',
          timestamp: '2026-04-13T11:52:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'excluded-keyword-8',
          text: 'Keyword result ten',
          timestamp: '2026-04-13T11:53:00.000Z',
          appName: 'Claude'
        }
      ]),
      vectorStore: new StubVectorStore([
        {
          id: 'semantic-fallback-1',
          text: 'Previously indexed semantic result',
          timestamp: '2026-04-13T11:43:00.000Z',
          appName: 'Claude',
          score: 0.92
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['Claude']
      })
    });

    const result = await service.search({
      query: 'fallback',
      mode: 'hybrid'
    });

    expect(result.error).toBeUndefined();
    expect(result.evidence.some((item) => item.id === 'keyword-visible-1')).toBe(true);
    expect(result.degraded).toEqual({
      reason: 'Screenpipe search returned partial keyword results before failing.'
    });
  });

  it('returns visible semantic results from a frozen bounded query in hybrid mode', async () => {
    const vectorStore = new RecordingVectorStore([
      {
        id: 'semantic-visible-1',
        text: 'Semantic result one',
        timestamp: '2026-04-13T11:44:00.000Z',
        appName: 'Notes',
        score: 0.99
      },
      {
        id: 'semantic-visible-2',
        text: 'Semantic result two',
        timestamp: '2026-04-13T11:45:00.000Z',
        appName: 'Terminal',
        score: 0.98
      },
      {
        id: 'excluded-semantic-1',
        text: 'Semantic result three',
        timestamp: '2026-04-13T11:46:00.000Z',
        appName: 'Claude',
        score: 0.97
      },
      {
        id: 'excluded-semantic-2',
        text: 'Semantic result four',
        timestamp: '2026-04-13T11:47:00.000Z',
        appName: 'Claude',
        score: 0.96
      },
      {
        id: 'excluded-semantic-3',
        text: 'Semantic result five',
        timestamp: '2026-04-13T11:48:00.000Z',
        appName: 'Claude',
        score: 0.95
      },
      {
        id: 'excluded-semantic-4',
        text: 'Semantic result six',
        timestamp: '2026-04-13T11:49:00.000Z',
        appName: 'Claude',
        score: 0.94
      },
      {
        id: 'excluded-semantic-5',
        text: 'Semantic result seven',
        timestamp: '2026-04-13T11:50:00.000Z',
        appName: 'Claude',
        score: 0.93
      },
      {
        id: 'excluded-semantic-6',
        text: 'Semantic result eight',
        timestamp: '2026-04-13T11:51:00.000Z',
        appName: 'Claude',
        score: 0.92
      },
      {
        id: 'excluded-semantic-7',
        text: 'Semantic result nine',
        timestamp: '2026-04-13T11:52:00.000Z',
        appName: 'Claude',
        score: 0.91
      },
      {
        id: 'excluded-semantic-8',
        text: 'Semantic result ten',
        timestamp: '2026-04-13T11:53:00.000Z',
        appName: 'Claude',
        score: 0.9
      }
    ]);
    const service = createSearchScreenService({
      embeddingProvider: new HealthyEmbeddingProvider(),
      screenpipeClient: new EmptyScreenpipeClient(),
      vectorStore,
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['Claude']
      })
    });

    const result = await service.search({
      query: 'semantic-only',
      mode: 'hybrid'
    });

    expect(result.error).toBeUndefined();
    expect(result.evidence.some((item) => item.id === 'semantic-visible-1')).toBe(true);
    expect(result.degraded).toBeUndefined();
    expect(vectorStore.queryCalls).toHaveLength(1);
    expect(vectorStore.queryCalls[0]).toMatchObject({ limit: 50, offset: 0 });
  });

  it('filters the active pause window instead of reporting degraded search errors', async () => {
    const service = createSearchScreenService({
      embeddingProvider: new HealthyEmbeddingProvider(),
      screenpipeClient: new PausedWindowScreenpipeClient(),
      vectorStore: new ThrowingVectorStore(),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: true,
        excludedApps: [],
        pauseStartedAt: '2026-04-13T11:55:00.000Z'
      })
    });

    const result = await service.search({
      query: 'pause',
      mode: 'keyword'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['paused-visible-search']);
    expect(result.error).toBeUndefined();
    expect(result.degraded).toBeUndefined();
  });

  it('returns an actionable error when Screenpipe is unavailable', async () => {
    const service = createRecentActivityService({
      screenpipeClient: new FailingScreenpipeClient(),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 })
    });

    const result = await service.getRecentActivity({
      minutes: 60,
      format: 'summary'
    });

    expect(result.evidence).toEqual([]);
    expect(result.error).toEqual({
      code: 'SCREENPIPE_UNAVAILABLE',
      message: 'Screenpipe recent activity retrieval failed.',
      action: 'Verify the local Screenpipe service is running and retry the request.'
    });
  });

  it('filters the active pause window instead of reporting recent-activity outages', async () => {
    const service = createRecentActivityService({
      screenpipeClient: new PausedWindowScreenpipeClient(),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: true,
        excludedApps: [],
        pauseStartedAt: '2026-04-13T11:55:00.000Z'
      })
    });

    const result = await service.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['paused-visible-recent']);
    expect(result.raw?.map((item) => item.id)).toEqual(['paused-visible-recent']);
    expect(result.error).toBeUndefined();
  });
});
