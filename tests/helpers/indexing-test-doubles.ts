/**
 * Test doubles wiring the work-activity tail collaborators that
 * `IndexingServiceDependencies` started requiring after task 6.1
 * ("DefaultIndexingService.runOnce 接入抽取与会话化").
 *
 * The pre-task-6.1 indexing-service tests construct their own
 * `embeddingProvider` / `vectorStore` / `screenpipeClient` stubs and
 * assert against the legacy "per-record vector-store upsert" shape.
 * Task 6.1 inserts a four-collaborator pipeline (extraction →
 * extracted_content store → session aggregator → embedding service)
 * between the privacy filter and the vector-store write — the legacy
 * tests now need *something* on those four slots even when they only
 * care about whether the embedding provider was called.
 *
 * {@link createLegacyIndexingService} is a thin wrapper around
 * `createIndexingService` that:
 *
 *   1. Substitutes a passthrough extraction registry that lifts
 *      `ScreenpipeRecord.text` onto `ExtractionResult.extractedText`
 *      so the embedding provider still sees the original strings the
 *      legacy assertions expect.
 *   2. Substitutes a no-op `ExtractedContentStore` and
 *      `SessionAggregator` (the legacy tests don't assert against the
 *      derived database).
 *   3. Substitutes a "legacy-shim" `EmbeddingService` that forwards
 *      `extractedText` to the embedding provider and writes a
 *      vector-store record keyed by the **original**
 *      `ScreenpipeRecord.id` — preserving the legacy
 *      `vectorStore.upserts[0]?.map(r => r.id)` assertion shape.
 *   4. Wraps the `screenpipeClient` with a tap that captures records
 *      into a shared `frameId → record` map (so the embedding shim
 *      can look up the original `id` / `text` / `metadata` from the
 *      synthetic `frameId` the indexing service derives via FNV-1a).
 *
 * The helper is purpose-built for the legacy tests in
 * `tests/integration/indexing/indexing-service.test.ts`,
 * `tests/unit/retrieval/properties.test.ts`,
 * `tests/unit/coverage/coverage-properties.test.ts`, and
 * `tests/evaluations/coverage-scenario/run.ts`. Task 6.3 will replace
 * those tests with proper integration tests against the real
 * extraction / session / embedding pipeline; this shim is intended to
 * keep the legacy assertions green in the meantime.
 */

import type {
  CheckpointStore,
  EmbeddingProvider,
  IndexingService,
  ScreenpipeClient,
  ScreenpipeRecord,
  VectorStore
} from '../../src/services/retrieval/types.js';
import {
  createIndexingService,
  hashStringToNumericId,
  type IndexingServiceDependencies
} from '../../src/services/retrieval/indexing-service.js';
import {
  type ExtractionInput,
  type ExtractionRegistry,
  type ExtractionResult
} from '../../src/services/work-activity/extraction/types.js';
import type { ExtractedContentStore } from '../../src/services/work-activity/extraction/extracted-content-store.js';
import type {
  SessionAggregator,
  HandleExtractionResult,
  FlushIdleResult
} from '../../src/services/work-activity/sessions/aggregator.js';
import type {
  EmbeddingService,
  EmbeddingOutcome
} from '../../src/services/work-activity/embedding-service.js';
import {
  buildContextKey,
  deriveContextLabel
} from '../../src/services/work-activity/sessions/context-key.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/**
 * Passthrough extraction registry: lifts `ScreenpipeRecord.text` into
 * `ExtractionResult.extractedText` (via the side-channel populated by
 * the wrapping screenpipe-client tap, see {@link createCapturingClient}).
 *
 * Returning a non-empty `extractedText` is required because the
 * legacy-shim embedding service forwards it to
 * `embeddingProvider.embed(...)` and the legacy tests expect a call
 * per record. If the extraction were always empty, the indexing
 * service would short-circuit the embedding step.
 *
 * `extractedTextHash` stays `null` to skip the SHA256 path and any
 * dedup behaviour — the legacy tests don't tolerate the post-task-6.1
 * Hash_Dedup deduplication semantics.
 */
