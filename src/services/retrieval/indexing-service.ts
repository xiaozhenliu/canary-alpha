import type { PrivacyState, PrivacyStateReader, PrivacySuppressedRange } from '../privacy/types.js';
import { DEFAULT_PRIVACY_STATE } from '../privacy/types.js';
import type {
  CaptureClient,
  CaptureRecord,
  CheckpointStore,
  EmbeddingProvider,
  IndexedBacklogProgress,
  IndexedCheckpoint,
  IndexingRunResult,
  IndexingService,
  VectorStore,
  VectorStoreRecord
} from './types.js';
import type { AppConfig, Logger } from '../../types/app-config.js';
import { normalizeToUtc } from '../../lib/time.js';
import type { ExtractionRegistry, ExtractionInput, ExtractionResult } from '../work-activity/extraction/types.js';
import type { ExtractedContentStore } from '../work-activity/extraction/extracted-content-store.js';
import type { SessionAggregator } from '../work-activity/sessions/aggregator.js';
import type { EmbeddingService, ComputeEmbeddingOutcome, EmbeddingOutcome } from '../work-activity/embedding-service.js';
import { buildCaptureId } from '../capture/types.js';

// ---------------------------------------------------------------------------
// Internal record shapes used by the concurrent embedding pipeline
// ---------------------------------------------------------------------------

/**
 * Internal return shape used by both the concurrent embedding path and the
 * serial blocked-records path. Kept as a shared struct so checkpoint-
 * advancement / error-handling rules are documented in one place.
 */
interface ProcessRecordOutcome {
  /** The record produced a vector-store write (fresh or reused-hash). */
  indexed: boolean;
  /** Embedding-provider error, if any — caller assigns to firstEmbeddingError. */
  error: unknown;
  /** Should the caller advance the checkpoint past this record? */
  advanceCheckpoint: boolean;
}

/**
 * A record that has passed privacy gating and extraction. Carries both
 * the original capture record and its extraction result so the concurrent
 * embedding step can reference both without re-running extraction.
 */
interface PreparedRecord {
  record: CaptureRecord;
  extraction: ExtractionResult;
}

/**
 * Result produced by the concurrent embedding step for a single record.
 * Carries the computed embedding and hash when a vector-store write is
 * warranted so the batch upsert step can operate without re-calling the
 * embedding service.
 */
interface EmbedResult {
  record: CaptureRecord;
  extraction: ExtractionResult;
  outcome: ProcessRecordOutcome;
  embedding?: number[];
  extractedTextHash?: string;
}

// ---------------------------------------------------------------------------
// Public dependency contract
// ---------------------------------------------------------------------------

export interface IndexingServiceDependencies {
  /**
   * Embedding provider — retained on the dependencies bag for parity with
   * the rest of the retrieval pipeline (and so the wiring layer in
   * `create-app.ts` can build the `EmbeddingService` from a single source
   * of truth). The indexing service itself no longer calls `embed()`
   * directly: per work-activity-analysis design §7 every embedding call
   * goes through `embeddingService.embedExtraction()` which wraps SHA256
   * deduplication and the hash-cache.
   */
  embeddingProvider: EmbeddingProvider;
  captureClient: CaptureClient;
  /**
   * Vector store — likewise retained on the dependencies bag for
   * parity. The indexing service no longer writes to it directly; the
   * `embeddingService` owns vector-store upserts (one per non-empty
   * extraction, keyed by `extracted:${frameId}` so Cascade_Delete can
   * remove rows by frame).
   */
  vectorStore: VectorStore;
  checkpointStore: CheckpointStore;
  freshnessWindowMinutes: number;
  maxCatchUpBatches: number;
  maxCatchUpRecords: number;
  privacyState?: PrivacyStateReader;
  config?: Pick<AppConfig, 'privacy'>;
  logger?: Logger;
  // ---------------------------------------------------------------------
  // work-activity-analysis (task 6.1): pipeline tail collaborators.
  // ---------------------------------------------------------------------
  /**
   * Resolves an `ExtractionInput` to an `ExtractionResult`. The chain
   * (TerminalRefinementRule → GenericHeuristicRule) is wired in
   * `create-app.ts`; tests substitute a stub registry to drive specific
   * branches without re-implementing the AX walk.
   */
  extractionRegistry: ExtractionRegistry;
  /**
   * Persists per-frame `ExtractionResult` rows to the derived database.
   * Called inside the per-record loop **before** session aggregation and
   * embedding so a provider failure later in the loop still leaves a
   * keyword-searchable extracted_content row (design §7 graceful
   * degradation).
   */
  extractedContentStore: ExtractedContentStore;
  /**
   * Folds the extraction stream into Open_Sessions. `flushIdleOpenSessions`
   * runs once at the start of `runOnce()` (R3.6) so any session whose
   * `ended_at < now - idleThreshold` is closed before the loop appends
   * fresh frames to the same `(appName, contextKey)` bucket.
   */
  sessionAggregator: SessionAggregator;
  /**
   * Owns embedding generation, hash-dedup, and vector-store upserts.
   * Returns an `EmbeddingOutcome` per extraction; the indexing service
   * inspects `outcome.kind === 'provider-unavailable'` to populate
   * `firstEmbeddingError` and gate checkpoint advancement (matching the
   * pre-change semantics — a provider failure on a non-empty record
   * stops the checkpoint from moving past it).
   */
  embeddingService: EmbeddingService;
  /**
   * Maximum number of concurrent `computeEmbedding()` calls that may be
   * in-flight at once within a single `runOnce()`. Values <= 1 fall back
   * to effectively serial execution (one promise at a time). Defaults to
   * `DEFAULT_EMBEDDING_CONCURRENCY` (2) when wired by `create-app.ts`.
   */
  embeddingConcurrency: number;
  /**
   * Provider name used to build the neutral `captureId` metadata field
   * on each `VectorStoreRecord` upserted during the batch write step.
   * Must match `captureProvider.capabilities.providerName` (e.g. 'screenpipe').
   */
  captureProviderName: string;
}

