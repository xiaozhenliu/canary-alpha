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
import { DEFAULT_ANALYSIS_IDLE_THRESHOLD_SECONDS } from '../../config/schema.js';
import { normalizeToUtc } from '../../lib/time.js';
import { hashStringToNumericId } from '../../lib/hash.js';
import { stripSecureAxSubtrees, stripSecureAxTreeJson } from './strip-secure-ax-subtrees.js';
import type { CaptureFrameDetailPort } from '../capture/types.js';
import type { ExtractionRegistry, ExtractionInput, ExtractionResult } from '../work-activity/extraction/types.js';
import {
  LineDeltaDeduplicator,
  type LineDeltaDeduplicationToken,
  type LineDeltaDeduplicationTransaction
} from '../work-activity/extraction/universal.js';
import type { ExtractedContentStore } from '../work-activity/extraction/extracted-content-store.js';
import type { SessionAggregator } from '../work-activity/sessions/aggregator.js';
import type { SessionStore } from '../work-activity/sessions/session-store.js';
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
  /** Token used to commit the record's previewed deduplication state. */
  deduplicationToken: LineDeltaDeduplicationToken;
}

/**
 * A record that has passed privacy gating and extraction. Carries both
 * the original capture record and its extraction result so the concurrent
 * embedding step can reference both without re-running extraction.
 */
interface PreparedRecord {
  record: CaptureRecord;
  extraction: ExtractionResult;
  deduplicationToken: LineDeltaDeduplicationToken;
}

type EmbeddingProcessOutcome = Omit<ProcessRecordOutcome, 'deduplicationToken'>;

/**
 * Result produced by the concurrent embedding step for a single record.
 * Carries the computed embedding and hash when a vector-store write is
 * warranted so the batch upsert step can operate without re-calling the
 * embedding service.
 */
interface EmbedResult {
  record: CaptureRecord;
  extraction: ExtractionResult;
  deduplicationToken: LineDeltaDeduplicationToken;
  outcome: EmbeddingProcessOutcome;
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
  /** Optional provider-backed reader for the complete per-frame AX tree. */
  captureFrameDetail?: CaptureFrameDetailPort;
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
   * (TerminalRefinementRule → UniversalStructuredExtractor) is wired in
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
  /** Derived session store used to restore deduplication state after restart. */
  sessionStore?: SessionStore;
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
  /**
   * Session-scoped line-level delta deduplicator (USE-R05). Emits only new
   * or changed lines within the active session, suppressing redundant frames.
   */
  lineDeduplicator?: LineDeltaDeduplicator;
  /**
   * Must match `SessionAggregator`'s idle threshold so a new session starts
   * with a fresh line-deduplication context as well.
   */
  sessionIdleThresholdSeconds?: number;
}

interface CheckpointCandidate {
  record: CaptureRecord;
  advance: boolean;
  deduplicationToken: LineDeltaDeduplicationToken;
}

