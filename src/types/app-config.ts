import type { AddressInfo } from 'node:net';

import type { FileAnalyzeService } from '../services/file-analysis/types.js';
import type { MemoryService } from '../services/memory/types.js';
import type { ScreenpipeControlService } from '../services/screenpipe-control/screenpipe-control-service.js';
import type { PrivacyControlService } from '../services/privacy/types.js';
import type {
  CheckpointStore,
  EmbeddingProvider,
  FreshnessPolicy,
  IndexingService,
  RecentActivityService,
  ScreenpipeClient,
  SearchScreenService,
  VectorStore
} from '../services/retrieval/types.js';

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

export interface AppConfig {
  server: {
    mode: ServerMode;
    host: string;
    port: number;
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
  };
  trim: {
    enabled: boolean;
    intervalSeconds: number;
  };
}

export interface ScreenpipeTrimResult {
  duplicatesRemoved: number;
  elementsRemoved: number;
  accessibilityJsonNulled: number;
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
  retrieval: {
    checkpointExists: boolean;
    checkpointTimestamp?: string;
    vectorStoreKind: string;
    recoveryStatus: 'ready' | 'needs-rebuild' | 'degraded';
  };
  screenpipeStorage: ScreenpipeStorageDiagnostics;
}

export interface AppServices {
  bootstrapStatus: {
    getStatus(address?: AddressInfo | null): Promise<BootstrapStatus>;
  };
  memory: MemoryService;
  fileAnalysis: FileAnalyzeService;
  privacy: PrivacyControlService;
  screenpipeControl: ScreenpipeControlService;
  retrieval: {
    embeddingProvider: EmbeddingProvider;
    screenpipeClient: ScreenpipeClient;
    vectorStore: VectorStore;
    checkpointStore: CheckpointStore;
    freshnessPolicy: FreshnessPolicy;
    indexing: IndexingService;
    searchScreen: SearchScreenService;
    recentActivity: RecentActivityService;
  };
}

export interface AppContext {
  config: AppConfig;
  logger: Logger;
  services: AppServices;
}