interface FetchCandidateRecordsResult {
  fetched: number;
  records: CaptureRecord[];
  backlogAfter: IndexedBacklogProgress | null;
  usedBacklog: boolean;
}


function getLagMilliseconds(checkpoint: IndexedCheckpoint | null, now: Date): number {
  if (!checkpoint) {
    return Number.POSITIVE_INFINITY;
  }

  const lagMs = now.getTime() - new Date(checkpoint.timestamp).getTime();
  return Math.max(0, lagMs);
}

function getFetchWindowMinutes(
  checkpoint: IndexedCheckpoint | null,
  now: Date,
  options: Pick<IndexingServiceDependencies, 'freshnessWindowMinutes' | 'maxCatchUpBatches'>
): number {
  const maxWindowMinutes = options.freshnessWindowMinutes * options.maxCatchUpBatches;
  if (!checkpoint) {
    return maxWindowMinutes;
  }

  const lagMinutes = Math.ceil(getLagMilliseconds(checkpoint, now) / 60_000);
  return Math.min(Math.max(lagMinutes, options.freshnessWindowMinutes), maxWindowMinutes);
}

function getSearchStartTime(checkpoint: IndexedCheckpoint | null, now: Date, windowMinutes: number): string {
  const windowStart = new Date(now.getTime() - windowMinutes * 60_000).toISOString();
  if (!checkpoint) {
    return windowStart;
  }

  return compareTimestamps(checkpoint.timestamp, windowStart) > 0 ? checkpoint.timestamp : windowStart;
}

function isNewerThanCheckpoint(record: CaptureRecord, checkpoint: IndexedCheckpoint | null): boolean {
  if (!checkpoint) {
    return true;
  }

  const timestampComparison = compareTimestamps(record.timestamp, checkpoint.timestamp);
  if (timestampComparison > 0) {
    return true;
  }

  if (timestampComparison < 0) {
    return false;
  }

  return record.id > (checkpoint.cursor ?? '');
}

function compareRecords(left: CaptureRecord, right: CaptureRecord): number {
  const timestampComparison = compareTimestamps(left.timestamp, right.timestamp);
  if (timestampComparison === 0) {
    return left.id.localeCompare(right.id);
  }

  return timestampComparison;
}

function toCheckpoint(record: CaptureRecord): IndexedCheckpoint {
  return {
    cursor: record.id,
    timestamp: record.timestamp
  };
}

/**
 * Build the `ExtractionInput` consumed by the extraction registry from a
 * `CaptureRecord`. The conversion is straightforward — every field
 * the registry needs is already on the record; `accessibilityTreeJson`
 * is forwarded as `null` when the upstream capture client has
 * not populated it.
 *
 * Compatibility shim: if the upstream did NOT populate
 * `accessibilityTreeJson` but the record carries `text`, synthesise a
 * minimal one-node AX tree wrapping the text so the
 * `GenericHeuristicRule` can produce a non-empty extraction. This keeps
 * the rebuild-index acceptance path working for OCR-only records and
 * preserves the pre-task-6.1 behaviour where any record with text was
 * always indexable. Once the HTTP client starts pulling
 * `accessibility_tree_json` natively (a future task) this synthesis
 * will become a no-op for AX records (they carry their real tree) and
 * a documented fallback for OCR records.
 */
function toExtractionInput(record: CaptureRecord): ExtractionInput {
  return {
    frameId: record.frameId ?? hashStringToNumericId(record.id),
    frameTimestamp: normalizeToUtc(record.timestamp),
    appName: record.appName,
    windowTitle: record.windowName,
    accessibilityTreeJson: resolveAccessibilityTreeJson(record),
    sourceTypes: record.sourceTypes
  };
}

