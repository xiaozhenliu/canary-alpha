import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createEmbeddingProvider } from '../../../src/services/retrieval/provider-factory.js';
import { createTempVectorStorePath } from '../../helpers/temp-vector-store.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

describe('embedding provider factory', () => {
  it('switches provider adapters via providers.embeddings config only', async () => {
    const firstStore = await createTempVectorStorePath('provider-switch-openai-');
    const secondStore = await createTempVectorStorePath('provider-switch-ollama-');

    try {
      const openAiProvider = createEmbeddingProvider({
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
          configFile: join(testTempRoot(), 'provider-switch-openai-config.yaml'),
          logDirectory: join(testTempRoot(), 'provider-switch-openai-logs'),
          serviceLogFile: join(testTempRoot(), 'provider-switch-openai-logs', 'service.log'),
          derivedDatabase: join(testTempRoot(), 'provider-switch-openai', 'derived.sqlite')
        },
        routines: {
          enabled: false,
          definitionsPath: join(testTempRoot(), 'provider-switch-openai-routines', 'definitions'),
          historyPath: join(testTempRoot(), 'provider-switch-openai-routines', 'history')
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

      const ollamaProvider = createEmbeddingProvider({
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
          configFile: join(testTempRoot(), 'provider-switch-ollama-config.yaml'),
          logDirectory: join(testTempRoot(), 'provider-switch-ollama-logs'),
          serviceLogFile: join(testTempRoot(), 'provider-switch-ollama-logs', 'service.log'),
          derivedDatabase: join(testTempRoot(), 'provider-switch-ollama', 'derived.sqlite')
        },
        routines: {
          enabled: false,
          definitionsPath: join(testTempRoot(), 'provider-switch-ollama-routines', 'definitions'),
          historyPath: join(testTempRoot(), 'provider-switch-ollama-routines', 'history')
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