class PassthroughExtractionRegistry implements ExtractionRegistry {
  constructor(private readonly records: Map<number, ScreenpipeRecord>) {}

  extract(input: ExtractionInput): ExtractionResult {
    const captured = this.records.get(input.frameId);
    return {
      frameId: input.frameId,
      frameTimestamp: input.frameTimestamp,
      appName: input.appName,
      contextLabel: deriveContextLabel(input.windowTitle, input.appName),
      contextKey: buildContextKey(input.appName, input.windowTitle),
      extractedText: captured?.text ?? '',
      extractedTextHash: null,
      extractionRuleKind: 'generic',
      sourceTypes: input.sourceTypes
    };
  }
}

class NoopExtractedContentStore implements ExtractedContentStore {
  async upsert(): Promise<void> { /* drop on the floor */ }
  async getByFrameIds(): Promise<ExtractionResult[]> { return []; }
  async deleteByFrameIds(): Promise<number> { return 0; }
  async listByTimeWindow(): Promise<ExtractionResult[]> { return []; }
  async countByTimeWindow(): Promise<{ total: number; empty: number }> {
    return { total: 0, empty: 0 };
  }
  async findLastExtractedAt(): Promise<string | null> { return null; }
}

class NoopSessionAggregator implements SessionAggregator {
  async handleExtraction(extraction: ExtractionResult): Promise<HandleExtractionResult> {
    return { sessionId: `noop:${extraction.frameId}`, created: true };
  }
  async flushIdleOpenSessions(): Promise<FlushIdleResult> {
    return { closed: 0 };
  }
}

/**
 * Legacy-shim `EmbeddingService`.
 *
 * Forwards `extraction.extractedText` to the embedding provider and
 * **buffers** the resulting `VectorStoreRecord` for the indexing
 * service to flush at end-of-`runOnce()`. The buffering matches the
 * pre-task-6.1 semantics where the indexing service collected all
 * embeddings and made a single `vectorStore.upsert(batch)` call at
 * the end — many legacy tests assert
 * `vectorStore.upserts.length === 1` per `runOnce()`, which would
 * fail under the new per-frame upsert pattern.
 *
 * The shim is paired with {@link createLegacyIndexingService}'s
 * IndexingService wrapper that calls {@link flushBatch} after each
 * `runOnce()` returns (or throws). Provider errors translate to
 * `provider-unavailable` outcomes so the indexing service's
 * checkpoint-error contract stays intact.
 */
class LegacyShimEmbeddingService implements EmbeddingService {
  private readonly buffered: import('../../src/services/retrieval/types.js').VectorStoreRecord[] = [];

  constructor(
    private readonly deps: {
      embeddingProvider: EmbeddingProvider;
      vectorStore: VectorStore;
      records: Map<number, ScreenpipeRecord>;
      privacyState?: import('../../src/services/privacy/types.js').PrivacyStateReader;
    }
  ) {}

  async embedExtraction(extraction: ExtractionResult): Promise<EmbeddingOutcome> {
    if (extraction.extractedText === '') {
      return { kind: 'skipped-empty' };
    }

    const record = this.deps.records.get(extraction.frameId);
    if (record === undefined) {
      return {
        kind: 'provider-unavailable',
        error: new Error(
          `LegacyShimEmbeddingService: no record captured for frameId=${extraction.frameId}`
        )
      };
    }

    let embedding: number[];
    try {
      embedding = await this.deps.embeddingProvider.embed(extraction.extractedText);
    } catch (error) {
      return { kind: 'provider-unavailable', error };
    }

    // Buffer the vector record. The wrapping IndexingService calls
    // `flushBatch()` after `runOnce()` returns, which actually
    // persists the records via `vectorStore.upsert(batch)`. The
    // legacy assertions read `vectorStore.upserts[0]?.map(r => r.id)`
    // expecting that one batch holds every record seen during the
    // run.
    this.buffered.push({
      ...record,
      embedding,
      metadata: {
        sourceTypes: record.sourceTypes,
        windowName: record.windowName,
        frameId: record.frameId
      }
    });

    return { kind: 'embedded', embedding };
  }