/**
 * Returns the `accessibility_tree_json` payload the registry should
 * consume. When the record carries an explicit `accessibilityTreeJson`
 * — null or non-null — that value wins (callers explicitly choose to
 * pass `null` when they want Empty_Extraction). When the field is
 * `undefined` (the current production state, since the capture
 * client does not yet populate it) and the record
 * carries non-empty `text`, synthesise a minimal AX tree so the
 * extraction layer can recover the text.
 *
 * The synthetic tree is `{ role: 'AXWebArea', value: '<text>' }`, which
 * is one of the {@link FOCUS_FALLBACK_ROLES} the
 * `GenericHeuristicRule` accepts as an anchor. The wrapping role
 * choice is arbitrary among the four fallback roles; `AXWebArea` was
 * picked because it is the broadest semantic match for "rendered
 * text content" and is the role most likely to appear in real AX
 * captures of OCR-eligible content.
 */
function resolveAccessibilityTreeJson(record: CaptureRecord): string | null {
  if (record.accessibilityTreeJson !== undefined) {
    return record.accessibilityTreeJson;
  }
  if (typeof record.text === 'string' && record.text !== '') {
    return JSON.stringify({ role: 'AXWebArea', value: record.text });
  }
  return null;
}

/**
 * Deterministic 32-bit hash of a string used as a fallback `frameId`
 * for records that don't carry a numeric `frameId` (OCR-only records
 * or older fixtures). The algorithm is a basic FNV-1a 32-bit variant
 * — it is deterministic across processes and has acceptable
 * collision behaviour for short string ids, but it is **not**
 * collision-free in the cryptographic sense. A pair of structurally
 * different `record.id` values can map to the same numeric frameId
 * with probability ~1/2^32. Within a single batch the upstream merge
 * already de-duplicates by `record.id`, so the only realistic
 * collision risk is across runs that happen to pick clashing ids —
 * the consequence is a false-positive cache hit during a single
 * `runOnce()`, which manifests as a hash-cache reuse that the
 * dedup-by-frameId vector-store row keying isolates per frame.
 *
 * Exported so test helpers can derive the same fallback `frameId`
 * when wiring stub work-activity collaborators (see
 * `tests/helpers/indexing-test-doubles.ts`).
 */
export function hashStringToNumericId(input: string): number {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // Multiply by FNV prime (16777619) using imul for proper 32-bit semantics
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned 32-bit so the value never appears negative.
  return hash >>> 0;
}

function getBacklogProgress(
  checkpoint: IndexedCheckpoint | null,
  now: Date,
  options: Pick<IndexingServiceDependencies, 'freshnessWindowMinutes' | 'maxCatchUpBatches'>
): IndexedBacklogProgress | null {
  if (checkpoint?.backlog) {
    return checkpoint.backlog;
  }

  const windowMinutes = getFetchWindowMinutes(checkpoint, now, options);
  const lagMs = getLagMilliseconds(checkpoint, now);
  const needsBacklogCatchUp = !checkpoint || lagMs > windowMinutes * 60_000;
  if (!needsBacklogCatchUp) {
    return null;
  }

  return {
    from: getSearchStartTime(checkpoint, now, windowMinutes),
    to: now.toISOString(),
    nextOffset: 0
  };
}

function withBacklogState(
  checkpoint: IndexedCheckpoint | null,
  backlog: IndexedBacklogProgress | null
): IndexedCheckpoint | null {
  if (!checkpoint) {
    return null;
  }

  if (!backlog) {
    return checkpoint.backlog
      ? {
          cursor: checkpoint.cursor,
          timestamp: checkpoint.timestamp
        }
      : checkpoint;
  }

  return {
    cursor: checkpoint.cursor,
    timestamp: checkpoint.timestamp,
    backlog
  };
}

async function persistCheckpointIfChanged(
  store: CheckpointStore,
  checkpointBefore: IndexedCheckpoint | null,
  checkpointAfter: IndexedCheckpoint | null
): Promise<void> {
  if (!checkpointAfter || areCheckpointsEqual(checkpointBefore, checkpointAfter)) {
    return;
  }

  await store.writeLatest(checkpointAfter);
}

function areCheckpointsEqual(left: IndexedCheckpoint | null, right: IndexedCheckpoint | null): boolean {
  if (!left || !right) {
    return left === right;
  }

  return left.cursor === right.cursor
    && left.timestamp === right.timestamp
    && left.backlog?.from === right.backlog?.from
    && left.backlog?.to === right.backlog?.to
    && left.backlog?.nextOffset === right.backlog?.nextOffset;
}

function normalizeAppName(appName: string): string {
  return appName.toLowerCase();
}

function isExcluded(record: CaptureRecord, privacy: PrivacyState): boolean {
  if (!record.appName) {
    return false;
  }

  const normalizedAppName = normalizeAppName(record.appName);
  return privacy.excludedApps.some((excludedApp) => normalizeAppName(excludedApp) === normalizedAppName);
}

