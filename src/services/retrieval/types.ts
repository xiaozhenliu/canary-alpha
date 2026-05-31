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

export interface ScreenpipeSearchRequest {
  query?: string;
  appName?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface ScreenpipeRecord {
  id: string;
  text: string;
  timestamp: string;
  appName?: string;
  windowName?: string;   // NEW: used for Noise_Window filtering (R3.4)
  frameId?: number;      // NEW: used for cross-source deduplication (R1.4)
  sourceTypes: string[]; // NEW: ['accessibility'] | ['ocr'] (R1.5)
  // AX element tree fields for Secure_AX_Field subtree pruning (R4.4)
  role?: string;         // AX element role (e.g. 'AXSecureTextField')
  parentId?: string;     // parent element id within the same frame's AX tree
  path?: string;         // dot-separated ancestor path (e.g. '0.1.2')
  // work-activity-analysis: full accessibility tree JSON. The HTTP screenpipe
  // client does NOT yet populate this field — task 6.1 reserves the slot so
  // the indexing service can pass it to the extraction layer once an upstream
  // task wires the accessibility_tree_json column through ScreenPipe's API.
  // When `null` (set explicitly by callers / fixtures), the
  // GenericHeuristicRule emits Empty_Extraction. When `undefined` (the
  // current production state for HTTP records), the indexing service
  // synthesises a minimal AX tree from `text` so OCR-only records remain
  // indexable; see `resolveAccessibilityTreeJson` in
  // `src/services/retrieval/indexing-service.ts`.
  accessibilityTreeJson?: string | null;
}

export interface ScreenpipeClient {
  search(request: ScreenpipeSearchRequest): Promise<ScreenpipeRecord[]>;
  recent(minutes: number): Promise<ScreenpipeRecord[]>;
}

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
   * Delete all records whose `metadata.frameId` matches one of the supplied
   * frame ids. The `frameIds` are normalised via `String(id)` before
   * comparison so callers may supply numeric or string ids interchangeably.
   *
   * Returns the number of records deleted. Records that do not carry a
   * `metadata.frameId` are left untouched.
   *
   * Used by Cascade_Delete (R9) when ScreenPipe frames are removed via
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

