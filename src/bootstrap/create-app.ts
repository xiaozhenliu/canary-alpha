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
import { createEmbeddingProvider } from '../services/retrieval/provider-factory.js';
import { runTrimOnce } from '../services/capture/providers/screenpipe/trim-service.js';
import { createCaptureProvider } from '../services/capture/provider-factory.js';
import { createVectorStore, resolveVectorStoreDirectory } from '../services/retrieval/vector-store.js';
import {
  initDerivedSchema,
  openDerivedDatabase,
  resolveDerivedDatabasePath
} from '../services/work-activity/derived-database.js';
import { SqliteExtractedContentStore } from '../services/work-activity/extraction/extracted-content-store.js';
import { createExtractionRegistry } from '../services/work-activity/extraction/registry.js';
import { SqliteHashIndex } from '../services/work-activity/hash-index.js';
import { DefaultEmbeddingService } from '../services/work-activity/embedding-service.js';
import { DefaultFindService } from '../services/work-activity/find/find-service.js';
import { DefaultInspectService } from '../services/work-activity/inspect/inspect-service.js';
import { DefaultRecallService } from '../services/work-activity/recall/recall-service.js';
import { DefaultSessionAggregator } from '../services/work-activity/sessions/aggregator.js';
import { SqliteSessionStore } from '../services/work-activity/sessions/session-store.js';
import { createSummaryProviderRegistry } from '../services/work-activity/summary/registry.js';
import { SummaryWorker } from '../services/work-activity/summary/worker.js';
import { ProviderHealthRegistry } from '../services/work-activity/observability/provider-health-registry.js';
import { WorkActivityObservabilityService } from '../services/work-activity/observability/work-activity-observability-service.js';
import { createCascadeDeleteCoordinator, type CascadeDeleteCoordinator } from '../services/work-activity/cascade-delete-coordinator.js';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../types/app-config.js';

function resolveCheckpointPath(vectorStorePath?: string): string {
  return join(vectorStorePath ?? join(homedir(), '.canary-alpha-mcp'), 'retrieval-checkpoint.json');
}