function toTimestampMillis(timestamp: string): number | null {
  const millis = Date.parse(timestamp);
  return Number.isNaN(millis) ? null : millis;
}

function compareTimestamps(left: string, right: string): number {
  const leftMillis = toTimestampMillis(left);
  const rightMillis = toTimestampMillis(right);
  if (leftMillis !== null && rightMillis !== null) {
    return leftMillis - rightMillis;
  }

  return left.localeCompare(right);
}

function intersectsSuppressedRange(timestamp: string, range: PrivacySuppressedRange): boolean {
  const timestampMillis = toTimestampMillis(timestamp);
  const fromMillis = toTimestampMillis(range.from);
  const toMillis = toTimestampMillis(range.to);
  if (timestampMillis === null || fromMillis === null || toMillis === null) {
    return timestamp >= range.from && timestamp <= range.to;
  }

  return timestampMillis >= fromMillis && timestampMillis <= toMillis;
}

function isSuppressed(record: CaptureRecord, privacy: PrivacyState): boolean {
  const suppressedRanges = privacy.suppressedRanges ?? [];
  return suppressedRanges.some((range) => intersectsSuppressedRange(record.timestamp, range));
}

function isBlockedByPause(record: CaptureRecord, privacy: PrivacyState): boolean {
  if (!privacy.paused || !privacy.pauseStartedAt) {
    return false;
  }

  return compareTimestamps(record.timestamp, privacy.pauseStartedAt) >= 0;
}

function isBlockedByPrivacy(record: CaptureRecord, privacy: PrivacyState): boolean {
  return isExcluded(record, privacy) || isSuppressed(record, privacy) || isBlockedByPause(record, privacy);
}

async function readPrivacyState(reader?: PrivacyStateReader): Promise<PrivacyState> {
  if (!reader) {
    return DEFAULT_PRIVACY_STATE;
  }

  return reader.read();
}

/**
 * Strip records whose AX role is in secureAxRoles, plus all their descendants
 * within the same frame (R4.4).
 *
 * Grouping is done per frameId. Within each frame, the function builds a
 * parent→children map using `parentId` (preferred) or `path` (fallback).
 *
 * Degraded mode (no parentId / path available): only the secure-role record
 * itself is filtered; subtree pruning is skipped and a debug log is emitted.
 */
export function stripSecureAxSubtrees(
  records: CaptureRecord[],
  secureAxRoles: string[],
  logger?: Logger
): CaptureRecord[] {
  if (secureAxRoles.length === 0) {
    return records;
  }

  const secureRoleSet = new Set(secureAxRoles.map((r) => r.toLowerCase()));

  function isSecureRole(record: CaptureRecord): boolean {
    return record.role !== undefined && secureRoleSet.has(record.role.toLowerCase());
  }

  // Group records by frameId (undefined frameId → each record is its own group)
  const byFrame = new Map<string, CaptureRecord[]>();
  for (const record of records) {
    const key = record.frameId !== undefined ? `frame:${record.frameId}` : `id:${record.id}`;
    const group = byFrame.get(key);
    if (group) {
      group.push(record);
    } else {
      byFrame.set(key, [record]);
    }
  }

  const filtered: CaptureRecord[] = [];

  for (const group of byFrame.values()) {
    // Check if any record in this group has parentId or path for tree traversal
    const hasTreeInfo = group.some((r) => r.parentId !== undefined || r.path !== undefined);

    const secureRecords = group.filter(isSecureRole);
    if (secureRecords.length === 0) {
      // No secure records in this group — keep all
      filtered.push(...group);
      continue;
    }

    if (!hasTreeInfo) {
      // Degraded mode: only filter the secure-role records themselves
      logger?.debug('secureAxRoles: subtree pruning disabled, parent_id missing');
      filtered.push(...group.filter((r) => !isSecureRole(r)));
      continue;
    }

    // Full subtree pruning mode
    // Build id → record map and parent → children map
    const byId = new Map<string, CaptureRecord>();
    for (const r of group) {
      byId.set(r.id, r);
    }

    // Build children map using parentId
    const children = new Map<string, Set<string>>();
    for (const r of group) {
      if (r.parentId !== undefined) {
        let childSet = children.get(r.parentId);
        if (!childSet) {
          childSet = new Set();
          children.set(r.parentId, childSet);
        }
        childSet.add(r.id);
      }
    }

    // If parentId is not available but path is, build children map from path
    // path format: '0.1.2' — a record's parent has path '0.1'
    if (!group.some((r) => r.parentId !== undefined) && group.some((r) => r.path !== undefined)) {
      for (const r of group) {
        if (r.path === undefined) continue;
        const parts = r.path.split('.');
        if (parts.length > 1) {
          const parentPath = parts.slice(0, -1).join('.');
          // Find the record with this parent path
          for (const candidate of group) {
            if (candidate.path === parentPath) {
              let childSet = children.get(candidate.id);
              if (!childSet) {
                childSet = new Set();
                children.set(candidate.id, childSet);
              }
              childSet.add(r.id);
              break;
            }
          }
        }
      }
    }

    // BFS/DFS to collect all descendants of secure records
    const blockedIds = new Set<string>();
    const queue: string[] = [];

    for (const secureRecord of secureRecords) {
      blockedIds.add(secureRecord.id);
      queue.push(secureRecord.id);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const childIds = children.get(current);
      if (childIds) {
        for (const childId of childIds) {
          if (!blockedIds.has(childId)) {
            blockedIds.add(childId);
            queue.push(childId);
          }
        }
      }
    }

    filtered.push(...group.filter((r) => !blockedIds.has(r.id)));
  }

  return filtered;
}

