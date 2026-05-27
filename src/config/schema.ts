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

export const captureConfigSchema = z.object({
  livenessThresholdSeconds: z.number().int().positive().default(120),
  permissionsGracePeriodSeconds: z.number().int().nonnegative().default(60)
});

export const storageConfigSchema = z.object({
  diskBudgetBytes: z.number().int().nonnegative().nullable().default(null),
  retentionDays: z.number().int().positive().default(7)
});

export const privacyConfigSchema = z.object({
  excludeApps: z.array(z.string()).default(['1Password', 'Keychain Access']),
  secureAxRoles: z.array(z.string()).default(['AXSecureTextField'])
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

// ---------------------------------------------------------------------------
// work-activity-analysis: analysis / llm / paths.derivedDatabase
// All fields default-valued to keep existing config.yaml backward compatible.
// ---------------------------------------------------------------------------

export const DEFAULT_ANALYSIS_IDLE_THRESHOLD_SECONDS = 120;
export const DEFAULT_ANALYSIS_REMOTE_LLM_TIMEOUT_MS = 30_000;
export const DEFAULT_ANALYSIS_EMBEDDINGS_TOP_K = 20;
export const DEFAULT_ANALYSIS_EMBEDDINGS_MIN_SCORE = 0.0;
export const DEFAULT_LLM_MODEL = 'deepseek-chat';

export const analysisSummaryProviderSchema = z.enum(['template', 'remote-llm']);

export const analysisSessionsSchema = z.object({
  idleThresholdSeconds: z.number().int().positive().default(DEFAULT_ANALYSIS_IDLE_THRESHOLD_SECONDS)
});

export const analysisSummarySchema = z.object({
  provider: analysisSummaryProviderSchema.default('template'),
  remoteLlmTimeoutMs: z.number().int().positive().default(DEFAULT_ANALYSIS_REMOTE_LLM_TIMEOUT_MS)
});

export const analysisEmbeddingsSchema = z.object({
  topK: z.number().int().positive().default(DEFAULT_ANALYSIS_EMBEDDINGS_TOP_K),
  // dot-product 没有上下界（embeddings 不一定归一化），这里只要求是有限实数；
  // 默认 0.0 表示不设阈值（详见 design §10）。
  minScore: z.number().finite().default(DEFAULT_ANALYSIS_EMBEDDINGS_MIN_SCORE)
});

export const analysisSchema = z.object({
  sessions: analysisSessionsSchema.default({
    idleThresholdSeconds: DEFAULT_ANALYSIS_IDLE_THRESHOLD_SECONDS
  }),
  summary: analysisSummarySchema.default({
    provider: 'template',
    remoteLlmTimeoutMs: DEFAULT_ANALYSIS_REMOTE_LLM_TIMEOUT_MS
  }),
  embeddings: analysisEmbeddingsSchema.default({
    topK: DEFAULT_ANALYSIS_EMBEDDINGS_TOP_K,
    minScore: DEFAULT_ANALYSIS_EMBEDDINGS_MIN_SCORE
  })
});

export const llmSchema = z.object({
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  model: z.string().default(DEFAULT_LLM_MODEL)
});

export const pathsConfigSchema = z.object({
  derivedDatabase: z.string().optional()
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
  trim: trimConfigSchema.default({ enabled: true, intervalSeconds: 600 }),
  capture: captureConfigSchema.default({
    livenessThresholdSeconds: 120,
    permissionsGracePeriodSeconds: 60
  }),
  storage: storageConfigSchema.default({
    diskBudgetBytes: null,
    retentionDays: 7
  }),
  privacy: privacyConfigSchema.default({
    excludeApps: ['1Password', 'Keychain Access'],
    secureAxRoles: ['AXSecureTextField']
  }),
  analysis: analysisSchema.default({
    sessions: { idleThresholdSeconds: DEFAULT_ANALYSIS_IDLE_THRESHOLD_SECONDS },
    summary: {
      provider: 'template',
      remoteLlmTimeoutMs: DEFAULT_ANALYSIS_REMOTE_LLM_TIMEOUT_MS
    },
    embeddings: {
      topK: DEFAULT_ANALYSIS_EMBEDDINGS_TOP_K,
      minScore: DEFAULT_ANALYSIS_EMBEDDINGS_MIN_SCORE
    }
  }),
  llm: llmSchema.default({ model: DEFAULT_LLM_MODEL }),
  paths: pathsConfigSchema.default({})
});

export type RawAppConfig = z.infer<typeof appConfigSchema>;
