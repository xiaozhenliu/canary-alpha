import { createServer } from 'node:http';

import { afterAll, describe, expect, it } from 'vitest';

import { createEmbeddingProvider } from '../../../src/services/retrieval/provider-factory.js';

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
        port: 8765
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
        path: '/tmp/provider-concurrency-test'
      },
      retrieval: {
        freshnessWindowMinutes: 15,
        pollIntervalSeconds: 30,
        maxCatchUpBatches: 3,
        maxCatchUpRecords: 500
      },
      paths: {
        configFile: '/tmp/provider-concurrency-test.yaml',
        logDirectory: '/tmp/logs',
        serviceLogFile: '/tmp/logs/service.log'
      },
      routines: {
        enabled: false,
        definitionsPath: '/tmp/routines/definitions',
        historyPath: '/tmp/routines/history'
      },
      trim: { enabled: true, intervalSeconds: 600 }
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
