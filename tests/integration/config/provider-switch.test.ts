import { describe, expect, it } from 'vitest';

import { createEmbeddingProvider } from '../../../src/services/retrieval/provider-factory.js';
import { createTempVectorStorePath } from '../../helpers/temp-vector-store.js';

describe('embedding provider factory', () => {
  it('switches provider adapters via providers.embeddings config only', async () => {
    const firstStore = await createTempVectorStorePath('provider-switch-openai-');
    const secondStore = await createTempVectorStorePath('provider-switch-ollama-');

    try {
      const openAiProvider = createEmbeddingProvider({
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
            kind: 'openai',
            baseUrl: 'https://api.openai.example/v1',
            model: 'text-embedding-3-large'
          }
        },
        vectorStore: {
          kind: 'chroma',
          path: firstStore.path
        },
        retrieval: {
          freshnessWindowMinutes: 15,
          pollIntervalSeconds: 30,
          maxCatchUpBatches: 3,
          maxCatchUpRecords: 500
        },
        paths: {
          configFile: '/tmp/openai-config.yaml',
          logDirectory: '/tmp/logs',
          serviceLogFile: '/tmp/logs/service.log'
        },
        trim: { enabled: true, intervalSeconds: 600 }
      });

      const ollamaProvider = createEmbeddingProvider({
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
            kind: 'ollama',
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'nomic-embed-text'
          }
        },
        vectorStore: {
          kind: 'chroma',
          path: secondStore.path
        },
        retrieval: {
          freshnessWindowMinutes: 15,
          pollIntervalSeconds: 30,
          maxCatchUpBatches: 3,
          maxCatchUpRecords: 500
        },
        paths: {
          configFile: '/tmp/ollama-config.yaml',
          logDirectory: '/tmp/logs',
          serviceLogFile: '/tmp/logs/service.log'
        },
        trim: { enabled: true, intervalSeconds: 600 }
      });

      expect(openAiProvider).not.toBe(ollamaProvider);
      expect(openAiProvider.kind).toBe('openai');
      expect(ollamaProvider.kind).toBe('ollama');
      expect(typeof openAiProvider.embed).toBe('function');
      expect(typeof ollamaProvider.embed).toBe('function');
      expect(openAiProvider.baseUrl).toBe('https://api.openai.example/v1');
      expect(ollamaProvider.baseUrl).toBe('http://127.0.0.1:11434/v1');
      expect(openAiProvider.model).toBe('text-embedding-3-large');
      expect(ollamaProvider.model).toBe('nomic-embed-text');
    } finally {
      await Promise.all([firstStore.cleanup(), secondStore.cleanup()]);
    }
  });
});
