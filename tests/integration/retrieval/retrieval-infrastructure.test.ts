import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { createEmbeddingProvider } from '../../../src/services/retrieval/provider-factory.js';
import {
  FileBackedVectorStore,
  InMemoryVectorStore,
  resolveVectorStoreDirectory
} from '../../../src/services/retrieval/vector-store.js';
import { createTempVectorStorePath } from '../../helpers/temp-vector-store.js';

const servers: Array<() => Promise<void>> = [];

afterAll(async () => {
  while (servers.length > 0) {
    const stop = servers.pop();
    if (stop) {
      await stop();
    }
  }
});

describe('retrieval infrastructure correctness', () => {
  it('parses OpenAI-compatible embedding responses', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        object: 'list',
        data: [
          {
            object: 'embedding',
            index: 0,
            embedding: [0.5, 0.25, 0.125]
          }
        ],
        model: 'text-embedding-3-small'
      }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    servers.push(async () => {
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
      throw new Error('Failed to bind embedding test server.');
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
          baseUrl: `http://127.0.0.1:${address.port}`,
          model: 'text-embedding-3-small'
        }
      },
      vectorStore: {
        kind: 'chroma',
        path: '/tmp/retrieval-provider-test'
      },
      retrieval: {
        freshnessWindowMinutes: 15,
        pollIntervalSeconds: 30,
        maxCatchUpBatches: 3,
        maxCatchUpRecords: 500
      },
      paths: {
        configFile: '/tmp/retrieval-provider-test.yaml',
        logDirectory: '/tmp/logs',
        serviceLogFile: '/tmp/logs/service.log'
      },
        trim: { enabled: true, intervalSeconds: 600 }
    });

    await expect(provider.embed('hello world')).resolves.toEqual([0.5, 0.25, 0.125]);
  });

  it('ranks semantic matches using the query embedding', async () => {
    const store = new InMemoryVectorStore({
      kind: 'chroma',
      path: '/tmp/retrieval-vector-test'
    });

    await store.upsert([
      {
        id: 'vector-a',
        text: 'Aligned vector',
        timestamp: '2026-04-13T11:10:00.000Z',
        appName: 'Claude',
        embedding: [1, 0, 0]
      },
      {
        id: 'vector-b',
        text: 'Partially aligned vector',
        timestamp: '2026-04-13T11:11:00.000Z',
        appName: 'Claude',
        embedding: [0.5, 0.4, 0]
      },
      {
        id: 'vector-c',
        text: 'Different app',
        timestamp: '2026-04-13T11:12:00.000Z',
        appName: 'Screenpipe',
        embedding: [0.9, 0, 0]
      }
    ]);

    const results = await store.query({
      queryEmbedding: [1, 0, 0],
      appName: 'Claude',
      limit: 2
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('vector-a');
    expect(results[1]?.id).toBe('vector-b');
    expect((results[0]?.score ?? 0)).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it('applies offset after semantic ranking', async () => {
    const store = new InMemoryVectorStore({
      kind: 'chroma',
      path: '/tmp/retrieval-vector-offset-test'
    });

    await store.upsert([
      {
        id: 'vector-a',
        text: 'Best match',
        timestamp: '2026-04-13T11:10:00.000Z',
        appName: 'Claude',
        embedding: [1, 0, 0]
      },
      {
        id: 'vector-b',
        text: 'Second match',
        timestamp: '2026-04-13T11:11:00.000Z',
        appName: 'Claude',
        embedding: [0.8, 0, 0]
      },
      {
        id: 'vector-c',
        text: 'Third match',
        timestamp: '2026-04-13T11:12:00.000Z',
        appName: 'Claude',
        embedding: [0.7, 0, 0]
      }
    ]);

    const results = await store.query({
      queryEmbedding: [1, 0, 0],
      appName: 'Claude',
      limit: 1,
      offset: 1
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('vector-b');
  });

  it('applies semantic time filters using instants for offset timestamps', async () => {
    const store = new InMemoryVectorStore({
      kind: 'chroma',
      path: '/tmp/retrieval-vector-time-filter-test'
    });

    await store.upsert([
      {
        id: 'vector-offset-early',
        text: 'Before UTC window',
        timestamp: '2026-04-13T19:59:00+08:00',
        appName: 'Claude',
        embedding: [1, 0, 0]
      },
      {
        id: 'vector-offset-match',
        text: 'Inside UTC window',
        timestamp: '2026-04-13T20:01:00+08:00',
        appName: 'Claude',
        embedding: [0.8, 0, 0]
      },
      {
        id: 'vector-offset-late',
        text: 'After UTC window',
        timestamp: '2026-04-13T20:07:00+08:00',
        appName: 'Claude',
        embedding: [0.7, 0, 0]
      }
    ]);

    const results = await store.query({
      queryEmbedding: [1, 0, 0],
      appName: 'Claude',
      from: '2026-04-13T12:00:00.000Z',
      to: '2026-04-13T12:05:00.000Z',
      limit: 5
    });

    expect(results.map((item) => item.id)).toEqual(['vector-offset-match']);
  });

  it('reports an empty but readable persisted vector store with recordCount 0', async () => {
    const tempStore = await createTempVectorStorePath('retrieval-empty-inspect-store-');

    try {
      const store = new FileBackedVectorStore(
        { kind: 'chroma', path: tempStore.path },
        `${tempStore.path}/vector-store.json`
      );

      await writeFile(`${tempStore.path}/vector-store.json`, JSON.stringify({ records: [] }, null, 2), 'utf8');

      await expect(store.inspect()).resolves.toEqual({
        persisted: false,
        readable: true,
        recordCount: 0
      });
    } finally {
      await tempStore.cleanup();
    }
  });

  it('persists vector records across store instances', async () => {
    const tempStore = await createTempVectorStorePath('retrieval-persisted-store-');

    try {
      const firstStore = new FileBackedVectorStore(
        { kind: 'chroma', path: tempStore.path },
        `${tempStore.path}/vector-store.json`
      );

      await firstStore.upsert([
        {
          id: 'persisted-1',
          text: 'Persisted semantic note',
          timestamp: '2026-04-13T11:30:00.000Z',
          appName: 'Claude',
          embedding: [0.9, 0.1, 0]
        }
      ]);
      await firstStore.close();

      const secondStore = new FileBackedVectorStore(
        { kind: 'chroma', path: tempStore.path },
        `${tempStore.path}/vector-store.json`
      );

      const results = await secondStore.query({
        queryEmbedding: [1, 0, 0],
        limit: 5
      });

      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe('persisted-1');
      await secondStore.close();
    } finally {
      await tempStore.cleanup();
    }
  });

  it('keeps inspection readable while a persisted store is rewritten atomically', async () => {
    const tempStore = await createTempVectorStorePath('retrieval-atomic-inspect-');

    try {
      const filePath = join(tempStore.path, 'vector-store.json');
      const store = new FileBackedVectorStore(
        { kind: 'chroma', path: tempStore.path },
        filePath
      );

      await store.upsert([
        {
          id: 'persisted-atomic-1',
          text: 'Persisted semantic note',
          timestamp: '2026-04-13T11:30:00.000Z',
          appName: 'Claude',
          embedding: [0.9, 0.1, 0]
        }
      ]);

      await expect(store.inspect?.()).resolves.toEqual({
        persisted: true,
        readable: true,
        recordCount: 1
      });

      await store.upsert(Array.from({ length: 40 }, (_, index) => ({
        id: `persisted-atomic-${index + 2}`,
        text: `Persisted semantic note ${'x'.repeat(500)}-${index}`,
        timestamp: '2026-04-13T11:31:00.000Z',
        appName: 'Claude',
        embedding: [0.9, 0.1, 0]
      })));

      await expect(store.inspect?.()).resolves.toEqual({
        persisted: true,
        readable: true,
        recordCount: 41
      });
      await store.close();
    } finally {
      await tempStore.cleanup();
    }
  });

  it('treats a large valid vector-store file as persisted and readable during inspection', async () => {
    const tempStore = await createTempVectorStorePath('retrieval-large-persisted-store-');

    try {
      const filePath = join(tempStore.path, 'vector-store.json');
      const records = Array.from({ length: 80 }, (_, index) => ({
        id: `persisted-${index}`,
        text: `Persisted semantic note ${'x'.repeat(1000)}-${index}`,
        timestamp: '2026-04-13T11:30:00.000Z',
        appName: 'Claude',
        embedding: [0.9, 0.1, 0]
      }));
      await writeFile(
        filePath,
        JSON.stringify({ records }, null, 2),
        'utf8'
      );

      const store = new FileBackedVectorStore(
        { kind: 'chroma', path: tempStore.path },
        filePath
      );

      await expect(store.inspect?.()).resolves.toEqual({
        persisted: true,
        readable: true,
        recordCount: 80
      });
      await store.close();
    } finally {
      await tempStore.cleanup();
    }
  });

  it('treats an empty persisted vector-store payload as readable but not recovered', async () => {
    const tempStore = await createTempVectorStorePath('retrieval-empty-persisted-store-');

    try {
      const filePath = join(tempStore.path, 'vector-store.json');
      await writeFile(
        filePath,
        JSON.stringify({ records: [] }, null, 2),
        'utf8'
      );

      const store = new FileBackedVectorStore(
        { kind: 'chroma', path: tempStore.path },
        filePath
      );

      await expect(store.inspect?.()).resolves.toEqual({
        persisted: false,
        readable: true,
        recordCount: 0
      });
      await store.close();
    } finally {
      await tempStore.cleanup();
    }
  });

  it('treats a zero-byte persisted vector-store file as unreadable corruption', async () => {
    const tempStore = await createTempVectorStorePath('retrieval-zero-byte-store-');

    try {
      const filePath = join(tempStore.path, 'vector-store.json');
      await writeFile(filePath, '', 'utf8');

      const store = new FileBackedVectorStore(
        { kind: 'chroma', path: tempStore.path },
        filePath
      );

      await expect(store.inspect?.()).resolves.toEqual({
        persisted: true,
        readable: false,
        recordCount: 0
      });
      await expect(store.query({
        queryEmbedding: [1, 0, 0],
        limit: 5
      })).rejects.toThrow('Failed to load vector store');
    } finally {
      await tempStore.cleanup();
    }
  });

  it('treats malformed persisted vector-store payloads as unreadable during inspection', async () => {
    const tempStore = await createTempVectorStorePath('retrieval-malformed-persisted-store-');

    try {
      const filePath = join(tempStore.path, 'vector-store.json');
      await writeFile(
        filePath,
        JSON.stringify({ records: 'oops' }, null, 2),
        'utf8'
      );

      const store = new FileBackedVectorStore(
        { kind: 'chroma', path: tempStore.path },
        filePath
      );

      await expect(store.inspect?.()).resolves.toEqual({
        persisted: true,
        readable: false
      });
      await expect(store.query({
        queryEmbedding: [1, 0, 0],
        limit: 5
      })).rejects.toThrow('Failed to load vector store');
    } finally {
      await tempStore.cleanup();
    }
  });

  it('waits for the initial persisted load before applying concurrent writes', async () => {
    const tempStore = await createTempVectorStorePath('retrieval-concurrent-load-');
    let releaseRead: (() => void) | null = null;
    let signalReadStarted: (() => void) | null = null;
    const releaseDelayedRead = () => {
      if (releaseRead) {
        releaseRead();
      }
    };
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const allowRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    try {
      const filePath = join(tempStore.path, 'vector-store.json');
      await writeFile(
        filePath,
        JSON.stringify(
          {
            records: [
              {
                id: 'persisted-1',
                text: 'Persisted before concurrent access',
                timestamp: '2026-04-13T11:30:00.000Z',
                appName: 'Claude',
                embedding: [1, 0, 0]
              }
            ]
          },
          null,
          2
        ),
        'utf8'
      );

      vi.resetModules();
      vi.doMock('node:fs/promises', async () => {
        const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

        return {
          ...actualFs,
          readFile: vi.fn(async (delayedFilePath: string, encoding: BufferEncoding) => {
            signalReadStarted?.();
            await allowRead;
            return actualFs.readFile(delayedFilePath, encoding);
          })
        };
      });

      const { FileBackedVectorStore: ConcurrentFileBackedVectorStore } = await import(
        '../../../src/services/retrieval/vector-store.js'
      );

      const store = new ConcurrentFileBackedVectorStore(
        { kind: 'chroma', path: tempStore.path },
        filePath
      );

      const initialQuery = store.query({
        queryEmbedding: [1, 0, 0],
        limit: 5
      });

      await readStarted;

      const concurrentUpsert = store.upsert([
        {
          id: 'concurrent-1',
          text: 'Written during initial load',
          timestamp: '2026-04-13T11:31:00.000Z',
          appName: 'Claude',
          embedding: [0.8, 0.2, 0]
        }
      ]);

      releaseDelayedRead();

      await Promise.all([initialQuery, concurrentUpsert]);

      const results = await store.query({
        queryEmbedding: [1, 0, 0],
        limit: 5
      });

      expect(results).toHaveLength(2);
      expect(results.map((item) => item.id).sort()).toEqual(['concurrent-1', 'persisted-1']);
      await store.close();
    } finally {
      releaseDelayedRead();
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
      vi.restoreAllMocks();
      await tempStore.cleanup();
    }
  });

  it('re-checks the persisted vector-store file during inspection after the store has been loaded', async () => {
    const tempStore = await createTempVectorStorePath('retrieval-inspect-reloads-persisted-state-');

    try {
      const filePath = join(tempStore.path, 'vector-store.json');
      const store = new FileBackedVectorStore(
        { kind: 'chroma', path: tempStore.path },
        filePath
      );

      await store.upsert([
        {
          id: 'persisted-1',
          text: 'Persisted semantic note',
          timestamp: '2026-04-13T11:30:00.000Z',
          appName: 'Claude',
          embedding: [0.9, 0.1, 0]
        }
      ]);

      await store.query({
        queryEmbedding: [1, 0, 0],
        limit: 5
      });

      await writeFile(filePath, '', 'utf8');

      await expect(store.inspect?.()).resolves.toEqual({
        persisted: true,
        readable: false,
        recordCount: 0
      });
      await store.close();
    } finally {
      await tempStore.cleanup();
    }
  });

  it('defaults the vector store directory to the app home directory', () => {
    const directory = resolveVectorStoreDirectory({
      kind: 'chroma'
    });

    expect(directory.endsWith('/.screenpipe-memory-mcp')).toBe(true);
  });

  it('expands a tilde-prefixed vector store path into the user home directory', () => {
    const directory = resolveVectorStoreDirectory({
      kind: 'chroma',
      path: '~/.screenpipe-memory-mcp/chroma'
    });

    expect(directory).toBe(`${homedir()}/.screenpipe-memory-mcp/chroma`);
  });

  it('starts empty instead of seeding production fixture records', async () => {
    const store = new InMemoryVectorStore({
      kind: 'chroma',
      path: '/tmp/retrieval-empty-store-test'
    });

    const results = await store.query({
      queryEmbedding: [1, 0, 0],
      limit: 5
    });

    expect(results).toEqual([]);
  });
});