async function fetchCandidateRecords(
  deps: Pick<IndexingServiceDependencies, 'captureClient' | 'freshnessWindowMinutes' | 'maxCatchUpBatches' | 'maxCatchUpRecords'>,
  checkpoint: IndexedCheckpoint | null,
  now: Date,
  forcedBacklog?: IndexedBacklogProgress | null
): Promise<FetchCandidateRecordsResult> {
  const backlog = forcedBacklog ?? getBacklogProgress(checkpoint, now, deps);
  if (!backlog) {
    const windowMinutes = getFetchWindowMinutes(checkpoint, now, deps);
    const records = await deps.captureClient.recent(windowMinutes);
    return {
      fetched: records.length,
      records,
      backlogAfter: null,
      usedBacklog: false
    };
  }

  const records: CaptureRecord[] = [];
  let offset = backlog.nextOffset;
  let backlogAfter: IndexedBacklogProgress | null = backlog;

  for (let batch = 0; batch < deps.maxCatchUpBatches; batch += 1) {
    const page = await deps.captureClient.search({
      from: backlog.from,
      to: backlog.to,
      limit: deps.maxCatchUpRecords,
      offset
    });

    records.push(...page);
    offset += page.length;

    if (page.length < deps.maxCatchUpRecords) {
      backlogAfter = null;
      break;
    }

    backlogAfter = {
      ...backlog,
      nextOffset: offset
    };
  }

  return {
    fetched: records.length,
    records,
    backlogAfter,
    usedBacklog: true
  };
}

export class DefaultIndexingService implements IndexingService {
  constructor(private readonly deps: IndexingServiceDependencies) {}

