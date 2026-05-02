import { createServer } from 'node:http';

import { afterAll, describe, expect, it } from 'vitest';

import { createEmbeddingProvider } from '../../../src/services/retrieval/provider-factory.js';
import { createScreenpipeClient } from '../../../src/services/retrieval/screenpipe-client.js';

const cleanup: Array<() => Promise<void>> = [];

afterAll(async () => {
  while (cleanup.length > 0) {
    const stop = cleanup.pop();
    if (stop) {
      await stop();
    }
  }
});

describe('provider and retrieval URL handling', () => {
  it('preserves a provider base path such as /v1 when calling embeddings', async () => {
    let seenPath = '';

    const server = createServer((request, response) => {
      seenPath = request.url ?? '';
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        data: [
          {
            embedding: [0.1, 0.2, 0.3]
          }
        ]
      }));
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
      throw new Error('Failed to bind URL handling test server.');
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
        path: '/tmp/provider-url-test'
      },
      retrieval: {
        freshnessWindowMinutes: 15,
        pollIntervalSeconds: 30,
        maxCatchUpBatches: 3,
        maxCatchUpRecords: 500
      },
      paths: {
        configFile: '/tmp/provider-url-test.yaml',
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

    await provider.embed('hello');

    expect(seenPath).toBe('/v1/embeddings');
  });

  it('sends bearer authorization when an embedding apiKey is configured', async () => {
    let seenAuthorization = '';

    const server = createServer((request, response) => {
      seenAuthorization = request.headers.authorization ?? '';
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        data: [
          {
            embedding: [0.1, 0.2, 0.3]
          }
        ]
      }));
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
      throw new Error('Failed to bind auth header test server.');
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
          apiKey: 'secret-token'
        }
      },
      vectorStore: {
        kind: 'chroma',
        path: '/tmp/provider-auth-test'
      },
      retrieval: {
        freshnessWindowMinutes: 15,
        pollIntervalSeconds: 30,
        maxCatchUpBatches: 3,
        maxCatchUpRecords: 500
      },
      paths: {
        configFile: '/tmp/provider-auth-test.yaml',
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

    await provider.embed('hello');

    expect(seenAuthorization).toBe('Bearer secret-token');
  });

  it('preserves a Screenpipe base path prefix for search requests and forwards bearer auth', async () => {
    const seenPaths: string[] = [];
    const seenAuthorizations: string[] = [];

    const server = createServer((request, response) => {
      seenPaths.push(request.url ?? '');
      seenAuthorizations.push(request.headers.authorization ?? '');
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        data: [],
        pagination: {
          limit: 0,
          offset: 0,
          total: 0
        }
      }));
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
      throw new Error('Failed to bind Screenpipe URL handling test server.');
    }

    const client = createScreenpipeClient(`http://127.0.0.1:${address.port}/screenpipe`, 'screenpipe-secret');

    await client.search({ query: 'hello', limit: 10, offset: 20 });
    await client.recent(15);

    expect(seenPaths[0]).toBe('/screenpipe/search?content_type=ocr&limit=10&offset=20&q=hello');
    expect(seenPaths[1]).toContain('/screenpipe/search?content_type=ocr&limit=500&offset=0');
    expect(seenPaths[1]).toContain('start_time=');
    expect(seenPaths[1]).toContain('end_time=');
    expect(seenAuthorizations).toEqual(['Bearer screenpipe-secret', 'Bearer screenpipe-secret']);
  });
});
