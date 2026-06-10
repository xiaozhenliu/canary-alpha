import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

import {
  resolveConfigPath,
  resolveDerivedDatabasePath,
  resolveLogDirectory,
  resolveLogFilePath,
  resolveRoutineDefinitionsDirectory,
  resolveRoutineHistoryDirectory
} from './paths.js';
import { appConfigSchema, logLevelSchema, serverModeSchema } from './schema.js';
import type { AppConfig } from '../types/app-config.js';

function parseOptionalPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid MCP_PORT value: ${value}`);
  }
  return port;
}

function parseOptionalPortOrUndefined(value: string | undefined): number | undefined {
  try {
    return parseOptionalPort(value);
  } catch {
    return undefined;
  }
}

export async function loadConfig(overrides?: {
  mode?: AppConfig['server']['mode'];
  port?: number;
  logLevel?: AppConfig['logging']['level'];
  vectorStorePath?: string;
}): Promise<AppConfig> {
  const configFile = resolveConfigPath();
  const logDirectory = resolveLogDirectory();
  const serviceLogFile = resolveLogFilePath();
  let parsedFileConfig: unknown = {};

  try {
    const raw = await readFile(configFile, 'utf8');
    parsedFileConfig = YAML.parse(raw) ?? {};
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw new Error(`Failed to read config file at ${configFile}: ${nodeError.message}`);
    }
  }

  const parsed = appConfigSchema.safeParse(parsedFileConfig);
  if (!parsed.success) {
    throw new Error(`Invalid config file at ${configFile}: ${parsed.error.message}`);
  }

  const envMode = process.env.MCP_MODE;
  const isManagedService = process.env.CANARY_ALPHA_MCP_MANAGED_SERVICE === '1';
  const envPort = isManagedService
    ? parseOptionalPortOrUndefined(process.env.MCP_PORT)
    : parseOptionalPort(process.env.MCP_PORT);
  const envLogLevel = process.env.MCP_LOG_LEVEL;
  const envScreenpipeBaseUrl = process.env.SCREENPIPE_BASE_URL;
  const envScreenpipeApiKey = process.env.SCREENPIPE_API_KEY;
  const envHttpAuthToken = process.env.CANARY_ALPHA_MCP_AUTH_TOKEN;
  const managedServicePort = isManagedService
    ? parseOptionalPort(process.env.CANARY_ALPHA_MCP_SERVER_PORT)
    : undefined;
  const screenpipeBaseUrl = isManagedService
    && envScreenpipeBaseUrl
    && envScreenpipeBaseUrl.length > 0
    ? envScreenpipeBaseUrl
    : parsed.data.screenpipe.url;
  const screenpipeApiKey = isManagedService
    && envScreenpipeApiKey
    && envScreenpipeApiKey.length > 0
    ? envScreenpipeApiKey
    : parsed.data.screenpipe.apiKey;

  const mode = overrides?.mode
    ?? (envMode ? serverModeSchema.parse(envMode) : undefined)
    ?? parsed.data.server.mode;
  const port = overrides?.port
    ?? (isManagedService ? envPort : undefined)
    ?? (isManagedService ? managedServicePort : undefined)
    ?? envPort
    ?? parsed.data.server.port;
  const logLevel = overrides?.logLevel
    ?? (envLogLevel ? logLevelSchema.parse(envLogLevel) : undefined)
    ?? parsed.data.logging.level;

  return {
    server: {
      mode,
      host: parsed.data.server.host,
      port,
      authToken: envHttpAuthToken && envHttpAuthToken.length > 0
        ? envHttpAuthToken
        : parsed.data.server.authToken
    },
    logging: {
      level: logLevel
    },
    screenpipe: {
      url: screenpipeBaseUrl,
      apiKey: screenpipeApiKey
    },
    providers: {
      embeddings: {
        kind: parsed.data.providers.embeddings.kind,
        baseUrl: parsed.data.providers.embeddings.baseUrl,
        model: parsed.data.providers.embeddings.model,
        apiKey: parsed.data.providers.embeddings.apiKey,
        concurrency: parsed.data.providers.embeddings.concurrency
      }
    },
    vectorStore: {
      kind: parsed.data.vectorStore.kind,
      path: overrides?.vectorStorePath ?? parsed.data.vectorStore.path
    },
    retrieval: {
      freshnessWindowMinutes: parsed.data.retrieval.freshnessWindowMinutes,
      pollIntervalSeconds: parsed.data.retrieval.pollIntervalSeconds,
      maxCatchUpBatches: parsed.data.retrieval.maxCatchUpBatches,
      maxCatchUpRecords: parsed.data.retrieval.maxCatchUpRecords
    },
    routines: {
      enabled: parsed.data.routines.enabled,
      definitionsPath: parsed.data.routines.definitionsPath ?? resolveRoutineDefinitionsDirectory(),
      historyPath: parsed.data.routines.historyPath ?? resolveRoutineHistoryDirectory()
    },
    paths: {
      configFile,
      logDirectory,
      serviceLogFile,
      derivedDatabase: resolveDerivedDatabasePath(parsed.data)
    },
    trim: {
      enabled: parsed.data.trim.enabled,
      intervalSeconds: parsed.data.trim.intervalSeconds
    },
    capture: {
      livenessThresholdSeconds: parsed.data.capture.livenessThresholdSeconds,
      permissionsGracePeriodSeconds: parsed.data.capture.permissionsGracePeriodSeconds
    },
    storage: {
      diskBudgetBytes: parsed.data.storage.diskBudgetBytes,
      retentionDays: parsed.data.storage.retentionDays
    },
    privacy: {
      excludeApps: parsed.data.privacy.excludeApps,
      secureAxRoles: parsed.data.privacy.secureAxRoles
    },
    analysis: {
      sessions: {
        idleThresholdSeconds: parsed.data.analysis.sessions.idleThresholdSeconds
      },
      summary: {
        provider: parsed.data.analysis.summary.provider,
        remoteLlmTimeoutMs: parsed.data.analysis.summary.remoteLlmTimeoutMs
      },
      embeddings: {
        topK: parsed.data.analysis.embeddings.topK,
        minScore: parsed.data.analysis.embeddings.minScore
      }
    },
    llm: {
      base_url: parsed.data.llm.base_url,
      api_key: parsed.data.llm.api_key,
      model: parsed.data.llm.model
    }
  };
}