  async runOnce(now = new Date(), forcedBacklog?: IndexedBacklogProgress | null): Promise<IndexingRunResult> {
    const checkpointBefore = await this.deps.checkpointStore.readLatest();

    try {
      await readPrivacyState(this.deps.privacyState);
    } catch {
      throw new Error('Privacy controls could not be loaded while processing indexing.');
    }

    // R3.6 — close any Open_Session whose `ended_at < now - idleThreshold`
    // *before* we start appending new frames. Without this flush, an
    // app-switch session that was kept open across `runOnce()` boundaries
    // would silently extend on the next frame even after a long idle
    // gap. The aggregator's `flushIdleOpenSessions` is idempotent so a
    // second call within the same `now` is a no-op.
    await this.deps.sessionAggregator.flushIdleOpenSessions(now);

    const {
      fetched,
      records: fetchedRecords,
      backlogAfter,
      usedBacklog
    } = await fetchCandidateRecords(this.deps, checkpointBefore, now, forcedBacklog);

    const recordsAfterCheckpoint = usedBacklog
      ? [...fetchedRecords].sort(compareRecords)
      : fetchedRecords
        .filter((record) => isNewerThanCheckpoint(record, checkpointBefore))
        .sort(compareRecords)
        .slice(0, this.deps.maxCatchUpRecords);

    // Strip Secure_AX_Field subtrees before extraction (R4.4). The pruned
    // record set is what the work-activity tail consumes — secure-role
    // descendants never reach the extraction registry, the
    // extracted_content table, or the embedding service.
    const secureAxRoles = this.deps.config?.privacy?.secureAxRoles ?? ['AXSecureTextField'];
    const recordsAfterSecureFilter = stripSecureAxSubtrees(
      recordsAfterCheckpoint,
      secureAxRoles,
      this.deps.logger
    );

    // -----------------------------------------------------------------------
    // Step 1 (serial): extraction + content-store + session-aggregation.
    // Privacy is re-read per record; blocked records are deferred for the
    // re-check loop below.
    // -----------------------------------------------------------------------
    const { prepared, blocked: blockedRecordsList } = await this.extractAll(
      recordsAfterSecureFilter,
      this.deps.privacyState
    );
    let blockedRecords: CaptureRecord[] = blockedRecordsList;

    // -----------------------------------------------------------------------
    // Step 2 (concurrent): compute embeddings via a sliding-window pool.
    // No vector-store writes happen here — only the embedding (and hash-cache
    // insert) is performed so the pool can overlap I/O-bound HTTP calls.
    // -----------------------------------------------------------------------
    const embedResults = await this.embedConcurrently(prepared);

    // -----------------------------------------------------------------------
    // Step 3 (serial): batch vector-store upsert for all successful embeddings.
    // A single upsert call keeps the vector-store write atomic from the store's
    // perspective and matches the pre-refactor one-upsert-per-runOnce contract
    // that many tests assert on.
    // -----------------------------------------------------------------------
    const vectorRecords: VectorStoreRecord[] = [];
    for (const e of embedResults) {
      if (e.outcome.indexed && e.embedding !== undefined && e.extractedTextHash !== undefined) {
        vectorRecords.push(this.buildVectorStoreRecord(e.extraction, e.extractedTextHash, e.embedding));
      }
    }
    if (vectorRecords.length > 0) {
      try {
        await this.deps.vectorStore.upsert(vectorRecords);
      } catch (error) {
        // All-or-nothing: a batch upsert failure poisons the entire batch because
        // FileBackedVectorStore does a read-modify-write cycle — partial success is
        // not possible. All indexed outcomes are reset so the checkpoint does not
        // advance past records whose embedding was not persisted.
        for (const e of embedResults) {
          if (e.outcome.indexed) {
            e.outcome = { indexed: false, error, advanceCheckpoint: false };
          }
        }
      }
    }

    // Accumulate checkpoint / error signals from the concurrent embed results.
    // We collect all (record, advanceCheckpoint) pairs from every processing
    // path before computing latestCheckpoint. This lets us determine the full
    // failure ceiling first, then apply it in a single forward pass — avoiding
    // the rollback complexity that arises when released-blocked failures lower
    // the ceiling below what the embed phase already advanced the checkpoint to.
    let indexedCount = 0;
    let firstEmbeddingError: unknown;

    // Pairs of (record, advanceCheckpoint) accumulated from the embed phase
    // AND the released-blocked phase. Privacy-permanently-blocked records are
    // handled separately at the end.
    const checkpointCandidates: Array<{ record: CaptureRecord; advance: boolean }> = [];

    for (const e of embedResults) {
      if (e.outcome.indexed) indexedCount += 1;
      if (e.outcome.error !== undefined) firstEmbeddingError ??= e.outcome.error;
      checkpointCandidates.push({ record: e.record, advance: e.outcome.advanceCheckpoint });
    }

    // -----------------------------------------------------------------------
    // Blocked-records re-check loop (identical semantics to the old loop):
    // re-reads privacy state each iteration; records that are no longer
    // blocked are processed via the serial `processRecord` path (which goes
    // through the old embedExtraction path — vector-store upsert per record).
    // -----------------------------------------------------------------------
    let finalPrivacy: PrivacyState;
    while (true) {
      try {
        finalPrivacy = await readPrivacyState(this.deps.privacyState);
      } catch {
        throw new Error('Privacy controls could not be loaded while processing indexing.');
      }

      const stillBlockedRecords: CaptureRecord[] = [];
      let releasedBlockedRecord = false;

      for (const record of blockedRecords) {
        if (isBlockedByPrivacy(record, finalPrivacy)) {
          stillBlockedRecords.push(record);
          continue;
        }

        releasedBlockedRecord = true;
        const advanced = await this.processRecord(record);
        if (advanced.indexed) indexedCount += 1;
        if (advanced.error !== undefined) firstEmbeddingError ??= advanced.error;
        checkpointCandidates.push({ record, advance: advanced.advanceCheckpoint });
      }

      blockedRecords = stillBlockedRecords;
      if (!releasedBlockedRecord) {
        break;
      }
    }

    // -----------------------------------------------------------------------
    // Compute the checkpoint ceiling: the earliest record (by compareRecords
    // ordering) that failed embedding. The checkpoint must not advance to any
    // record that compares >= this ceiling, ensuring failed frames are retried.
    // Using compareRecords() (which uses cursor for same-timestamp tiebreaking)
    // matches the ordering already used by isNewerThanCheckpoint().
    // -----------------------------------------------------------------------
    let failureCeilingRecord: CaptureRecord | undefined;
    for (const c of checkpointCandidates) {
      if (!c.advance) {
        if (
          failureCeilingRecord === undefined ||
          compareRecords(c.record, failureCeilingRecord) < 0
        ) {
          failureCeilingRecord = c.record;
        }
      }
    }

    // Derive latestCheckpoint in a single forward pass over all candidates.
    let latestCheckpoint: IndexedCheckpoint | null = checkpointBefore
      ? {
          cursor: checkpointBefore.cursor,
          timestamp: checkpointBefore.timestamp
        }
      : null;

    for (const c of checkpointCandidates) {
      if (c.advance && isNewerThanCheckpoint(c.record, latestCheckpoint)) {
        // Do not advance past the earliest failed frame.
        if (
          failureCeilingRecord !== undefined &&
          compareRecords(c.record, failureCeilingRecord) >= 0
        ) {
          continue;
        }
        latestCheckpoint = toCheckpoint(c.record);
      }
    }

    // Records that remained blocked through the entire pass advance the
    // checkpoint past them only when no embedding failure has happened
    // and the record is strictly before the failure ceiling
    // — same semantics as the pre-task-6.1 implementation. A blocked
    // record is one we *intentionally* don't index (privacy filter), so
    // there's no need to re-fetch it on the next tick once its
    // timestamp is older than the checkpoint.
    for (const record of blockedRecords) {
      if (firstEmbeddingError) {
        break;
      }

      // Do not advance the checkpoint past the earliest embedding failure.
      if (
        failureCeilingRecord !== undefined &&
        compareRecords(record, failureCeilingRecord) >= 0
      ) {
        continue;
      }

      if (isNewerThanCheckpoint(record, latestCheckpoint)) {
        latestCheckpoint = toCheckpoint(record);
      }
    }

    const checkpointAfter = withBacklogState(latestCheckpoint, backlogAfter);

    // Persist checkpoint and surface error semantics matching the
    // pre-task-6.1 contract:
    //
    //   - Some records were indexed → persist checkpoint, return.
    //   - No records indexed and no provider failure (e.g. all empty
    //     extractions or all blocked) → persist checkpoint, return.
    //   - No records indexed but a provider failure happened → throw
    //     the first error so the poller surfaces it. If there are
    //     unblocked records still pending privacy review, persist the
    //     checkpoint *before* throwing so the next tick advances past
    //     the records we already saw.
    if (indexedCount === 0) {
      if (!firstEmbeddingError) {
        await persistCheckpointIfChanged(this.deps.checkpointStore, checkpointBefore, checkpointAfter);

        return {
          fetched,
          indexed: 0,
          checkpointBefore,
          checkpointAfter,
          hadEmbeddingFailures: false
        };
      }

      const shouldPersistCheckpointBeforeThrow = blockedRecords.length > 0;
      if (shouldPersistCheckpointBeforeThrow) {
        await persistCheckpointIfChanged(this.deps.checkpointStore, checkpointBefore, checkpointAfter);
      }

      throw firstEmbeddingError instanceof Error
        ? firstEmbeddingError
        : new Error('Embedding provider failed for every record in the indexing batch.');
    }

    await persistCheckpointIfChanged(this.deps.checkpointStore, checkpointBefore, checkpointAfter);

    return {
      fetched,
      indexed: indexedCount,
      checkpointBefore,
      checkpointAfter,
      hadEmbeddingFailures: firstEmbeddingError !== undefined
    };
  }

