import type { AddressInfo } from 'node:net';

import type { FileAnalyzeService } from '../services/file-analysis/types.js';
import type { MemoryService } from '../services/memory/types.js';
import type { ScreenpipeControlService } from '../services/capture/providers/screenpipe/control-service.js';
import type { PrivacyControlService } from '../services/privacy/types.js';
import type { CaptureCapabilities } from '../services/capture/types.js';
import type {
  CaptureClient,
  CheckpointStore,
  EmbeddingProvider,
  FreshnessPolicy,
  IndexingService,
  VectorStore
} from '../services/retrieval/types.js';
import type { FindService } from '../services/work-activity/find/find-service.js';
import type { InspectService } from '../services/work-activity/inspect/inspect-service.js';
import type { RecallService } from '../services/work-activity/recall/recall-service.js';
import type { CascadeDeleteCoordinator } from '../services/work-activity/cascade-delete-coordinator.js';
import type { CaptureStatus, IngestionMix, DiskBudget } from '../services/diagnostics/ingestion-observability-service.js';
import type {
  ExtractionStatus,
  ObservabilityDegradation,
  ProvidersStatus,
  SessionsStatus,
  SummaryRollup
} from '../services/work-activity/observability/work-activity-observability-service.js';

export type ServerMode = 'stdio' | 'http';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type StorageArtifactClass =
  | 'screenpipe-sqlite-main'
  | 'screenpipe-sqlite-wal'
  | 'screenpipe-sqlite-shm'
  | 'screenpipe-data'
  | 'screenpipe-pi-agent'
  | 'screenpipe-logs'
  | 'mcp-vector-store'
  | 'mcp-checkpoint'
  | 'mcp-runtime-state'
  | 'mcp-logs'
  | 'mcp-memory';

export interface ProviderConfig {
  kind: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  concurrency?: number;
}

export interface ScreenpipeConfig {
  url?: string;
  apiKey?: string;
}

export interface VectorStoreConfig {
  kind: string;
  path?: string;
}

/**
 * Summary provider kinds delivered in this spec.
 *
 * - `template` (default): deterministic local string templating; zero outbound traffic.
 * - `remote-llm`: OpenAI-compatible chat/completions call via `llm.base_url`.
 *
 * The abstraction is designed for backward-compatible extension (e.g. local LLMs).
 */
export type SummaryProviderKind = 'template' | 'remote-llm';

export interface AnalysisSessionsConfig {
  idleThresholdSeconds: number;
}

export interface AnalysisSummaryConfig {
  provider: SummaryProviderKind;
  remoteLlmTimeoutMs: number;
}

export interface AnalysisEmbeddingsConfig {
  topK: number;
  minScore: number;
}

export interface AnalysisConfig {
  sessions: AnalysisSessionsConfig;
  summary: AnalysisSummaryConfig;
  embeddings: AnalysisEmbeddingsConfig;
}

export interface LlmConfig {
  base_url?: string;
  api_key?: string;
  model: string;
}

export interface AppConfig {
  server: {
    mode: ServerMode;
    host: string;
    port: number;
    authToken?: string;
  };
  logging: {
    level: LogLevel;
  };
  screenpipe: ScreenpipeConfig;
  providers: {
    embeddings: ProviderConfig;
  };
  vectorStore: VectorStoreConfig;
  retrieval: {
    freshnessWindowMinutes: number;
    pollIntervalSeconds: number;
    maxCatchUpBatches: number;
    maxCatchUpRecords: number;
  };
  routines: {
    enabled: boolean;
    definitionsPath: string;
    historyPath: string;
  };
  paths: {
    configFile: string;
    logDirectory: string;
    serviceLogFile: string;
    /**
     * Derived SQLite database path used by the work-activity-analysis layer
     * (extracted_content / sessions / embedding_hash_index tables).
     * Defaults to `~/.canary-alpha-mcp/derived.sqlite`.
     */
    derivedDatabase: string;
  };
  trim: {
    enabled: boolean;
    intervalSeconds: number;
  };
  capture: {
    provider: 'screenpipe';
    livenessThresholdSeconds: number;
    permissionsGracePeriodSeconds: number;
  };
  storage: {
    diskBudgetBytes: number | null;
    retentionDays: number;
  };
  privacy: {
    excludeApps: string[];
    secureAxRoles: string[];
  };
  analysis: AnalysisConfig;
  llm: LlmConfig;
}

export interface ScreenpipeTrimResult {
  framesDeleted: number;
  elementsDeleted: number;
  reachedFloor: boolean;
  durationMs: number;
}

export interface StorageDiagnosticsPaths {
  screenpipeDirectory: string;
  appDirectory: string;
  retrievalArtifactsDirectory: string;
}

