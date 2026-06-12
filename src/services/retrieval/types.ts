export interface IndexedBacklogProgress {
  from: string;
  to: string;
  nextOffset: number;
}

export interface IndexedCheckpoint {
  cursor?: string;
  timestamp: string;
  backlog?: IndexedBacklogProgress;
}

export interface RetrievalEvidenceItem {
  id: string;
  text: string;
  timestamp: string;
  appName?: string;
  windowName?: string;   // NEW
  score?: number;
  source: 'keyword' | 'semantic' | 'hybrid'; // existing: retrieval-mode label
  sourceTypes: string[]; // NEW: capture-source label (R1.5)
}

export interface RetrievalDegradedStatus {
  reason: string;
  fallbackMode?: 'keyword' | 'semantic';
}

export interface RetrievalActionableError {
  code: 'SCREENPIPE_UNAVAILABLE' | 'EMBEDDING_UNAVAILABLE' | 'RETRIEVAL_FAILED';
  message: string;
  action: string;
}

// Note: the legacy `SearchScreenRequest` / `SearchScreenResult` /
// `RecentActivityRequest` / `RecentActivityResult` interfaces and their
// service contracts (`SearchScreenService` / `RecentActivityService`) were
// removed by task 8.1 of the work-activity-analysis spec. The MCP tools
// `search-screen` / `recent-activity` they backed are replaced by `find` /
// `recall` / `inspect`. Their services will be reintroduced under
// `src/services/work-activity/` once tasks 8.2 - 8.5 land.

export interface EmbeddingProvider {
  readonly kind: string;
  readonly baseUrl?: string;
  readonly model?: string;
  embed(input: string): Promise<number[]>;
}

import type {
  CaptureClient,
  CaptureRecord,
  CaptureSearchRequest
} from '../capture/types.js';

// Re-export the neutral capture model under this module so existing
// retrieval-layer imports keep resolving during the migration.
export type {
  CaptureClient,
  CaptureRecord,
  CaptureSearchRequest
} from '../capture/types.js';

/** @deprecated Use CaptureSearchRequest from services/capture/types.js. */
export type ScreenpipeSearchRequest = CaptureSearchRequest;
/** @deprecated Use CaptureRecord from services/capture/types.js. */
export type ScreenpipeRecord = CaptureRecord;
/** @deprecated Use CaptureClient from services/capture/types.js. */
export type ScreenpipeClient = CaptureClient;

export interface VectorSearchRequest {
  queryEmbedding: number[];
  appName?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface VectorStoreRecord extends ScreenpipeRecord {
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorStoreInspection {
  persisted: boolean;
  readable: boolean;
  recordCount?: number;
}

export interface VectorStore {
  readonly kind: string;
  upsert(records: VectorStoreRecord[]): Promise<void>;
  reset(): Promise<void>;
  query(request: VectorSearchRequest): Promise<RetrievalEvidenceItem[]>;
  querySnapshot?(request: VectorSearchRequest): Promise<RetrievalEvidenceItem[]>;
  inspect?(): Promise<VectorStoreInspection>;
  close?(): Promise<void>;
  /**
   * List all records whose timestamp falls within [from, to] (ISO-8601 strings).
   * Used by IngestionObservabilityService to aggregate ingestionMix counts.
   * Optional – implementations that do not support this return undefined.
   */
  listByTimeWindow?(from: string, to: string): Promise<VectorStoreRecord[]>;
  /**
   * Delete all records whose frame identity matches one of the supplied frame
   * ids. Matching uses DUAL-KEY semantics to handle the transition window:
   *
   *   1. Legacy key — `metadata.frameId`: records written before the
   *      captureId migration (Task 5) carry only this bare numeric id.
   *   2. Neutral key — `metadata.captureId`: records written after Task 5
   *      carry a `<provider>:frame:<id>` string; the frame value is parsed
   *      via `parseCaptureId` and compared to the target set.
   *
   * A record is deleted when EITHER key resolves to a target frame id.
   * The `frameIds` are normalised via `String(id)` before comparison so
   * callers may supply numeric or string ids interchangeably.
   *
   * Returns the number of records deleted. Records that carry neither key
   * are left untouched.
   *
   * Used by Cascade_Delete (R9) when capture frames are removed via
   * retention or `delete-range`.
   */
  deleteByFrameIds?(frameIds: ReadonlyArray<string | number>): Promise<number>;
  /**
   * Delete all records whose `metadata.frameTimestamp` (fallback to
   * `record.timestamp` when the metadata is missing) falls within the
   * `[from, to]` inclusive ISO-8601 range.
   *
   * Returns the number of records deleted. Used by Cascade_Delete (R9)
   * when `delete-range` removes a contiguous time window.
   */
  deleteByTimestampRange?(from: string, to: string): Promise<number>;
}

export interface CheckpointStore {
  readLatest(): Promise<IndexedCheckpoint | null>;
  writeLatest(checkpoint: IndexedCheckpoint): Promise<void>;
  reset(): Promise<void>;
}

export type FreshnessClassification = 'fresh' | 'stale-catchup-allowed' | 'stale-beyond-window';

export interface FreshnessStatus {
  status: FreshnessClassification;
  lagMinutes: number | null;
  windowMinutes: number;
  checkpoint: IndexedCheckpoint | null;
}

export interface FreshnessPolicy {
  evaluate(checkpoint: IndexedCheckpoint | null, now?: Date): FreshnessStatus;
}

export interface IndexingRunResult {
  fetched: number;
  indexed: number;
  checkpointBefore: IndexedCheckpoint | null;
  checkpointAfter: IndexedCheckpoint | null;
  hadEmbeddingFailures: boolean;
}

export interface IndexingService {
  runOnce(now?: Date, forcedBacklog?: IndexedBacklogProgress | null): Promise<IndexingRunResult>;
}

