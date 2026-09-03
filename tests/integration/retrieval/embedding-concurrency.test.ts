import { createServer } from 'node:http';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createEmbeddingProvider } from '../../../src/services/retrieval/provider-factory.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

const cleanup: Array<() => Promise<void>> = [];

afterAll(async () => {
  while (cleanup.length > 0) {
    const stop = cleanup.pop();
    if (stop) {
      await stop();
    }
  }
});

describe('embedding concurrency limit', () => {
  it('caps concurrent embedding requests at the configured limit', async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;

    const server = createServer((request, response) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

      request.resume();
      setTimeout(() => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          data: [
            {
              embedding: [0.1, 0.2, 0.3]
            }
          ]
        }));
        activeRequests -= 1;
      }, 50);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    cleanup.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind embedding concurrency test server.');
    }

    const provider = createEmbeddingProvider({
      server: {
        mode: 'stdio',
        host: '127.0.0.1',
        port: 8765,
        maxConnections: 10
      },
      logging: {
        level: 'info'
      },
      screenpipe: {
        url: 'http://127.0.0.1:3030'
      },
      providers: {
        embeddings: {
          kind: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: 'text-embedding-3-small',
          concurrency: 2
        }
      },
      vectorStore: {
        kind: 'chroma',
        path: join(testTempRoot(), 'provider-concurrency-test')
      },
      retrieval: {
        freshnessWindowMinutes: 15,
        pollIntervalSeconds: 30,
        maxCatchUpBatches: 3,
        maxCatchUpRecords: 500
      },
      paths: {
        configFile: join(testTempRoot(), 'provider-concurrency-test.yaml'),
        logDirectory: join(testTempRoot(), 'provider-concurrency-test-logs'),
        serviceLogFile: join(testTempRoot(), 'provider-concurrency-test-logs', 'service.log'),
        derivedDatabase: join(testTempRoot(), 'provider-concurrency-test', 'derived.sqlite')
      },
      routines: {
        enabled: false,
        definitionsPath: join(testTempRoot(), 'provider-concurrency-routines', 'definitions'),
        historyPath: join(testTempRoot(), 'provider-concurrency-routines', 'history')
      },
      trim: { enabled: true, intervalSeconds: 600 },
      capture: { provider: 'screenpipe', livenessThresholdSeconds: 120, permissionsGracePeriodSeconds: 60, ocrLanguages: ['english'] },
      storage: { diskBudgetBytes: null, retentionDays: 7 },
      privacy: { excludeApps: ['1Password', 'Keychain Access'], secureAxRoles: ['AXSecureTextField'] },
      analysis: {
        sessions: { idleThresholdSeconds: 120 },
        summary: { provider: 'template', remoteLlmTimeoutMs: 30000 },
        embeddings: { topK: 20, minScore: 0 }
      },
      llm: { model: 'gpt-4o-mini' }
    });

    const results = await Promise.all([
      provider.embed('one'),
      provider.embed('two'),
      provider.embed('three'),
      provider.embed('four'),
      provider.embed('five')
    ]);

    expect(results).toEqual([
      [0.1, 0.2, 0.3],
      [0.1, 0.2, 0.3],
      [0.1, 0.2, 0.3],
      [0.1, 0.2, 0.3],
      [0.1, 0.2, 0.3]
    ]);
    expect(maxActiveRequests).toBe(2);
  });
});