export interface StorageArtifactUsage {
  key: StorageArtifactClass;
  label: string;
  location: string;
  bytes: number;
  exists: boolean;
}

export interface StorageDiagnosticsReport {
  generatedAt: string;
  totalBytes: number;
  artifacts: StorageArtifactUsage[];
  dominantArtifacts: StorageArtifactUsage[];
  paths: StorageDiagnosticsPaths;
  screenpipeSqlite: ScreenpipeStorageDiagnostics;
}

export interface Logger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface ScreenpipeStorageTableUsage {
  name: string;
  estimatedBytes: number;
}

export type ScreenpipeSqliteAttributionBucketKey = 'frames' | 'elements' | 'fts' | 'other' | 'unattributed';

export interface ScreenpipeSqliteAttributionBucket {
  key: ScreenpipeSqliteAttributionBucketKey;
  label: string;
  estimatedBytes: number;
  tables: string[];
}

export interface ScreenpipeSqliteByteAttribution {
  buckets: ScreenpipeSqliteAttributionBucket[];
  attributedBytes: number;
  unattributedBytes: number;
}

export interface ScreenpipeStorageHotspotField {
  key: string;
  estimatedBytes: number;
  sampledRows: number;
}

export interface ScreenpipeStorageHotspotApp {
  appName: string;
  estimatedBytes: number;
}

export interface ScreenpipeStorageHotspotAccessibilityRole {
  source: string;
  role: string;
  estimatedBytes: number;
  sampledRows: number;
}

export interface ScreenpipeStorageHotspots {
  inspectionStatus: 'ready' | 'degraded' | 'unavailable';
  reason?: string;
  dominantFields: ScreenpipeStorageHotspotField[];
  dominantApps: ScreenpipeStorageHotspotApp[];
  dominantAccessibilityRoles: ScreenpipeStorageHotspotAccessibilityRole[];
}

export type ScreenpipeRecentTextDuplicationSourceKey = 'frame-full-text' | 'frame-accessibility-text' | 'ocr-text';

export interface ScreenpipeRecentTextDuplicateGroup {
  appName: string;
  windowName: string;
  textPreview: string;
  occurrences: number;
  textLength: number;
}

export interface ScreenpipeRecentTextDuplicationSource {
  key: ScreenpipeRecentTextDuplicationSourceKey;
  label: string;
  inspectionStatus: 'ready' | 'degraded';
  reason?: string;
  sampledRows: number;
  distinctTexts: number;
  duplicateGroups: number;
  duplicateRows: number;
  sampledCharacters: number;
  redundantCharacters: number;
  topGroups: ScreenpipeRecentTextDuplicateGroup[];
}

export interface ScreenpipeRecentTextDuplicationDiagnostics {
  inspectionStatus: 'ready' | 'degraded' | 'unavailable';
  reason?: string;
  windowMinutes: number;
  minTextLength: number;
  analyzedAt: string;
  sources: ScreenpipeRecentTextDuplicationSource[];
}

export interface ScreenpipeRecentElementDuplicateGroup {
  appName: string;
  windowName: string;
  source: string;
  role: string;
  textPreview: string;
  occurrences: number;
  estimatedBytes: number;
}

export interface ScreenpipeRecentElementDuplicationDiagnostics {
  inspectionStatus: 'ready' | 'degraded' | 'unavailable';
  reason?: string;
  windowMinutes: number;
  minTextLength: number;
  analyzedAt: string;
  sampledRows: number;
  distinctElements: number;
  duplicateGroups: number;
  duplicateRows: number;
  sampledBytes: number;
  redundantBytes: number;
  topGroups: ScreenpipeRecentElementDuplicateGroup[];
}

export type ScreenpipeRecentCaptureReuseSignalKey = 'capture-trigger' | 'element-reuse';

export interface ScreenpipeRecentCaptureReuseValueSummary {
  value: string;
  rows: number;
  estimatedBytes: number;
}

export interface ScreenpipeRecentCaptureReuseSignal {
  key: ScreenpipeRecentCaptureReuseSignalKey;
  label: string;
  sampledRows: number;
  matchedRows: number;
  estimatedBytes: number;
  topValues: ScreenpipeRecentCaptureReuseValueSummary[];
}

export interface ScreenpipeRecentCaptureReuseDiagnostics {
  inspectionStatus: 'ready' | 'degraded' | 'unavailable';
  reason?: string;
  windowMinutes: number;
  analyzedAt: string;
  coverage: 'supported' | 'partial' | 'unsupported';
  signals: ScreenpipeRecentCaptureReuseSignal[];
}

export interface ScreenpipeRecentHeavyGrowthTimeSlice {
  bucketStart: string;
  bucketMinutes: number;
  estimatedBytes: number;
  samples: number;
  appName: string;
  windowName: string;
}

