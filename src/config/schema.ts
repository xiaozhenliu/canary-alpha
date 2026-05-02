import { z } from 'zod';

export const DEFAULT_EMBEDDING_CONCURRENCY = 2;

export const serverModeSchema = z.enum(['stdio', 'http']);
export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

const serverConfigSchema = z.object({
  mode: serverModeSchema.default('http'),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().positive().default(8765)
});

const loggingConfigSchema = z.object({
  level: logLevelSchema.default('info')
});

const screenpipeConfigSchema = z.object({
  url: z.string().optional(),
  apiKey: z.string().optional()
});

const embeddingsProviderSchema = z.object({
  kind: z.string().default('openai-compatible'),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  concurrency: z.number().int().positive().default(DEFAULT_EMBEDDING_CONCURRENCY)
});

const providersConfigSchema = z.object({
  embeddings: embeddingsProviderSchema.default({
    kind: 'openai-compatible',
    concurrency: DEFAULT_EMBEDDING_CONCURRENCY
  })
});

const vectorStoreConfigSchema = z.object({
  kind: z.string().default('chroma'),
  path: z.string().optional()
});

const trimConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalSeconds: z.number().int().positive().default(600)
});

const retrievalConfigSchema = z.object({
  freshnessWindowMinutes: z.number().int().positive().default(15),
  pollIntervalSeconds: z.number().int().positive().default(30),
  maxCatchUpBatches: z.number().int().positive().default(3),
  maxCatchUpRecords: z.number().int().positive().default(500)
});

const routinesConfigSchema = z.object({
  enabled: z.boolean().default(false),
  definitionsPath: z.string().optional(),
  historyPath: z.string().optional()
});

export const appConfigSchema = z.object({
  server: serverConfigSchema.default({
    mode: 'http',
    host: '127.0.0.1',
    port: 8765
  }),
  logging: loggingConfigSchema.default({
    level: 'info'
  }),
  screenpipe: screenpipeConfigSchema.default({}),
  providers: providersConfigSchema.default({
    embeddings: {
      kind: 'openai-compatible',
      concurrency: DEFAULT_EMBEDDING_CONCURRENCY
    }
  }),
  vectorStore: vectorStoreConfigSchema.default({
    kind: 'chroma'
  }),
  retrieval: retrievalConfigSchema.default({
    freshnessWindowMinutes: 15,
    pollIntervalSeconds: 30,
    maxCatchUpBatches: 3,
    maxCatchUpRecords: 500
  }),
  routines: routinesConfigSchema.default({ enabled: false }),
  trim: trimConfigSchema.default({ enabled: true, intervalSeconds: 600 })
});

export type RawAppConfig = z.infer<typeof appConfigSchema>;