  /**
   * Step 1 — serial extraction loop.
   *
   * For each record, refreshes the privacy state, skips blocked records into
   * the `blocked` output array, runs the extraction registry, persists the
   * extracted_content row, and notifies the session aggregator. Records that
   * pass all checks are collected into `prepared` for the concurrent
   * embedding step.
   *
   * Privacy is re-read per record (not once up-front) so a user can pause /
   * exclude an app mid-batch and have the change take effect as soon as the
   * next record is evaluated — matching the semantics of the old serial loop.
   */
  private async extractAll(
    records: CaptureRecord[],
    privacyReader?: PrivacyStateReader
  ): Promise<{ prepared: PreparedRecord[]; blocked: CaptureRecord[] }> {
    const prepared: PreparedRecord[] = [];
    const blocked: CaptureRecord[] = [];
    for (const record of records) {
      let privacy: PrivacyState;
      try {
        privacy = await readPrivacyState(privacyReader);
      } catch {
        throw new Error('Privacy controls could not be loaded while processing indexing.');
      }
      if (isBlockedByPrivacy(record, privacy)) {
        blocked.push(record);
        continue;
      }
      const extraction = this.deps.extractionRegistry.extract(toExtractionInput(record));
      await this.deps.extractedContentStore.upsert(extraction);
      await this.deps.sessionAggregator.handleExtraction(extraction);
      prepared.push({ record, extraction });
    }
    return { prepared, blocked };
  }