export interface ScreenpipeRecentHeavyGrowthSample {
  frameId: number;
  timestamp: string;
  appName: string;
  windowName: string;
  estimatedBytes: number;
  duplicateSignal: 'duplicate-heavy' | 'unique-heavy';
  preview: string;
}

export interface ScreenpipeRecentHeavyGrowthDiagnostics {
  inspectionStatus: 'ready' | 'degraded' | 'unavailable';
  reason?: string;
  windowMinutes: number;
  sampleLimit: number;
  timeSliceMinutes: number;
  analyzedAt: string;
  sampledRows: number;
  sampledBytes: number;
  topTimeSlices: ScreenpipeRecentHeavyGrowthTimeSlice[];
  topSamples: ScreenpipeRecentHeavyGrowthSample[];
}

export interface ScreenpipeStorageDiagnostics {
  inspectionStatus: 'ready' | 'degraded' | 'unavailable';
  reason?: string;
  databasePath: string;
  totalBytes: number;
  dominantTables: ScreenpipeStorageTableUsage[];
  byteAttribution?: ScreenpipeSqliteByteAttribution;
  hotspots?: ScreenpipeStorageHotspots;
  recentTextDuplication?: ScreenpipeRecentTextDuplicationDiagnostics;
  recentElementDuplication?: ScreenpipeRecentElementDuplicationDiagnostics;
  recentCaptureReuse?: ScreenpipeRecentCaptureReuseDiagnostics;
  recentHeavyGrowth?: ScreenpipeRecentHeavyGrowthDiagnostics;
}

export interface BootstrapStatus {
  status: 'ok';
  mode: ServerMode;
  host: string;
  port: number;
  pid: number;
  configFile: string;
  /** Capture liveness state (from IngestionObservabilityService). Optional: absent when collection fails. */
  capture?: CaptureStatus;
  /** Ingestion source mix over the last 24 h. Optional: absent when collection fails. */
  ingestionMix?: IngestionMix;
  /** Disk budget snapshot. Optional: absent when collection fails. */
  diskBudget?: DiskBudget;
  retrieval: {
    checkpointExists: boolean;
    checkpointTimestamp?: string;
    vectorStoreKind: string;
    recoveryStatus: 'ready' | 'needs-rebuild' | 'degraded';
  };
  screenpipeStorage: ScreenpipeStorageDiagnostics;
  /**
   * Work-activity-analysis observability rollups (design §9 / R2 / R4 / R8).
   * Each block is optional so a `WorkActivityObservabilityService` failure
   * (or absence at boot before the wiring lands) collapses the field rather
   * than failing the entire `internal-status` call.
   */
  extraction?: ExtractionStatus;
  sessions?: SessionsStatus;
  summary?: SummaryRollup;
  providers?: ProvidersStatus;
  /**
   * Per-section degradation reasons (design §9 Error Handling). Populated
   * only when `WorkActivityObservabilityService.collect()` falls back for
   * one or more sections. Omitted entirely when every section is healthy.
   */
  degraded?: ObservabilityDegradation;
}

// Re-export for convenience so callers don't need to import from two places.
export type { CaptureStatus, IngestionMix, DiskBudget };
export type {
  ExtractionStatus,
  ObservabilityDegradation,
  ProvidersStatus,
  SessionsStatus,
  SummaryRollup
};

export interface AppServices {
  bootstrapStatus: {
    getStatus(address?: AddressInfo | null): Promise<BootstrapStatus>;
  };
  memory: MemoryService;
  fileAnalysis: FileAnalyzeService;
  privacy: PrivacyControlService;
  screenpipeControl: ScreenpipeControlService;
  /** Capability descriptor of the active capture provider. Upper layers branch on these flags. */
  captureCapabilities: CaptureCapabilities;
  retrieval: {
    embeddingProvider: EmbeddingProvider;
    captureClient: CaptureClient;
    vectorStore: VectorStore;
    checkpointStore: CheckpointStore;
    freshnessPolicy: FreshnessPolicy;
    indexing: IndexingService;
  };
  /**
   * Work-activity-analysis read services backing the `find` / `recall`
   * / `inspect` MCP tools (task 8.x). Each tool delegates to its
   * service so the schemas live in `src/mcp/tools/` while the SQL
   * lives in `src/services/work-activity/`. Services are wired in
   * `bootstrap/create-app.ts`.
   *
   * `cascadeDelete` is the coordinator used by the retention pass and
   * `delete-range` to clean up derived data (task 10.2, R9.1).
   */
  workActivity: {
    find: FindService;
    inspect: InspectService;
    recall: RecallService;
    cascadeDelete: CascadeDeleteCoordinator;
  };
}

export interface AppContext {
  config: AppConfig;
  logger: Logger;
  services: AppServices;
}