interface FetchCandidateRecordsResult {
  fetched: number;
  records: CaptureRecord[];
  backlogAfter: IndexedBacklogProgress | null;
  backlog: IndexedBacklogProgress | null;
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
 * `CaptureRecord`. The conversion resolves `accessibilityTreeJson` from
 * the record first, then the optional provider frame-detail port, before
 * falling back to a synthetic body tree for legacy text-only records.
 *
 * Compatibility shim: if the upstream did NOT populate
 * `accessibilityTreeJson` but the record carries `text`, synthesise a
 * minimal one-node AX tree wrapping the text so the
 * `GenericHeuristicRule` can produce a non-empty extraction. This keeps
 * the rebuild-index acceptance path working for OCR-only records and
 * preserves the pre-task-6.1 behaviour where any record with text was
 * always indexable. The HTTP client and optional frame-detail reader can
 * provide the real tree; synthesis remains the fallback for records that
 * do not expose either path.
 */
interface ResolvedExtractionInput {
  input: ExtractionInput;
  rawAccessibilityTreeJson: string | null;
}

async function toExtractionInput(
  record: CaptureRecord,
  captureFrameDetail?: CaptureFrameDetailPort,
  secureAxRoles: string[] = ['AXSecureTextField']
): Promise<ResolvedExtractionInput> {
  const rawAccessibilityTreeJson = await resolveAccessibilityTreeJson(record, captureFrameDetail);
  return {
    rawAccessibilityTreeJson,
    input: {
      frameId: record.frameId ?? hashStringToNumericId(record.id),
      frameTimestamp: normalizeToUtc(record.timestamp),
      captureCursor: record.id,
      appName: record.appName,
      windowTitle: record.windowName,
      accessibilityTreeJson: stripSecureAxTreeJson(rawAccessibilityTreeJson, secureAxRoles),
      sourceTypes: record.sourceTypes
    }
  };
}

function isAtOrBeforeCheckpoint(
  row: ExtractionResult,
  checkpoint: IndexedCheckpoint
): boolean {
  const timestampComparison = compareTimestamps(row.frameTimestamp, checkpoint.timestamp);
  if (timestampComparison < 0) return true;
  if (timestampComparison > 0) return false;

  // Same-timestamp rows follow the checkpoint's cursor ordering. Rows from
  // older schemas without a persisted capture cursor are conservatively
  // excluded because their position relative to the cursor is unknown.
  if (row.captureCursor === undefined || checkpoint.cursor === undefined) {
    return false;
  }
  return row.captureCursor <= checkpoint.cursor;
}

/**
 * Returns the `accessibility_tree_json` candidate the registry should
 * consume. A non-empty record-level `accessibilityTreeJson` takes precedence;
 * empty or null values fall through to frame detail and then to the text
 * fallback. A non-empty `text` value is wrapped in a minimal AX tree when
 * neither source carries a usable tree, so the extraction layer can recover
 * legacy text-only records. The caller also retries with this text fallback
 * when a non-empty tree parses but produces no extraction, preserving
 * OCR/text evidence when an upstream tree is malformed or unextractable.
 *
 * The synthetic tree is `{ role: 'AXWebArea', value: '<text>' }`, which
 * is one of the {@link FOCUS_FALLBACK_ROLES} the
 * `GenericHeuristicRule` accepts as an anchor. The wrapping role
 * choice is arbitrary among the four fallback roles; `AXWebArea` was
 * picked because it is the broadest semantic match for "rendered
 * text content" and is the role most likely to appear in real AX
 * captures of OCR-eligible content.
 */
async function resolveAccessibilityTreeJson(
  record: CaptureRecord,
  captureFrameDetail?: CaptureFrameDetailPort
): Promise<string | null> {
  if (record.accessibilityTreeJson !== undefined) {
    if (record.accessibilityTreeJson !== null && record.accessibilityTreeJson.trim() !== '') {
      return record.accessibilityTreeJson;
    }
  }

  if (captureFrameDetail !== undefined && record.frameId !== undefined) {
    try {
      const frame = await captureFrameDetail.getFrame(record.frameId);
      if (frame !== null) {
        const frameTree = frame.accessibilityTreeJson;
        if (frameTree !== null && frameTree.trim() !== '') {
          return frameTree;
        }
      }
    } catch {
      // Fall back to the provider record when frame detail is unavailable.
    }
  }

  if (typeof record.text === 'string' && record.text !== '') {
    return JSON.stringify({ role: 'AXWebArea', value: record.text });
  }
  return null;
}

async function extractRecord(
  record: CaptureRecord,
  captureFrameDetail: CaptureFrameDetailPort | undefined,
  extractionRegistry: ExtractionRegistry,
  secureAxRoles: string[]
): Promise<ExtractionResult> {
  const resolved = await toExtractionInput(record, captureFrameDetail, secureAxRoles);
  const input = resolved.input;
  const extraction = extractionRegistry.extract(input);
  if (
    extraction.extractedText !== '' ||
    record.text === '' ||
    containsSecureAxRole(resolved.rawAccessibilityTreeJson, secureAxRoles)
  ) {
    return extraction;
  }

  // A malformed or semantically empty AX tree must not suppress usable
  // provider text and advance the checkpoint as if the frame had content.
  return extractionRegistry.extract({
    ...input,
    accessibilityTreeJson: JSON.stringify({ role: 'AXWebArea', value: record.text })
  });
}

function containsSecureAxRole(
  treeJson: string | null,
  secureAxRoles: string[]
): boolean {
  if (treeJson === null || secureAxRoles.length === 0) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(treeJson);
  } catch {
    return false;
  }

  const secureRoleSet = new Set(secureAxRoles.map((role) => role.toLowerCase()));
  const stack: unknown[] = [parsed];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (current === null || typeof current !== 'object') continue;

    const node = current as Record<string, unknown>;
    if (typeof node.role === 'string' && secureRoleSet.has(node.role.toLowerCase())) {
      return true;
    }
    if (Array.isArray(node.children)) stack.push(...node.children);
  }

  return false;
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
      backlog: null
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
    backlog
  };
}