  /**
   * Step 2 — concurrent embedding via a sliding-window promise pool.
   *
   * Keeps at most `embeddingConcurrency` `computeEmbedding()` calls in-flight
   * at any time. As each promise settles, the next record is launched so the
   * window stays full until all records have been submitted. Results are stored
   * at the same index as the input so the batch upsert step can iterate them
   * in the original order.
   *
   * Only `computeEmbedding` (no vector-store write) is called here; the
   * returned embedding and hash are carried in `EmbedResult` for Step 3 to
   * batch-upsert.
   *
   * Errors thrown by `computeEmbedding` (unexpected; it should return
   * `provider-unavailable` instead) are caught and stored as
   * `provider-unavailable` outcomes so the pool never terminates early.
   */
  private async embedConcurrently(prepared: PreparedRecord[]): Promise<EmbedResult[]> {
    const results: EmbedResult[] = new Array(prepared.length);
    const inFlight = new Set<Promise<void>>();
    let nextIndex = 0;

    const launch = (index: number): void => {
      const { record, extraction } = prepared[index];
      const promise = this.deps.embeddingService.computeEmbedding(extraction)
        .then((computeOutcome: ComputeEmbeddingOutcome) => {
          switch (computeOutcome.kind) {
            case 'skipped-empty':
              results[index] = {
                record, extraction,
                outcome: { indexed: false, error: undefined, advanceCheckpoint: true }
              };
              break;
            case 'reused-hash':
            case 'computed':
              results[index] = {
                record, extraction,
                outcome: { indexed: true, error: undefined, advanceCheckpoint: true },
                embedding: computeOutcome.embedding,
                extractedTextHash: computeOutcome.extractedTextHash
              };
              break;
            case 'provider-unavailable':
              results[index] = {
                record, extraction,
                outcome: { indexed: false, error: computeOutcome.error, advanceCheckpoint: false }
              };
              break;
          }
        })
        .catch((error: unknown) => {
          results[index] = {
            record, extraction,
            outcome: { indexed: false, error, advanceCheckpoint: false }
          };
        })
        .finally(() => { inFlight.delete(promise); });
      inFlight.add(promise);
    };

    const concurrency = Math.max(1, this.deps.embeddingConcurrency);
    while (nextIndex < prepared.length || inFlight.size > 0) {
      while (nextIndex < prepared.length && inFlight.size < concurrency) {
        launch(nextIndex);
        nextIndex += 1;
      }
      if (inFlight.size > 0) {
        await Promise.race(inFlight);
      }
    }

    return results;
  }

  /**
   * Builds the per-frame `VectorStoreRecord` from an extraction result, the
   * service-recomputed hash, and the embedding produced by Step 2. The id
   * is derived from `frameId` (not from the hash) so distinct frames sharing
   * the same text still produce distinct rows — Cascade_Delete can then
   * remove evidence by frame without orphaning embeddings.
   */
  private buildVectorStoreRecord(
    e: ExtractionResult,
    extractedTextHash: string,
    embedding: number[]
  ): VectorStoreRecord {
    return {
      id: `extracted:${e.frameId}`,
      text: e.extractedText,
      timestamp: e.frameTimestamp,
      appName: e.appName,
      sourceTypes: e.sourceTypes,
      embedding,
      metadata: {
        sourceTypes: e.sourceTypes,
        frameId: e.frameId,
        captureId: buildCaptureId(this.deps.captureProviderName, {
          frameId: e.frameId,
          id: String(e.frameId)
        }),
        frameTimestamp: e.frameTimestamp,
        contextKey: e.contextKey,
        extractedTextHash,
        appName: e.appName ?? ''
      }
    };
  }

  /**
   * Serial work-activity tail for a single record — used exclusively by the
   * blocked-records re-check loop where records arrive after extraction was
   * already bypassed (they were not part of the Step 1 `extractAll` batch).
   *
   * Runs extraction → extracted_content store → session aggregator →
   * embedExtraction (which includes a vector-store upsert). This mirrors the
   * pre-refactor per-record path so the blocked-records semantics are
   * preserved unchanged.
   */
  private async processRecord(record: CaptureRecord): Promise<ProcessRecordOutcome> {
    const extraction = this.deps.extractionRegistry.extract(toExtractionInput(record));
    await this.deps.extractedContentStore.upsert(extraction);
    await this.deps.sessionAggregator.handleExtraction(extraction);
    const outcome = await this.deps.embeddingService.embedExtraction(extraction);

    return mapEmbeddingOutcome(outcome);
  }
}

/**
 * Converts an `EmbeddingOutcome` (returned by `embedExtraction`, which owns
 * the vector-store write) to the `ProcessRecordOutcome` shape used by the
 * blocked-records re-check loop. The mapping mirrors the switch in the old
 * serial loop and in the concurrent embedding step.
 */
function mapEmbeddingOutcome(outcome: EmbeddingOutcome): ProcessRecordOutcome {
  switch (outcome.kind) {
    case 'embedded':
    case 'reused-hash':
      return { indexed: true, error: undefined, advanceCheckpoint: true };
    case 'skipped-empty':
      return { indexed: false, error: undefined, advanceCheckpoint: true };
    case 'provider-unavailable':
      return { indexed: false, error: outcome.error, advanceCheckpoint: false };
  }
}

export function createIndexingService(deps: IndexingServiceDependencies): IndexingService {
  return new DefaultIndexingService(deps);
}
