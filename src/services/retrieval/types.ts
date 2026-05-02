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
  score?: number;
  source: 'keyword' | 'semantic' | 'hybrid';
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

export interface SearchScreenRequest {
  query: string;
  mode: 'semantic' | 'keyword' | 'hybrid';
  appName?: string;
  from?: string;
  to?: string;
}

export interface SearchScreenResult {
  summary: string;
  evidence: RetrievalEvidenceItem[];
  degraded?: RetrievalDegradedStatus;
  freshness?: FreshnessStatus;
  error?: RetrievalActionableError;
}

export interface RecentActivityRequest {
  minutes: number;
  format: 'summary' | 'raw';
}

export interface RecentActivityResult {
  summary: string;
  evidence: RetrievalEvidenceItem[];
  raw?: RetrievalEvidenceItem[];
  freshness?: FreshnessStatus;
  error?: RetrievalActionableError;
}

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

export interface SearchScreenService {
  search(request: SearchScreenRequest): Promise<SearchScreenResult>;
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

export interface RecentActivityService {
  getRecentActivity(request: RecentActivityRequest): Promise<RecentActivityResult>;
}