export class DefaultIndexingService implements IndexingService {
  private readonly lineDeduplicator: LineDeltaDeduplicator;
  private lineDeduplicationHydrated = false;

  constructor(private readonly deps: IndexingServiceDependencies) {
    this.lineDeduplicator = deps.lineDeduplicator ?? new LineDeltaDeduplicator({
      idleThresholdMs: (
        deps.sessionIdleThresholdSeconds ?? DEFAULT_ANALYSIS_IDLE_THRESHOLD_SECONDS
      ) * 1000
    });
  }

  async runOnce(now = new Date(), forcedBacklog?: IndexedBacklogProgress | null): Promise<IndexingRunResult> {
    const runStartTime = performance.now();
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
    await this.flushIdleSessionsAndResetDeduplication(now);
    await this.hydrateLineDeduplication(now, checkpointBefore);

    const {
      fetched,
      records: fetchedRecords,
      backlogAfter,
      backlog
    } = await fetchCandidateRecords(this.deps, checkpointBefore, now, forcedBacklog);

    // Search windows are inclusive at the lower bound, so the first backlog
    // page and recent path use the checkpoint cursor to exclude repeats. Once
    // a backlog has an offset, that provider cursor owns page membership; the
    // eligibility helper only guards against an exact repeated checkpoint row.
    const eligibleRecords = fetchedRecords
      .filter((record) => isEligibleBacklogRecord(record, checkpointBefore, backlog))
      .sort(compareRecords);
    const recordsAfterCheckpoint = backlog === null
      ? eligibleRecords.slice(0, this.deps.maxCatchUpRecords)
      : eligibleRecords;

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

    // Preview line-deduplication state for the whole run. It is committed
    // only after the checkpoint write succeeds, so a provider/vector-store
    // failure leaves the next retry able to emit the full missing context.
    const deduplication = this.lineDeduplicator.beginTransaction();

    // -----------------------------------------------------------------------
    // Step 1 (serial): extraction + content-store + session-aggregation.
    // Privacy is re-read per record; blocked records are deferred for the
    // re-check loop below.
    // -----------------------------------------------------------------------
    const { prepared, blocked: blockedRecordsList } = await this.extractAll(
      recordsAfterSecureFilter,
      this.deps.privacyState,
      deduplication,
      secureAxRoles
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
    const checkpointCandidates: CheckpointCandidate[] = [];

    for (const e of embedResults) {
      if (e.outcome.indexed) indexedCount += 1;
      if (e.outcome.error !== undefined) firstEmbeddingError ??= e.outcome.error;
      checkpointCandidates.push({
        record: e.record,
        advance: e.outcome.advanceCheckpoint,
        deduplicationToken: e.deduplicationToken
      });
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
        const advanced = await this.processRecord(record, deduplication, secureAxRoles);
        if (advanced.indexed) indexedCount += 1;
        if (advanced.error !== undefined) firstEmbeddingError ??= advanced.error;
        checkpointCandidates.push({
          record,
          advance: advanced.advanceCheckpoint,
          deduplicationToken: advanced.deduplicationToken
        });
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

    // Only records before the first failed record are durable from the
    // checkpoint's perspective. Successful records after that boundary will
    // be fetched again, so committing their preview would make the retry look
    // like an empty duplicate and overwrite its extracted content.
    const acceptedDeduplicationTokens = new Set<LineDeltaDeduplicationToken>();
    for (const candidate of checkpointCandidates) {
      if (
        candidate.advance &&
        (failureCeilingRecord === undefined ||
          compareRecords(candidate.record, failureCeilingRecord) < 0)
      ) {
        acceptedDeduplicationTokens.add(candidate.deduplicationToken);
      }
    }

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
        deduplication.commit(acceptedDeduplicationTokens);

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
        deduplication.commit(acceptedDeduplicationTokens);
      } else {
        deduplication.rollback();
      }

      throw firstEmbeddingError instanceof Error
        ? firstEmbeddingError
        : new Error('Embedding provider failed for every record in the indexing batch.');
    }

    await persistCheckpointIfChanged(this.deps.checkpointStore, checkpointBefore, checkpointAfter);
    deduplication.commit(acceptedDeduplicationTokens);

    const runDurationMs = Math.round(performance.now() - runStartTime);
    if (fetched > 0 || indexedCount > 0) {
      this.deps.logger?.info('Indexing run completed', {
        fetched,
        indexed: indexedCount,
        hadEmbeddingFailures: firstEmbeddingError !== undefined,
        durationMs: runDurationMs,
        checkpoint: checkpointAfter?.timestamp
      });
    }

    return {
      fetched,
      indexed: indexedCount,
      checkpointBefore,
      checkpointAfter,
      hadEmbeddingFailures: firstEmbeddingError !== undefined
    };
  }