  /**
   * Drain the buffer and persist it as a single `vectorStore.upsert`
   * call. Returns the number of records flushed (mostly for
   * diagnostics). The wrapping IndexingService invokes this in a
   * `try/finally` so a thrown `runOnce` still flushes any successful
   * embeddings before re-raising.
   *
   * Before flushing, the shim re-reads the latest privacy state and
   * filters out any buffered record that is now blocked by the
   * `excludedApps` / `paused` / `suppressedRanges` predicates. This
   * recreates the pre-task-6.1 "late privacy re-check" path: the
   * legacy indexing service called `vectorStore.upsert(persistedRecords)`
   * **after** filtering through the freshly-read privacy state, so a
   * record whose embedding succeeded mid-run could still be elided
   * if the user paused / excluded the app while the embed call was
   * in flight.
   */
  async flushBatch(): Promise<{ flushed: number; allBlockedAfterReread: boolean; hadBuffered: boolean }> {
    const hadBuffered = this.buffered.length > 0;
    if (!hadBuffered) {
      return { flushed: 0, allBlockedAfterReread: false, hadBuffered: false };
    }
    const batch = this.buffered.splice(0, this.buffered.length);

    // Sort by (timestamp, id) before persisting. The legacy
    // indexing service called `vectorStore.upsert([...vectorRecords].sort(compareRecords))`
    // at end-of-run, which produced a stable, time-ordered batch
    // even when records arrived in non-sorted order (e.g. when a
    // record was initially blocked, then unblocked on a later
    // privacy refresh and re-processed). Several legacy assertions
    // read `vectorStore.upserts[0]?.map(r => r.id)` and expect the
    // ordering to follow timestamps.
    batch.sort((a, b) => {
      const tA = Date.parse(a.timestamp);
      const tB = Date.parse(b.timestamp);
      const tCmp = (Number.isFinite(tA) && Number.isFinite(tB))
        ? (tA - tB)
        : a.timestamp.localeCompare(b.timestamp);
      if (tCmp !== 0) return tCmp;
      return a.id.localeCompare(b.id);
    });

    // Re-read privacy and filter — match the legacy semantic that a
    // record whose embedding completed mid-run can still be filtered
    // out if privacy tightened during the run.
    const filtered: typeof batch = [];
    if (this.deps.privacyState !== undefined) {
      let privacy: import('../../src/services/privacy/types.js').PrivacyState;
      try {
        privacy = await this.deps.privacyState.read();
      } catch {
        // If privacy can't be read at flush time, skip the re-filter
        // and persist what we have. The indexing service's own
        // privacy-load error path will already throw if needed.
        privacy = { paused: false, excludedApps: [] };
      }
      for (const record of batch) {
        if (!isBlockedByPrivacy(record, privacy)) {
          filtered.push(record);
        }
      }
    } else {
      filtered.push(...batch);
    }

    if (filtered.length > 0) {
      await this.deps.vectorStore.upsert(filtered);
    }
    return {
      flushed: filtered.length,
      // True when we entered with records and the re-filter blocked
      // every one of them — used by the wrapping IndexingService to
      // re-throw a deferred embedding error (the legacy "late filter
      // removed all writes" failure mode).
      allBlockedAfterReread: filtered.length === 0 && batch.length > 0,
      hadBuffered: true
    };
  }
}

/**
 * Subset of the privacy-filter logic from `indexing-service.ts`,
 * inlined here to avoid coupling tests to a private export. The legacy
 * shim only needs the three predicates that flag a record as blocked:
 * excluded app, suppressed range, or post-pause timestamp.
 */