export function startTrimPoller(
  app: Pick<AppContext, 'config' | 'logger'>,
  cascadeDeleteCoordinator?: CascadeDeleteCoordinator,
  privacyStore?: import('../services/privacy/types.js').PrivacyStore,
  upstreamDatabasePath?: string
): void {
  const intervalMs = app.config.trim.intervalSeconds * 1_000;
  // Fallback to the Screenpipe default path when not supplied by the factory.
  const databasePath = upstreamDatabasePath ?? join(resolveScreenpipeDirectory(), 'db.sqlite');
  let trimming = false;

  const trimOnce = (): void => {
    if (trimming) return;
    trimming = true;
    void runTrimOnce(databasePath, {
      budgetBytes: app.config.storage.diskBudgetBytes,
      retentionDays: app.config.storage.retentionDays,
      cascadeDeleteCoordinator,
      // Wire the privacy store so retention cascade failures are
      // persisted as `cascade-failure` tombstones — same audit /
      // retrieval-gating discipline as privacy `delete-range`.
      privacyStore,
      logger: app.logger
    })
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
    && process.env.CANARY_ALPHA_MCP_MANAGED_SERVICE === '1';
  if (config.server.mode === 'http' && config.server.host !== '127.0.0.1') {
    if (isManagedHttpService) {
      throw new Error(`Managed HTTP service must bind to 127.0.0.1 (found ${config.server.host}).`);
    }
    throw new Error(`HTTP transport must bind to 127.0.0.1 (found ${config.server.host}).`);
  }
  if (config.server.mode === 'http' && !config.server.authToken) {
    throw new Error('HTTP transport requires server.authToken or CANARY_ALPHA_MCP_AUTH_TOKEN.');
  }
  const logger = createLogger(config.logging.level, isManagedHttpService
    ? {
        filePath: config.paths.serviceLogFile,
        writeToStderr: false
      }
    : undefined);
  const embeddingProvider = createEmbeddingProvider(config);
  const captureProvider = createCaptureProvider(config);
  const captureClient = captureProvider.client;
  const vectorStore = createVectorStore(config);
  const checkpointStore = new FileCheckpointStore(resolveCheckpointPath(resolveVectorStoreDirectory(config.vectorStore)));
  const fileAnalysis = new DefaultFileAnalyzeService();
  const memory = new DefaultMemoryService(
    new FileMemoryStore({
      memory: resolveMemoryFilePath('memory'),
      user: resolveMemoryFilePath('user')
    })
  );
  const privacyStore = new FilePrivacyStore(resolvePrivacyStatePath());
  const freshnessPolicy = createFreshnessPolicy({
    freshnessWindowMinutes: config.retrieval.freshnessWindowMinutes
  });

  // Work-activity-analysis tail (task 6.1 / 6.2): open derived
  // database, materialise schema, build the per-frame collaborators
  // (extraction registry, extracted_content store, session aggregator,
  // embedding service) the indexing service now requires. The handles
  // live for the entire app lifetime — `derived.sqlite` is opened
  // once on boot and the `SqliteExtractedContentStore` /
  // `SqliteSessionStore` / `SqliteHashIndex` adapters share the same
  // `DatabaseSync` connection.
  const derivedDatabase = openDerivedDatabase(resolveDerivedDatabasePath(config));
  initDerivedSchema(derivedDatabase);
  const extractedContentStore = new SqliteExtractedContentStore(derivedDatabase);
  const sessionStore = new SqliteSessionStore(derivedDatabase);
  const hashIndex = new SqliteHashIndex(derivedDatabase);
  const extractionRegistry = createExtractionRegistry();
  const sessionAggregator = new DefaultSessionAggregator({
    store: sessionStore,
    idleThresholdSeconds: config.analysis.sessions.idleThresholdSeconds,
    now: () => new Date(),
    generateSessionId: () => randomUUID()
  });
  const embeddingService = new DefaultEmbeddingService({
    embeddingProvider,
    vectorStore,
    hashIndex,
    now: () => new Date()
  });

  // Cascade_Delete coordinator (task 10.1 / 10.2, R9.1). Wired here so
  // both the trim poller (retention pass) and the privacy control service
  // (delete-range) can trigger derived-data cleanup after upstream frames
  // are removed. The coordinator is constructed once and shared between
  // the two callers so they use the same storage adapters.
  const cascadeDeleteCoordinator = createCascadeDeleteCoordinator({
    sessionStore,
    extractedContentStore,
    vectorStore,
    derivedDatabase,
    logger
  });

  // Privacy control service — now receives the cascade coordinator so
  // `delete-range` cleans up derived data (sessions / extracted_content /
  // embeddings) after the upstream ScreenPipe frames are removed (R9.1).
  const privacy = new DefaultPrivacyControlService(
    privacyStore,
    undefined,
    {
      appDirectory: join(homedir(), '.canary-alpha-mcp'),
      retrievalArtifactsDirectory: resolveRetrievalArtifactsDirectory(config.vectorStore),
      screenpipeDirectory: resolveScreenpipeDirectory()
    },
    cascadeDeleteCoordinator,
    logger
  );

  // Read service for the `find` MCP tool (task 8.2 / 8.3). Reads
  // directly from the same `derivedDatabase` handle the writers above
  // use so the keyword search sees newly-extracted rows without
  // going through a second SQLite connection. Task 8.3 wires the
  // semantic collaborators (embedding provider, vector store, and
  // extracted-content store) so `mode='semantic'` / `'hybrid'` can
  // run honestly; if any of them is unavailable at request time the
  // service degrades to keyword (R7.6) rather than raising.
  const findService = new DefaultFindService({
    db: derivedDatabase,
    embeddingProvider,
    vectorStore,
    extractedContentStore,
    privacyState: privacyStore
  });

  // Read service for the `inspect` MCP tool (task 8.5). Wraps the
  // session store, the per-frame extracted_content store, the
  // SummaryWorker, and a read-only adapter over ScreenPipe's
  // upstream `db.sqlite` (so `inspect({frameId})` can surface the
  // raw AX tree on demand). The frames reader is wired against the
  // standard ScreenPipe directory; if `db.sqlite` is missing the
  // adapter degrades gracefully (`getFrame -> null`) and the tool
  // collapses to the documented "原始 AX 树不可访问" narrative.
  const summaryRegistry = createSummaryProviderRegistry(config);
  const summaryWorker = new SummaryWorker({
    registry: summaryRegistry,
    sessionStore,
    extractedContentStore,
    privacyState: privacyStore,
    now: () => new Date()
  });
  const inspectService = new DefaultInspectService({
    sessionStore,
    extractedContentStore,
    summaryWorker,
    screenpipeFramesReader: captureProvider.frameDetail
      ?? { getFrame: async () => null },  // capability-absent fallback, never throws
    now: () => new Date()
  });

  // Read service for the `recall` MCP tool (task 8.4). Shares the
  // session store, extracted-content store, session aggregator, and
  // summary worker with `inspect` so all three tools agree on which
  // sessions are open, what evidence they hold, and which provider
  // wrote any given summary. The aggregator's `flushIdleOpenSessions`
  // call at the entry of `recall(...)` keeps the third "called from"
  // site documented in design §4 honest.
  const recallService = new DefaultRecallService({
    sessionStore,
    extractedContentStore,
    sessionAggregator,
    summaryWorker,
    now: () => new Date(),
    idleThresholdSeconds: config.analysis.sessions.idleThresholdSeconds,
    privacyState: privacyStore
  });

  // Work-activity observability (task 9.1 / 9.2, design §9). The
  // `ProviderHealthRegistry` is a process-singleton the embedding /
  // summary call sites would record into; today none of those sites
  // is wired (out-of-scope for task 9.2), so the registry surfaces
  // the documented zero-call default (`status: 'unknown'`, W24).
  // Construction here keeps the wiring explicit so the eventual
  // recordOk / recordFailure plumbing can attach without re-shaping
  // the bootstrap.
  const providerHealth = new ProviderHealthRegistry();
  const workActivityObservability = new WorkActivityObservabilityService({
    extractedContentStore,
    sessionStore,
    sessionAggregator,
    summaryProviderRegistry: summaryRegistry,
    providerHealth,
    embeddingProviderKind: config.providers.embeddings.kind,
    now: () => new Date()
  });

  const services = createServices(config, {
    checkpointStore,
    vectorStore,
    workActivityObservability
  });

  const indexing = createIndexingService({
    embeddingProvider,
    captureClient,
    vectorStore,
    checkpointStore,
    freshnessWindowMinutes: config.retrieval.freshnessWindowMinutes,
    maxCatchUpBatches: config.retrieval.maxCatchUpBatches,
    maxCatchUpRecords: config.retrieval.maxCatchUpRecords,
    privacyState: privacyStore,
    // Pass through the privacy slice so `IndexingService` can honour
    // `config.privacy.secureAxRoles` (otherwise it falls back to the
    // hard-coded `['AXSecureTextField']` default and ignores user
    // configuration). Same for `logger` — without it the secure-role
    // pruner cannot emit its degraded-mode debug line.
    config: { privacy: config.privacy },
    logger,
    extractionRegistry,
    extractedContentStore,
    sessionAggregator,
    embeddingService
  });
  const retrieval = {
    embeddingProvider,
    captureClient,
    vectorStore,
    checkpointStore,
    freshnessPolicy,
    indexing
  };

  const app = {
    config,
    logger,
    services: {
      ...services,
      memory,
      fileAnalysis,
      privacy,
      screenpipeControl: captureProvider.lifecycle
        ?? { execute: async (req) => ({ action: req.action, running: false, error: 'capture provider has no lifecycle control' }) },
      retrieval,
      workActivity: {
        find: findService,
        inspect: inspectService,
        recall: recallService,
        cascadeDelete: cascadeDeleteCoordinator
      }
    }
  } satisfies AppContext;

  if (overrides?.startIndexingPoller ?? true) {
    startIndexingPoller(app);
  }

  if (app.config.trim.enabled && captureProvider.capabilities.retentionTrim) {
    startTrimPoller(app, cascadeDeleteCoordinator, privacyStore, captureProvider.upstreamDatabasePath);
  }

  return app;
}