  private async flushIdleSessionsAndResetDeduplication(now: Date): Promise<void> {
    let staleContextKeys: Set<string> | undefined;
    if (this.deps.sessionStore !== undefined) {
      try {
        const idleMs = (
          this.deps.sessionIdleThresholdSeconds ?? DEFAULT_ANALYSIS_IDLE_THRESHOLD_SECONDS
        ) * 1000;
        const cutoffMs = now.getTime() - idleMs;
        const openSessions = await this.deps.sessionStore.listSessions({ isOpen: true });
        staleContextKeys = new Set(
          openSessions
            .filter((session) => isTimestampBefore(session.ended_at, cutoffMs))
            .map((session) => session.context_key)
        );
      } catch (error) {
        this.deps.logger?.warn('Could not inspect idle sessions before flushing.', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const flushed = await this.deps.sessionAggregator.flushIdleOpenSessions(now);
    if (flushed.closed === 0) return;

    if (staleContextKeys !== undefined && staleContextKeys.size > 0) {
      for (const contextKey of staleContextKeys) {
        this.lineDeduplicator.reset(contextKey);
      }
    } else {
      // A custom aggregator may close sessions without exposing their keys;
      // reset all state conservatively rather than carry hashes across a
      // session boundary.
      this.lineDeduplicator.reset();
    }
  }

  /**
   * Restores line hashes for currently open sessions once per process. The
   * session store is optional for lightweight callers and test doubles; the
   * production composition root supplies it alongside the aggregator. Only
   * rows at or before the durable checkpoint are replayed, so an extracted
   * row left behind by a failed embedding is retried with its original text.
   */
  private async hydrateLineDeduplication(
    now: Date,
    checkpoint: IndexedCheckpoint | null
  ): Promise<void> {
    if (this.lineDeduplicationHydrated) return;
    if (this.deps.sessionStore === undefined) {
      this.lineDeduplicationHydrated = true;
      return;
    }
    if (checkpoint === null) {
      this.lineDeduplicationHydrated = true;
      return;
    }

    try {
      const openSessionsByContext = new Map<string, string[]>();
      for (const session of await this.deps.sessionStore.listSessions({ isOpen: true })) {
        const starts = openSessionsByContext.get(session.context_key);
        if (starts === undefined) {
          openSessionsByContext.set(session.context_key, [session.started_at]);
        } else {
          starts.push(session.started_at);
        }
      }
      if (openSessionsByContext.size > 0) {
        const sessionStarts = [...openSessionsByContext.values()].flat();
        const from = sessionStarts.sort()[0];
        if (from === undefined) return;
        const rows = await this.deps.extractedContentStore.listByTimeWindow(
          from,
          now.toISOString()
        );
        this.lineDeduplicator.hydrate(
          rows.filter(
            (row) => {
              const starts = openSessionsByContext.get(row.contextKey);
              return starts !== undefined &&
                starts.some((start) =>
                  isAtOrAfter(row.frameTimestamp, start) &&
                  isAtOrBeforeCheckpoint(row, checkpoint)
                );
            }
          )
        );
      }
      this.lineDeduplicationHydrated = true;
    } catch (error) {
      this.deps.logger?.warn('Line deduplication state hydration skipped.', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
    privacyReader: PrivacyStateReader | undefined,
    deduplication: LineDeltaDeduplicationTransaction,
    secureAxRoles: string[]
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
      const rawExtraction = await extractRecord(
        record,
        this.deps.captureFrameDetail,
        this.deps.extractionRegistry,
        secureAxRoles
      );
      const processed = deduplication.process(rawExtraction);
      await this.deps.extractedContentStore.upsert(processed.extraction);
      await this.deps.sessionAggregator.handleExtraction(processed.extraction);
      prepared.push({
        record,
        extraction: processed.extraction,
        deduplicationToken: processed.token
      });
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
    const batchStartTime = performance.now();
    let computedCount = 0;
    let cacheHitCount = 0;
    let skippedEmptyCount = 0;
    let failedCount = 0;

    const launch = (index: number): void => {
      const { record, extraction, deduplicationToken } = prepared[index];
      const promise = this.deps.embeddingService.computeEmbedding(extraction)
        .then((computeOutcome: ComputeEmbeddingOutcome) => {
          switch (computeOutcome.kind) {
            case 'skipped-empty':
              skippedEmptyCount += 1;
              results[index] = {
                record, extraction, deduplicationToken,
                outcome: { indexed: false, error: undefined, advanceCheckpoint: true }
              };
              break;
            case 'reused-hash':
              cacheHitCount += 1;
              results[index] = {
                record, extraction, deduplicationToken,
                outcome: { indexed: true, error: undefined, advanceCheckpoint: true },
                embedding: computeOutcome.embedding,
                extractedTextHash: computeOutcome.extractedTextHash
              };
              break;
            case 'computed':
              computedCount += 1;
              results[index] = {
                record, extraction, deduplicationToken,
                outcome: { indexed: true, error: undefined, advanceCheckpoint: true },
                embedding: computeOutcome.embedding,
                extractedTextHash: computeOutcome.extractedTextHash
              };
              break;
            case 'provider-unavailable':
              failedCount += 1;
              results[index] = {
                record, extraction, deduplicationToken,
                outcome: { indexed: false, error: computeOutcome.error, advanceCheckpoint: false }
              };
              break;
          }
        })
        .catch((error: unknown) => {
          failedCount += 1;
          results[index] = {
            record, extraction, deduplicationToken,
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

    if (prepared.length > 0) {
      const batchDurationMs = Math.round(performance.now() - batchStartTime);
      const avgLatencyMs = computedCount > 0 ? Math.round(batchDurationMs / computedCount) : 0;
      this.deps.logger?.info('Indexing embedding batch processed', {
        totalRecords: prepared.length,
        computed: computedCount,
        cacheHits: cacheHitCount,
        skippedEmpty: skippedEmptyCount,
        failed: failedCount,
        batchDurationMs,
        avgLatencyMs,
        provider: this.deps.embeddingProvider.kind,
        model: this.deps.embeddingProvider.model
      });
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
  private async processRecord(
    record: CaptureRecord,
    deduplication: LineDeltaDeduplicationTransaction,
    secureAxRoles: string[]
  ): Promise<ProcessRecordOutcome> {
    const rawExtraction = await extractRecord(
      record,
      this.deps.captureFrameDetail,
      this.deps.extractionRegistry,
      secureAxRoles
    );
    const processed = deduplication.process(rawExtraction);
    await this.deps.extractedContentStore.upsert(processed.extraction);
    await this.deps.sessionAggregator.handleExtraction(processed.extraction);
    const outcome = await this.deps.embeddingService.embedExtraction(processed.extraction);

    return {
      ...mapEmbeddingOutcome(outcome),
      deduplicationToken: processed.token
    };
  }
}

function isEligibleBacklogRecord(
  record: CaptureRecord,
  checkpoint: IndexedCheckpoint | null,
  backlog: IndexedBacklogProgress | null
): boolean {
  if (backlog === null || backlog.nextOffset === 0 || checkpoint === null) {
    return isNewerThanCheckpoint(record, checkpoint);
  }

  // Once a backlog has advanced, `nextOffset` is the provider's authoritative
  // cursor. A provider may order the next page independently of the durable
  // checkpoint timestamp, so do not discard older records from that page.
  // Still guard against a provider repeating the exact checkpoint row.
  const isCheckpointRow =
    record.id === checkpoint.cursor
    && compareTimestamps(record.timestamp, checkpoint.timestamp) === 0;
  return !isCheckpointRow;
}

function isAtOrAfter(timestamp: string, lowerBound: string): boolean {
  const timestampMs = Date.parse(timestamp);
  const lowerBoundMs = Date.parse(lowerBound);
  if (Number.isFinite(timestampMs) && Number.isFinite(lowerBoundMs)) {
    return timestampMs >= lowerBoundMs;
  }
  return timestamp >= lowerBound;
}

function isTimestampBefore(timestamp: string, boundMs: number): boolean {
  const timestampMs = Date.parse(timestamp);
  if (Number.isFinite(timestampMs)) {
    return timestampMs < boundMs;
  }
  return timestamp < new Date(boundMs).toISOString();
}

/**
 * Converts an `EmbeddingOutcome` (returned by `embedExtraction`, which owns
 * the vector-store write) to the `ProcessRecordOutcome` shape used by the
 * blocked-records re-check loop. The mapping mirrors the switch in the old
 * serial loop and in the concurrent embedding step.
 */
function mapEmbeddingOutcome(
  outcome: EmbeddingOutcome
): EmbeddingProcessOutcome {
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