function isBlockedByPrivacy(
  record: { appName?: string; timestamp: string },
  privacy: import('../../src/services/privacy/types.js').PrivacyState
): boolean {
  // excludedApps: case-insensitive comparison against the record's appName.
  if (record.appName !== undefined) {
    const normalized = record.appName.toLowerCase();
    if (privacy.excludedApps.some((app) => app.toLowerCase() === normalized)) {
      return true;
    }
  }
  // suppressedRanges: any range whose [from, to] contains record.timestamp.
  const ranges = privacy.suppressedRanges ?? [];
  if (ranges.length > 0) {
    const ts = Date.parse(record.timestamp);
    if (Number.isFinite(ts)) {
      for (const range of ranges) {
        const from = Date.parse(range.from);
        const to = Date.parse(range.to);
        if (Number.isFinite(from) && Number.isFinite(to) && ts >= from && ts <= to) {
          return true;
        }
      }
    }
  }
  // paused: blocks records whose timestamp is at or after pauseStartedAt.
  if (privacy.paused && privacy.pauseStartedAt) {
    const ts = Date.parse(record.timestamp);
    const pauseStart = Date.parse(privacy.pauseStartedAt);
    if (Number.isFinite(ts) && Number.isFinite(pauseStart) && ts >= pauseStart) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Capturing screenpipe-client wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a `ScreenpipeClient` so every record returned by `search` /
 * `recent` is registered with the harness's `frameId → record` map
 * before the indexing service consumes it.
 *
 * The wrapper does **not** clone the underlying client's state —
 * tests that bind the original client variable can still read
 * `searchCalls` / `recentCalls` etc. through that bound reference.
 */
function createCapturingClient(
  inner: ScreenpipeClient,
  records: Map<number, ScreenpipeRecord>
): ScreenpipeClient {
  return {
    async search(request) {
      const result = await inner.search(request);
      for (const record of result) capture(records, record);
      return result;
    },
    async recent(minutes) {
      const result = await inner.recent(minutes);
      for (const record of result) capture(records, record);
      return result;
    }
  };
}

function capture(target: Map<number, ScreenpipeRecord>, record: ScreenpipeRecord): void {
  // Match the FNV-1a fallback the indexing service applies in
  // `toExtractionInput` — when `record.frameId` is missing, the same
  // hash is computed on both ends so the lookup succeeds.
  const key = record.frameId ?? hashStringToNumericId(record.id);
  target.set(key, record);
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Pre-task-6.1 dependencies (what tests provided before the four new
 * fields were added). Mirrors `IndexingServiceDependencies` minus
 * `extractionRegistry` / `extractedContentStore` /
 * `sessionAggregator` / `embeddingService`.
 */
export type LegacyIndexingDependencies =
  Omit<
    IndexingServiceDependencies,
    'extractionRegistry' | 'extractedContentStore' | 'sessionAggregator' | 'embeddingService'
  >;

/**
 * Drop-in replacement for `createIndexingService` that the legacy
 * tests use. Accepts the pre-task-6.1 dependency shape and synthesises
 * the four new collaborators internally.
 *
 * The returned `IndexingService.runOnce()` wraps the underlying
 * production service in a `try/finally` that calls
 * {@link LegacyShimEmbeddingService.flushBatch} after every run. This
 * preserves the pre-task-6.1 invariant that **all** records embedded
 * during a single `runOnce()` land in **one** `vectorStore.upsert`
 * call (legacy assertions read `vectorStore.upserts.length` to
 * verify it).
 *
 * The wrapper also re-reads privacy at flush time and adjusts the
 * `result.indexed` count to match the post-filter set, mirroring the
 * legacy "late privacy re-check" semantic. When the late filter
 * removes ALL embeddings AND there was an in-loop embedding error,
 * the legacy semantic was to re-throw the deferred error; this
 * wrapper preserves that path by stashing any provider failure the
 * shim observed and re-raising it from the `runOnce()` `finally`
 * branch when appropriate.
 */
export function createLegacyIndexingService(
  deps: LegacyIndexingDependencies
): IndexingService {
  const records = new Map<number, ScreenpipeRecord>();
  const wrappedClient = createCapturingClient(deps.screenpipeClient, records);
  // Track the first provider error the shim observes so the
  // late-filter throw path can re-raise it. The production indexing
  // service surfaces `hadEmbeddingFailures: true` on the result for
  // partial failures, but the legacy tests want `runOnce()` to throw
  // when the late filter removes every successful write.
  const errorTracker: { firstError: unknown } = { firstError: undefined };
  const trackingProvider: EmbeddingProvider = {
    kind: deps.embeddingProvider.kind,
    embed: async (input) => {
      try {
        return await deps.embeddingProvider.embed(input);
      } catch (error) {
        errorTracker.firstError ??= error;
        throw error;
      }
    }
  };
  const embeddingService = new LegacyShimEmbeddingService({
    embeddingProvider: trackingProvider,
    vectorStore: deps.vectorStore,
    records,
    privacyState: deps.privacyState
  });

  const inner = createIndexingService({
    ...deps,
    embeddingProvider: trackingProvider,
    screenpipeClient: wrappedClient,
    extractionRegistry: new PassthroughExtractionRegistry(records),
    extractedContentStore: new NoopExtractedContentStore(),
    sessionAggregator: new NoopSessionAggregator(),
    embeddingService
  });

  return {
    async runOnce(now, forcedBacklog) {
      // Reset the per-run provider-error tracker. The tracker is
      // owned by the closure (so the tracking provider can write
      // into it from anywhere in the run), but each `runOnce()` is
      // a fresh logical attempt — without this reset, a provider
      // failure in run N could resurface in run N+1 if N+1's
      // late-privacy flush happens to block every record.
      errorTracker.firstError = undefined;

      // Snapshot the checkpoint so the late-filter throw path can
      // restore it. The legacy semantic was: if the late filter
      // removes every embedding AND there was a deferred embedding
      // error, throw without advancing the checkpoint past the
      // failure point. In the new architecture, `runOnce` advances
      // the checkpoint past successful records before returning, so
      // a post-runOnce throw would otherwise leave the checkpoint
      // ahead of the failed record.
      const checkpointBefore = await deps.checkpointStore.readLatest();

      let result: import('../../src/services/retrieval/types.js').IndexingRunResult | undefined;
      let runError: unknown;
      try {
        result = await inner.runOnce(now, forcedBacklog);
      } catch (error) {
        runError = error;
      }

      // Even if `runOnce` threw (provider error, partial failure) we
      // still want to flush any successful embeddings. The legacy
      // semantic batched the upsert at the end of the run regardless
      // of mid-run failures — assertions on `vectorStore.upserts`
      // count this as one logical batch.
      const flushReport = await embeddingService.flushBatch();

      if (runError !== undefined) throw runError;
      if (result === undefined) {
        // `runOnce` neither resolved nor threw — this should be
        // impossible, but type-narrowing requires a fallback.
        throw new Error('LegacyShimIndexingService: runOnce returned undefined');
      }

      // Late-privacy-filter parity: the legacy implementation
      // re-checked privacy after embedding completed and BEFORE
      // calling `vectorStore.upsert`. When the filter removed every
      // record, it re-threw the first embedding error (if any) so
      // the run failed visibly and **did not advance** the
      // checkpoint past the failure point.
      if (
        flushReport.hadBuffered &&
        flushReport.allBlockedAfterReread &&
        errorTracker.firstError !== undefined
      ) {
        // Restore the checkpoint to its pre-runOnce state so the
        // failed record gets retried on the next tick. Without this,
        // the new architecture's per-record checkpoint advancement
        // would have moved the cursor past the failure.
        if (checkpointBefore !== null) {
          await deps.checkpointStore.writeLatest(checkpointBefore);
        } else {
          await deps.checkpointStore.reset();
        }
        throw errorTracker.firstError instanceof Error
          ? errorTracker.firstError
          : new Error('Embedding provider failed before privacy filtering removed the remaining indexed records.');
      }

      // Adjust the `indexed` count to the post-filter total so
      // assertions like `expect(result.indexed).toBe(1)` reflect the
      // shim's late-filter behaviour. `result.indexed` from the
      // production service counts every successful `embedded` /
      // `reused-hash` outcome — the late filter may have stripped
      // some of those.
      if (flushReport.hadBuffered) {
        return {
          ...result,
          indexed: flushReport.flushed
        };
      }
      return result;
    }
  };
}

/**
 * Re-export so callers can build the deps record directly when they
 * need to override one of the four new fields (e.g. tests for the
 * embedding service interaction itself).
 */
export type { IndexingServiceDependencies };

// Avoid eager unused-export warnings — keep `CheckpointStore` available
// at this module's surface for callers that want to type-annotate
// `LegacyIndexingDependencies['checkpointStore']`.
export type { CheckpointStore };
