import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../config/load-config.js';
import { resolveMemoryFilePath, resolvePrivacyStatePath, resolveRetrievalArtifactsDirectory, resolveScreenpipeDirectory } from '../config/paths.js';
import { createLogger } from '../lib/logging.js';
import { DefaultFileAnalyzeService } from '../services/file-analysis/file-analyze-service.js';
import { DefaultMemoryService } from '../services/memory/memory-service.js';
import { FileMemoryStore } from '../services/memory/memory-store.js';
import { DefaultPrivacyControlService } from '../services/privacy/privacy-control-service.js';
import { FilePrivacyStore } from '../services/privacy/privacy-store.js';
import { createServices } from '../services/bootstrap-status-service.js';
import { FileCheckpointStore } from '../services/retrieval/checkpoint-store.js';
import { createFreshnessPolicy } from '../services/retrieval/freshness-policy.js';
import { createIndexingService } from '../services/retrieval/indexing-service.js';
import { createRecentActivityService } from '../services/retrieval/recent-activity-service.js';
import { createEmbeddingProvider } from '../services/retrieval/provider-factory.js';
import { createSearchScreenService } from '../services/retrieval/search-screen-service.js';
import { runTrimOnce } from '../services/trim/screenpipe-trim-service.js';
import { DefaultScreenpipeControlService } from '../services/screenpipe-control/screenpipe-control-service.js';
import { createScreenpipeClient } from '../services/retrieval/screenpipe-client.js';
import { createVectorStore, resolveVectorStoreDirectory } from '../services/retrieval/vector-store.js';
import type { AppContext } from '../types/app-config.js';

function resolveCheckpointPath(vectorStorePath?: string): string {
  return join(vectorStorePath ?? join(homedir(), '.canary-alpha-mcp'), 'retrieval-checkpoint.json');
}

export function startTrimPoller(app: Pick<AppContext, 'config' | 'logger'>): void {
  const intervalMs = app.config.trim.intervalSeconds * 1_000;
  let trimming = false;

  const trimOnce = (): void => {
    if (trimming) return;
    trimming = true;
    void runTrimOnce(join(resolveScreenpipeDirectory(), 'db.sqlite'))
      .then((result) => { app.logger.info('screenpipe trim complete', { ...result }); })
      .finally(() => { trimming = false; });
  };

  const timer = setInterval(trimOnce, intervalMs);
  timer.unref?.();
}

export function startIndexingPoller(app: Pick<AppContext, 'config' | 'logger' | 'services'>): void {
  const intervalMs = app.config.retrieval.pollIntervalSeconds * 1_000;
  let polling = false;

  const pollOnce = (): void => {
    if (polling) {
      return;
    }

    polling = true;
    void app.services.retrieval.indexing.runOnce()
      .catch((error) => {
        app.logger.warn('Background indexing poll failed; will retry on the next interval.', {
          message: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        polling = false;
      });
  };

  pollOnce();

  const timer = setInterval(() => {
    pollOnce();
  }, intervalMs);

  timer.unref?.();
}

export async function createApp(overrides?: {
  mode?: AppContext['config']['server']['mode'];
  port?: number;
  logLevel?: AppContext['config']['logging']['level'];
  startIndexingPoller?: boolean;
  vectorStorePath?: string;
}): Promise<AppContext> {
  const config = await loadConfig(overrides);
  const isManagedHttpService = config.server.mode === 'http'
    && process.env.SCREENPIPE_MEMORY_MCP_MANAGED_SERVICE === '1';
  if (isManagedHttpService && config.server.host !== '127.0.0.1') {
    throw new Error(`Managed HTTP service must bind to 127.0.0.1 (found ${config.server.host}).`);
  }
  const logger = createLogger(config.logging.level, isManagedHttpService
    ? {
        filePath: config.paths.serviceLogFile,
        writeToStderr: false
      }
    : undefined);
  const embeddingProvider = createEmbeddingProvider(config);
  const screenpipeClient = createScreenpipeClient(config.screenpipe.url, config.screenpipe.apiKey);
  const vectorStore = createVectorStore(config);
  const checkpointStore = new FileCheckpointStore(resolveCheckpointPath(resolveVectorStoreDirectory(config.vectorStore)));
  const services = createServices(config, {
    checkpointStore,
    vectorStore
  });
  const fileAnalysis = new DefaultFileAnalyzeService();
  const memory = new DefaultMemoryService(
    new FileMemoryStore({
      memory: resolveMemoryFilePath('memory'),
      user: resolveMemoryFilePath('user')
    })
  );
  const privacyStore = new FilePrivacyStore(resolvePrivacyStatePath());
  const privacy = new DefaultPrivacyControlService(privacyStore, undefined, {
    appDirectory: join(homedir(), '.canary-alpha-mcp'),
    retrievalArtifactsDirectory: resolveRetrievalArtifactsDirectory(config.vectorStore),
    screenpipeDirectory: resolveScreenpipeDirectory()
  });
  const freshnessPolicy = createFreshnessPolicy({
    freshnessWindowMinutes: config.retrieval.freshnessWindowMinutes
  });
  const indexing = createIndexingService({
    embeddingProvider,
    screenpipeClient,
    vectorStore,
    checkpointStore,
    freshnessWindowMinutes: config.retrieval.freshnessWindowMinutes,
    maxCatchUpBatches: config.retrieval.maxCatchUpBatches,
    maxCatchUpRecords: config.retrieval.maxCatchUpRecords,
    privacyState: privacyStore
  });
  const retrieval = {
    embeddingProvider,
    screenpipeClient,
    vectorStore,
    checkpointStore,
    freshnessPolicy,
    indexing,
    searchScreen: createSearchScreenService({
      embeddingProvider,
      screenpipeClient,
      vectorStore,
      checkpointStore,
      freshnessPolicy,
      privacyState: privacyStore
    }),
    recentActivity: createRecentActivityService({
      screenpipeClient,
      checkpointStore,
      freshnessPolicy,
      privacyState: privacyStore
    })
  };

  const app = {
    config,
    logger,
    services: {
      ...services,
      memory,
      fileAnalysis,
      privacy,
      screenpipeControl: new DefaultScreenpipeControlService(),
      retrieval
    }
  } satisfies AppContext;

  if (overrides?.startIndexingPoller ?? true) {
    startIndexingPoller(app);
  }

  if (app.config.trim.enabled) {
    startTrimPoller(app);
  }

  return app;
}
