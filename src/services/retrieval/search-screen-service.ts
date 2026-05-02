import type { PrivacyState, PrivacyStateReader, PrivacySuppressedRange } from '../privacy/types.js';
import { DEFAULT_PRIVACY_STATE } from '../privacy/types.js';
import { fuseHybridResults } from './hybrid-ranker.js';
import type {
  CheckpointStore,
  EmbeddingProvider,
  FreshnessPolicy,
  RetrievalEvidenceItem,
  ScreenpipeClient,
  SearchScreenRequest,
  SearchScreenResult,
  SearchScreenService,
  VectorStore
} from './types.js';

const MAX_VISIBLE_RESULTS = 10;
const MAX_PAGED_BATCHES = 5;
const PAGE_SIZE = 10;
const PRIVACY_READ_ERROR_MESSAGE = 'Privacy controls could not be loaded while processing search.';
const ACTIVE_PAUSE_OPEN_END = '9999-12-31T23:59:59.999Z';

export interface SearchScreenServiceDependencies {
  embeddingProvider: EmbeddingProvider;
  screenpipeClient: ScreenpipeClient;
  vectorStore: VectorStore;
  checkpointStore: CheckpointStore;
  freshnessPolicy: FreshnessPolicy;
  privacyState?: PrivacyStateReader;
}

function summarize(query: string, evidence: RetrievalEvidenceItem[], mode: SearchScreenRequest['mode']): string {
  if (evidence.length === 0) {
    return `No screen history matched "${query}" using ${mode} search.`;
  }

  return `Found ${evidence.length} screen history item(s) for "${query}" using ${mode} search.`;
}

function summarizeEffectiveMode(
  query: string,
  evidence: RetrievalEvidenceItem[],
  requestedMode: SearchScreenRequest['mode'],
  degraded?: SearchScreenResult['degraded']
): string {
  return summarize(query, evidence, degraded?.fallbackMode ?? requestedMode);
}

function mapKeywordEvidence(records: Awaited<ReturnType<ScreenpipeClient['search']>>): RetrievalEvidenceItem[] {
  return records.map((record) => ({
    id: record.id,
    text: record.text,
    timestamp: record.timestamp,
    appName: record.appName,
    source: 'keyword'
  }));
}

function normalizeAppName(appName: string): string {
  return appName.toLowerCase();
}

function isExcludedApp(appName: string | undefined, privacy: PrivacyState): boolean {
  if (!appName) {
    return false;
  }

  const normalizedAppName = normalizeAppName(appName);
  return privacy.excludedApps.some((excludedApp) => normalizeAppName(excludedApp) === normalizedAppName);
}

function filterExcludedApps<T extends { appName?: string }>(items: T[], privacy: PrivacyState): T[] {
  if (privacy.excludedApps.length === 0) {
    return items;
  }

  return items.filter((item) => !isExcludedApp(item.appName, privacy));
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

function filterSuppressedRanges<T extends { timestamp: string }>(items: T[], privacy: PrivacyState): T[] {
  const suppressedRanges = privacy.suppressedRanges ?? [];
  if (suppressedRanges.length === 0) {
    return items;
  }

  return items.filter((item) => !suppressedRanges.some((range) => intersectsSuppressedRange(item.timestamp, range)));
}

function createActivePauseRange(privacy: PrivacyState): PrivacySuppressedRange | null {
  if (!privacy.paused || !privacy.pauseStartedAt) {
    return null;
  }

  return {
    from: privacy.pauseStartedAt,
    to: ACTIVE_PAUSE_OPEN_END
  };
}

function applyRuntimePrivacyState(privacy: PrivacyState): PrivacyState {
  const activePauseRange = createActivePauseRange(privacy);
  if (!activePauseRange) {
    return privacy;
  }

  return {
    ...privacy,
    suppressedRanges: [...(privacy.suppressedRanges ?? []), activePauseRange]
  };
}

async function readPrivacyState(reader?: PrivacyStateReader): Promise<PrivacyState> {
  if (!reader) {
    return applyRuntimePrivacyState(DEFAULT_PRIVACY_STATE);
  }

  return applyRuntimePrivacyState(await reader.read());
}

function createPrivacyReadError(): Error {
  return new Error(PRIVACY_READ_ERROR_MESSAGE);
}

function isPrivacyReadError(error: unknown): boolean {
  return error instanceof Error && error.message === PRIVACY_READ_ERROR_MESSAGE;
}

async function readSearchPrivacyState(reader?: PrivacyStateReader): Promise<PrivacyState> {
  try {
    return await readPrivacyState(reader);
  } catch {
    throw createPrivacyReadError();
  }
}

async function filterEvidenceWithLatestPrivacy(
  items: RetrievalEvidenceItem[],
  reader?: PrivacyStateReader
): Promise<{ privacy: PrivacyState; items: RetrievalEvidenceItem[] }> {
  const privacy = await readSearchPrivacyState(reader);
  return {
    privacy,
    items: filterSuppressedRanges(filterExcludedApps(items, privacy), privacy)
  };
}

function createPrivacyUnavailableResult(freshness: SearchScreenResult['freshness']): SearchScreenResult {
  return {
    summary: 'Search is currently unavailable.',
    evidence: [],
    freshness,
    error: {
      code: 'RETRIEVAL_FAILED',
      message: PRIVACY_READ_ERROR_MESSAGE,
      action: 'Verify the local privacy-state file is readable and contains valid JSON, then retry the query.'
    }
  };
}

function mergeDegradedStatus(
  preferred?: SearchScreenResult['degraded'],
  fallback?: SearchScreenResult['degraded']
): SearchScreenResult['degraded'] {
  if (!preferred) {
    return fallback;
  }

  if (!fallback) {
    return preferred;
  }

  return {
    reason: preferred.reason,
    fallbackMode: preferred.fallbackMode ?? fallback.fallbackMode
  };
}

async function applyLatestPrivacyToResult(
  request: SearchScreenRequest,
  freshness: SearchScreenResult['freshness'],
  items: RetrievalEvidenceItem[],
  reader: PrivacyStateReader | undefined,
  degraded?: SearchScreenResult['degraded'],
  backfiller?: ResultBackfiller,
  backfillFailureDegraded?: SearchScreenResult['degraded']
): Promise<SearchScreenResult> {
  try {
    let filteredResult = await filterEvidenceWithLatestPrivacy(items, reader);
    let backfillFailed = false;

    while (true) {
      while (filteredResult.items.length < MAX_VISIBLE_RESULTS && backfiller?.canContinue()) {
        let extendedItems: RetrievalEvidenceItem[];
        try {
          extendedItems = await backfiller.extend(items);
        } catch {
          backfillFailed = true;
          backfiller = undefined;
          break;
        }
        if (extendedItems.length === items.length) {
          break;
        }

        items = extendedItems;
        filteredResult = await filterEvidenceWithLatestPrivacy(items, reader);
      }

      const finalFilteredResult = await filterEvidenceWithLatestPrivacy(items, reader);
      if (finalFilteredResult.items.length < MAX_VISIBLE_RESULTS && backfiller?.canContinue()) {
        filteredResult = finalFilteredResult;
        continue;
      }

      const visibleItems = finalFilteredResult.items.slice(0, MAX_VISIBLE_RESULTS);
      const effectiveDegraded = backfillFailed ? mergeDegradedStatus(backfillFailureDegraded, degraded) : degraded;

      return {
        summary: summarizeEffectiveMode(request.query, visibleItems, request.mode, effectiveDegraded),
        evidence: visibleItems,
        freshness,
        degraded: effectiveDegraded
      };
    }
  } catch (error) {
    if (isPrivacyReadError(error)) {
      return createPrivacyUnavailableResult(freshness);
    }

    throw error;
  }
}

async function applyLatestPrivacyToHybridResult(
  request: SearchScreenRequest,
  freshness: SearchScreenResult['freshness'],
  keywordItems: RetrievalEvidenceItem[],
  semanticItems: RetrievalEvidenceItem[],
  reader: PrivacyStateReader | undefined,
  degraded?: SearchScreenResult['degraded'],
  keywordBackfiller?: ResultBackfiller,
  semanticBackfiller?: ResultBackfiller
): Promise<SearchScreenResult> {
  try {
    let privacy = await readSearchPrivacyState(reader);
    let visibleItems = fuseVisibleHybridResults(
      keywordItems,
      semanticItems,
      privacy,
      keywordItems.length + semanticItems.length
    );
    let keywordBackfillFailed = false;
    let semanticBackfillFailed = false;

    while (true) {
      while (visibleItems.length < MAX_VISIBLE_RESULTS && (keywordBackfiller?.canContinue() || semanticBackfiller?.canContinue())) {
        let changed = false;

        if (keywordBackfiller?.canContinue()) {
          try {
            const nextKeywordItems = await keywordBackfiller.extend(keywordItems);
            changed = changed || nextKeywordItems.length !== keywordItems.length;
            keywordItems = nextKeywordItems;
          } catch {
            keywordBackfillFailed = true;
            keywordBackfiller = undefined;
          }
        }

        if (semanticBackfiller?.canContinue()) {
          try {
            const nextSemanticItems = await semanticBackfiller.extend(semanticItems);
            changed = changed || nextSemanticItems.length !== semanticItems.length;
            semanticItems = nextSemanticItems;
          } catch {
            semanticBackfillFailed = true;
            semanticBackfiller = undefined;
          }
        }

        if (!changed) {
          break;
        }

        privacy = await readSearchPrivacyState(reader);
        visibleItems = fuseVisibleHybridResults(
          keywordItems,
          semanticItems,
          privacy,
          keywordItems.length + semanticItems.length
        );
      }

      const finalPrivacy = await readSearchPrivacyState(reader);
      const finalVisibleItems = fuseVisibleHybridResults(
        keywordItems,
        semanticItems,
        finalPrivacy,
        keywordItems.length + semanticItems.length
      );
      if (
        finalVisibleItems.length < MAX_VISIBLE_RESULTS
        && (keywordBackfiller?.canContinue() || semanticBackfiller?.canContinue())
      ) {
        privacy = finalPrivacy;
        visibleItems = finalVisibleItems;
        continue;
      }

      const cappedVisibleItems = finalVisibleItems.slice(0, MAX_VISIBLE_RESULTS);
      const effectiveDegraded = keywordBackfillFailed || semanticBackfillFailed
        ? mergeDegradedStatus(privacyBackfillHybridReason(keywordBackfillFailed, semanticBackfillFailed), degraded)
        : degraded;

      return {
        summary: summarizeEffectiveMode(request.query, cappedVisibleItems, request.mode, effectiveDegraded),
        evidence: cappedVisibleItems,
        freshness,
        degraded: effectiveDegraded
      };
    }
  } catch (error) {
    if (isPrivacyReadError(error)) {
      return createPrivacyUnavailableResult(freshness);
    }

    throw error;
  }
}


function privacyBackfillKeywordReason(): SearchScreenResult['degraded'] {
  return {
    reason: 'Privacy filtering hid earlier keyword results and a later Screenpipe page failed before replacement results could be collected.'
  };
}

function privacyBackfillSemanticReason(): SearchScreenResult['degraded'] {
  return {
    reason: 'Privacy filtering hid earlier semantic results and a later vector-store page failed before replacement results could be collected.'
  };
}

function privacyBackfillHybridReason(
  keywordFailed: boolean,
  semanticFailed: boolean
): SearchScreenResult['degraded'] {
  if (keywordFailed && semanticFailed) {
    return {
      reason: 'Privacy filtering hid earlier hybrid results and later keyword and semantic pages both failed before replacement results could be collected.'
    };
  }

  if (keywordFailed) {
    return {
      reason: 'Privacy filtering hid earlier hybrid results and a later Screenpipe page failed before replacement results could be collected.'
    };
  }

  return {
    reason: 'Privacy filtering hid earlier hybrid results and a later vector-store page failed before replacement results could be collected.'
  };
}

interface PaginationCursor {
  offset: number;
  pageSize: number;
  remainingBatches: number;
}

interface CollectedVisibleResults {
  evidence: RetrievalEvidenceItem[];
  partialFailure: boolean;
  cursor: PaginationCursor | null;
}

interface CollectedVisibleKeywordResults extends CollectedVisibleResults {
  request: SearchScreenRequest;
  initialItemsForPrivacyReapply: RetrievalEvidenceItem[];
  initialVisibleEvidence: RetrievalEvidenceItem[];
  backfillRequest: SearchScreenRequest;
  backfillFallbackRequest?: SearchScreenRequest;
  backfillFallbackOffsetDelta?: number;
  backfillCursor: PaginationCursor | null;
}

interface ConfirmedVisibleResults {
  privacy: PrivacyState;
  stable: boolean;
}

interface ResultBackfiller {
  canContinue(): boolean;
  extend(items: RetrievalEvidenceItem[]): Promise<RetrievalEvidenceItem[]>;
}

interface KeywordResultBackfillerOptions {
  fallbackRequest?: SearchScreenRequest;
  fallbackOffsetDelta?: number;
}

interface KeywordSearchContext {
  request: SearchScreenRequest;
  pagedRequest: SearchScreenRequest;
  requiresRestart: boolean;
}

interface SemanticQueryPager {
  query(offset: number, limit: number): Promise<RetrievalEvidenceItem[]>;
}

function createPaginationCursor(
  currentOffset: number,
  batchLength: number,
  pageSize: number,
  remainingBatches: number
): PaginationCursor | null {
  if (batchLength < pageSize || remainingBatches <= 0) {
    return null;
  }

  return {
    offset: currentOffset + batchLength,
    pageSize,
    remainingBatches
  };
}

function createRestartPaginationCursor(
  unboundedBatchLength: number,
  boundedBatchLength: number,
  pageSize: number,
  remainingBatches: number
): PaginationCursor | null {
  if (unboundedBatchLength < pageSize || remainingBatches <= 0) {
    return null;
  }

  return {
    offset: boundedBatchLength,
    pageSize,
    remainingBatches
  };
}

function advancePaginationCursor(cursor: PaginationCursor, batchLength: number): PaginationCursor | null {
  return createPaginationCursor(cursor.offset, batchLength, cursor.pageSize, cursor.remainingBatches - 1);
}

function filterItemsWithPrivacy<T extends { appName?: string; timestamp: string }>(items: T[], privacy: PrivacyState): T[] {
  return filterSuppressedRanges(filterExcludedApps(items, privacy), privacy);
}

function trimCollectedResults(
  items: RetrievalEvidenceItem[],
  privacy: PrivacyState,
  limit: number
): RetrievalEvidenceItem[] {
  return filterItemsWithPrivacy(items, privacy).slice(0, limit);
}

function mergeKeywordItemsForPrivacyReapply(
  initialVisibleEvidence: RetrievalEvidenceItem[],
  pagedResults: RetrievalEvidenceItem[]
): RetrievalEvidenceItem[] {
  const seenIds = new Set(initialVisibleEvidence.map((item) => item.id));

  return [
    ...initialVisibleEvidence,
    ...pagedResults.filter((item) => {
      if (seenIds.has(item.id)) {
        return false;
      }

      seenIds.add(item.id);
      return true;
    })
  ];
}

function fuseVisibleHybridResults(
  keywordItems: RetrievalEvidenceItem[],
  semanticItems: RetrievalEvidenceItem[],
  privacy: PrivacyState,
  limit: number
): RetrievalEvidenceItem[] {
  return fuseHybridResults(
    filterItemsWithPrivacy(keywordItems, privacy),
    filterItemsWithPrivacy(semanticItems, privacy),
    limit
  );
}

async function confirmVisibleResults(
  items: RetrievalEvidenceItem[],
  privacy: PrivacyState,
  limit: number,
  reader?: PrivacyStateReader
): Promise<ConfirmedVisibleResults> {
  const latestPrivacy = await readSearchPrivacyState(reader);

  return {
    privacy: latestPrivacy,
    stable: trimCollectedResults(items, latestPrivacy, limit).length >= limit
  };
}

function createKeywordSearchContext(request: SearchScreenRequest): KeywordSearchContext {
  if (request.to) {
    return {
      request,
      pagedRequest: request,
      requiresRestart: false
    };
  }

  return {
    request,
    pagedRequest: {
      ...request,
      to: new Date().toISOString()
    },
    requiresRestart: true
  };
}

async function collectVisibleKeywordResults(
  client: ScreenpipeClient,
  context: KeywordSearchContext,
  privacyStateReader?: PrivacyStateReader,
  limit = MAX_VISIBLE_RESULTS,
  pageSize = PAGE_SIZE,
  maxBatches = MAX_PAGED_BATCHES
): Promise<CollectedVisibleKeywordResults> {
  const pagingRequest = context.pagedRequest;
  const firstBatch = await client.search({
    query: context.request.query,
    appName: context.request.appName,
    from: context.request.from,
    to: context.request.to,
    limit: pageSize,
    offset: 0
  });

  if (firstBatch.length === 0) {
    return {
      request: pagingRequest,
      initialItemsForPrivacyReapply: [],
      initialVisibleEvidence: [],
      backfillRequest: pagingRequest,
      evidence: [],
      partialFailure: false,
      cursor: null,
      backfillCursor: null
    };
  }

  let latestPrivacy = await readSearchPrivacyState(privacyStateReader);

  const unboundedFirstBatchResults = mapKeywordEvidence(firstBatch);
  const firstBatchExtendsBeyondLocalNow = context.requiresRestart
    && unboundedFirstBatchResults.some((record) => compareTimestamps(record.timestamp, pagingRequest.to ?? record.timestamp) > 0);
  let results: RetrievalEvidenceItem[] = unboundedFirstBatchResults;
  let backfillRequest = context.request;
  let backfillCursor = createPaginationCursor(0, firstBatch.length, pageSize, maxBatches - 1);
  let backfillFallbackOffsetDelta: number | undefined;
  const firstVisibleResults = await confirmVisibleResults(results, latestPrivacy, limit, privacyStateReader);
  latestPrivacy = firstVisibleResults.privacy;
  const initialVisibleEvidence = trimCollectedResults(results, latestPrivacy, limit);
  let allowFallbackRequest = context.requiresRestart && (firstBatchExtendsBeyondLocalNow || initialVisibleEvidence.length > 0);

  const toInitialItemsForPrivacyReapply = (currentResults: RetrievalEvidenceItem[]): RetrievalEvidenceItem[] => (
    context.requiresRestart
      ? mergeKeywordItemsForPrivacyReapply(unboundedFirstBatchResults, currentResults)
      : currentResults
  );

  if (context.requiresRestart) {
    backfillRequest = pagingRequest;
    const boundedResults = results.filter((record) => compareTimestamps(record.timestamp, pagingRequest.to ?? record.timestamp) <= 0);
    backfillFallbackOffsetDelta = unboundedFirstBatchResults.length - boundedResults.length;
    backfillCursor = createRestartPaginationCursor(firstBatch.length, boundedResults.length, pageSize, maxBatches - 1);
  }

  if (firstVisibleResults.stable) {
    return {
      request: context.requiresRestart ? pagingRequest : context.request,
      initialItemsForPrivacyReapply: toInitialItemsForPrivacyReapply(results),
      initialVisibleEvidence,
      backfillRequest,
      backfillFallbackRequest: allowFallbackRequest ? context.request : undefined,
      backfillFallbackOffsetDelta,
      evidence: results,
      partialFailure: false,
      cursor: createPaginationCursor(0, firstBatch.length, pageSize, maxBatches - 1),
      backfillCursor
    };
  }

  if (firstBatch.length < pageSize || maxBatches <= 1) {
    return {
      request: context.request,
      initialItemsForPrivacyReapply: toInitialItemsForPrivacyReapply(results),
      initialVisibleEvidence,
      backfillRequest,
      evidence: results,
      partialFailure: false,
      cursor: null,
      backfillCursor: null
    };
  }

  let offset = firstBatch.length;
  let effectiveRequest = context.request;

  if (context.requiresRestart) {
    effectiveRequest = pagingRequest;
    results = results.filter((record) => compareTimestamps(record.timestamp, pagingRequest.to ?? record.timestamp) <= 0);
    offset = results.length;
  }

  for (let batchIndex = 1; batchIndex < maxBatches; batchIndex += 1) {
    let batch: Awaited<ReturnType<ScreenpipeClient['search']>>;

    try {
      batch = await client.search({
        query: effectiveRequest.query,
        appName: effectiveRequest.appName,
        from: effectiveRequest.from,
        to: effectiveRequest.to,
        limit: pageSize,
        offset
      });
    } catch (error) {
      return {
        request: effectiveRequest,
        initialItemsForPrivacyReapply: toInitialItemsForPrivacyReapply(results),
        initialVisibleEvidence,
        backfillRequest: effectiveRequest,
        backfillFallbackRequest: allowFallbackRequest ? context.request : undefined,
        backfillFallbackOffsetDelta,
        evidence: results,
        partialFailure: true,
        cursor: null,
        backfillCursor: null
      };
    }

    if (batch.length === 0) {
      break;
    }

    latestPrivacy = await readSearchPrivacyState(privacyStateReader);

    results.push(...mapKeywordEvidence(batch));

    const visibleResults = await confirmVisibleResults(results, latestPrivacy, limit, privacyStateReader);
    latestPrivacy = visibleResults.privacy;
    allowFallbackRequest = allowFallbackRequest || trimCollectedResults(results, latestPrivacy, limit).length > 0;

    if (visibleResults.stable) {
      return {
        request: effectiveRequest,
        initialItemsForPrivacyReapply: toInitialItemsForPrivacyReapply(results),
        initialVisibleEvidence,
        backfillRequest: effectiveRequest,
        backfillFallbackRequest: allowFallbackRequest ? context.request : undefined,
        backfillFallbackOffsetDelta,
        evidence: results,
        partialFailure: false,
        cursor: createPaginationCursor(offset, batch.length, pageSize, maxBatches - batchIndex - 1),
        backfillCursor: createPaginationCursor(offset, batch.length, pageSize, maxBatches - batchIndex - 1)
      };
    }

    if (batch.length < pageSize) {
      break;
    }

    offset += batch.length;
  }

  if (context.requiresRestart && allowFallbackRequest) {
    const fallbackOffset = results.length + (backfillFallbackOffsetDelta ?? 0);

    return {
      request: context.request,
      initialItemsForPrivacyReapply: toInitialItemsForPrivacyReapply(results),
      initialVisibleEvidence,
      backfillRequest: context.request,
      evidence: results,
      partialFailure: false,
      cursor: null,
      backfillCursor: {
        offset: fallbackOffset,
        pageSize,
        remainingBatches: 1
      }
    };
  }

  return {
    request: context.request,
    initialItemsForPrivacyReapply: toInitialItemsForPrivacyReapply(results),
    initialVisibleEvidence,
    backfillRequest: context.request,
    backfillFallbackOffsetDelta,
    evidence: results,
    partialFailure: false,
    cursor: null,
    backfillCursor: null
  };
}

async function createSemanticQueryPager(
  vectorStore: VectorStore,
  request: SearchScreenRequest,
  queryEmbedding: number[],
  pageSize = PAGE_SIZE,
  maxBatches = MAX_PAGED_BATCHES
): Promise<SemanticQueryPager> {
  const snapshotRequest = {
    queryEmbedding,
    appName: request.appName,
    from: request.from,
    to: request.to,
    limit: pageSize * maxBatches,
    offset: 0
  };
  const snapshot = vectorStore.querySnapshot
    ? await vectorStore.querySnapshot(snapshotRequest)
    : await vectorStore.query(snapshotRequest);

  return {
    async query(offset: number, limit: number): Promise<RetrievalEvidenceItem[]> {
      return snapshot.slice(offset, offset + limit);
    }
  };
}

async function collectVisibleSemanticResults(
  pager: SemanticQueryPager,
  privacyStateReader?: PrivacyStateReader,
  limit = MAX_VISIBLE_RESULTS,
  pageSize = PAGE_SIZE,
  maxBatches = MAX_PAGED_BATCHES
): Promise<CollectedVisibleResults> {
  const results: RetrievalEvidenceItem[] = [];
  let offset = 0;
  let latestPrivacy: PrivacyState | null = null;

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    let batch: RetrievalEvidenceItem[];

    try {
      batch = await pager.query(offset, pageSize);
    } catch (error) {
      if (results.length > 0) {
        return {
          evidence: results,
          partialFailure: true,
          cursor: null
        };
      }

      throw error;
    }

    if (batch.length === 0) {
      break;
    }

    latestPrivacy = await readSearchPrivacyState(privacyStateReader);

    results.push(...batch);

    const visibleResults = await confirmVisibleResults(results, latestPrivacy, limit, privacyStateReader);
    latestPrivacy = visibleResults.privacy;

    if (visibleResults.stable) {
      return {
        evidence: results,
        partialFailure: false,
        cursor: createPaginationCursor(offset, batch.length, pageSize, maxBatches - batchIndex - 1)
      };
    }

    if (batch.length < pageSize) {
      break;
    }

    offset += batch.length;
  }

  return {
    evidence: results,
    partialFailure: false,
    cursor: null
  };
}

function partialKeywordReason(): string {
  return 'Screenpipe search returned partial keyword results before failing.';
}

function partialSemanticReason(): string {
  return 'Semantic retrieval returned partial vector-store results before failing.';
}

function createKeywordResultBackfiller(
  client: ScreenpipeClient,
  request: SearchScreenRequest,
  initialCursor: PaginationCursor | null,
  options: KeywordResultBackfillerOptions = {}
): ResultBackfiller {
  let cursor = initialCursor;
  let activeRequest = request;
  let fallbackCursor: PaginationCursor | null = null;
  let usingFallbackRequest = false;

  return {
    canContinue(): boolean {
      return cursor !== null || fallbackCursor !== null;
    },
    async extend(items: RetrievalEvidenceItem[]): Promise<RetrievalEvidenceItem[]> {
      if (!cursor) {
        if (!fallbackCursor || !options.fallbackRequest || usingFallbackRequest) {
          return items;
        }

        cursor = fallbackCursor;
        fallbackCursor = null;
        activeRequest = options.fallbackRequest;
        usingFallbackRequest = true;
      }

      const activeCursor = cursor;
      const page = await client.search({
        query: activeRequest.query,
        appName: activeRequest.appName,
        from: activeRequest.from,
        to: activeRequest.to,
        limit: activeCursor.pageSize,
        offset: activeCursor.offset
      });
      cursor = advancePaginationCursor(activeCursor, page.length);
      if (
        !usingFallbackRequest
        && options.fallbackRequest
        && activeRequest.to
        && !options.fallbackRequest.to
        && cursor === null
      ) {
        fallbackCursor = {
          ...activeCursor,
          offset: activeCursor.offset + page.length + (options.fallbackOffsetDelta ?? 0)
        };
      }
      if (page.length === 0) {
        return items;
      }

      const existingIds = new Set(items.map((item) => item.id));
      const newItems = mapKeywordEvidence(page).filter((item) => !existingIds.has(item.id));
      if (newItems.length === 0) {
        return items;
      }

      return [...items, ...newItems];
    }
  };
}

function createSemanticResultBackfiller(
  pager: SemanticQueryPager,
  initialCursor: PaginationCursor | null
): ResultBackfiller {
  let cursor = initialCursor;

  return {
    canContinue(): boolean {
      return cursor !== null;
    },
    async extend(items: RetrievalEvidenceItem[]): Promise<RetrievalEvidenceItem[]> {
      if (!cursor) {
        return items;
      }

      const page = await pager.query(cursor.offset, cursor.pageSize);
      cursor = advancePaginationCursor(cursor, page.length);
      if (page.length === 0) {
        return items;
      }

      return [...items, ...page];
    }
  };
}

function partialHybridReason(
  keywordPartialFailure: boolean,
  semanticPartialFailure: boolean
): SearchScreenResult['degraded'] {
  if (keywordPartialFailure && semanticPartialFailure) {
    return {
      reason: 'Keyword and semantic retrieval both returned partial results before later page failures.'
    };
  }

  if (keywordPartialFailure) {
    return { reason: partialKeywordReason() };
  }

  if (semanticPartialFailure) {
    return { reason: partialSemanticReason() };
  }

  return undefined;
}

export class DefaultSearchScreenService implements SearchScreenService {
  constructor(private readonly deps: SearchScreenServiceDependencies) {}

  async search(request: SearchScreenRequest): Promise<SearchScreenResult> {
    const checkpoint = await this.deps.checkpointStore.readLatest();
    const freshness = this.deps.freshnessPolicy.evaluate(checkpoint);

    try {
      await readPrivacyState(this.deps.privacyState);
    } catch {
      return createPrivacyUnavailableResult(freshness);
    }

    let keywordResults: RetrievalEvidenceItem[] = [];
    let semanticResults: RetrievalEvidenceItem[] = [];
    let keywordFailed = false;
    let keywordPartialFailure = false;
    let semanticPartialFailure = false;
    let keywordBackfiller: ResultBackfiller | undefined;
    let semanticBackfiller: ResultBackfiller | undefined;
    let queryEmbedding: number[] | undefined;

    const needsKeyword = request.mode === 'keyword' || request.mode === 'hybrid';
    const needsSemantic = request.mode === 'semantic' || request.mode === 'hybrid';
    const keywordSearchContext = createKeywordSearchContext(request);
    const semanticSearchRequest = request;

    if (needsKeyword) {
      try {
        const keywordCollection = await collectVisibleKeywordResults(
          this.deps.screenpipeClient,
          keywordSearchContext,
          this.deps.privacyState
        );
        keywordResults = keywordCollection.initialItemsForPrivacyReapply;
        keywordPartialFailure = keywordCollection.partialFailure;
        keywordBackfiller = keywordCollection.partialFailure
          ? undefined
          : createKeywordResultBackfiller(
              this.deps.screenpipeClient,
              keywordCollection.backfillRequest,
              keywordCollection.backfillCursor,
              {
                fallbackRequest: keywordCollection.backfillFallbackRequest,
                fallbackOffsetDelta: keywordCollection.backfillFallbackOffsetDelta
              }
            );
      } catch (error) {
        if (isPrivacyReadError(error)) {
          return createPrivacyUnavailableResult(freshness);
        }

        keywordFailed = true;
        if (request.mode === 'keyword') {
          return {
            summary: 'Screen history is currently unavailable.',
            evidence: [],
            freshness,
            error: {
              code: 'SCREENPIPE_UNAVAILABLE',
              message: 'Screenpipe search failed while processing the request.',
              action: 'Verify the local Screenpipe service is reachable and retry the query.'
            }
          };
        }
      }
    }

    if (needsSemantic) {
      try {
        queryEmbedding = await this.deps.embeddingProvider.embed(request.query);
      } catch {
        if (request.mode === 'semantic') {
          try {
            const keywordFallback = await collectVisibleKeywordResults(
              this.deps.screenpipeClient,
              keywordSearchContext,
              this.deps.privacyState
            );
            return applyLatestPrivacyToResult(
              request,
              freshness,
              keywordFallback.initialItemsForPrivacyReapply,
              this.deps.privacyState,
              {
                reason: keywordFallback.partialFailure
                  ? 'Embedding provider failed; returned partial keyword-backed results before Screenpipe failed.'
                  : 'Embedding provider failed; returned keyword-backed results instead.',
                fallbackMode: 'keyword'
              },
              keywordFallback.partialFailure
                ? undefined
                : createKeywordResultBackfiller(
                    this.deps.screenpipeClient,
                    keywordFallback.backfillRequest,
                    keywordFallback.backfillCursor,
                    { fallbackRequest: keywordFallback.backfillFallbackRequest, fallbackOffsetDelta: keywordFallback.backfillFallbackOffsetDelta }
                  ),
              privacyBackfillKeywordReason()
            );
          } catch (error) {
            if (isPrivacyReadError(error)) {
              return createPrivacyUnavailableResult(freshness);
            }
            return {
              summary: 'Search is currently unavailable.',
              evidence: [],
              freshness,
              error: {
                code: 'RETRIEVAL_FAILED',
                message: 'Semantic retrieval and keyword fallback both failed while processing the request.',
                action: 'Verify Screenpipe and the embedding provider are both available, then retry the query.'
              }
            };
          }
        }

        if (keywordFailed) {
          return {
            summary: 'Search is currently unavailable.',
            evidence: [],
            freshness,
            error: {
              code: 'RETRIEVAL_FAILED',
              message: 'Keyword and semantic retrieval both failed while processing the hybrid search.',
              action: 'Verify Screenpipe and the embedding provider are both available, then retry the query.'
            }
          };
        }

        return applyLatestPrivacyToResult(
          request,
          freshness,
          keywordResults,
          this.deps.privacyState,
          {
            reason: keywordPartialFailure
              ? 'Embedding provider failed; returned partial keyword-backed results before Screenpipe failed.'
              : 'Embedding provider failed; returned keyword-backed results instead.',
            fallbackMode: 'keyword'
          },
          keywordBackfiller,
          privacyBackfillKeywordReason()
        );
      }

      try {
        const semanticPager = await createSemanticQueryPager(
          this.deps.vectorStore,
          semanticSearchRequest,
          queryEmbedding
        );
        const semanticCollection = await collectVisibleSemanticResults(
          semanticPager,
          this.deps.privacyState
        );
        semanticResults = semanticCollection.evidence;
        semanticPartialFailure = semanticCollection.partialFailure;
        semanticBackfiller = semanticCollection.partialFailure
          ? undefined
          : createSemanticResultBackfiller(semanticPager, semanticCollection.cursor);
      } catch (error) {
        if (isPrivacyReadError(error)) {
          return createPrivacyUnavailableResult(freshness);
        }

        if (request.mode === 'semantic') {
          return {
            summary: 'Search is currently unavailable.',
            evidence: [],
            freshness,
            error: {
              code: 'RETRIEVAL_FAILED',
              message: 'Semantic retrieval failed while querying the local vector store.',
              action: 'Verify the local vector store is available and retry the query.'
            }
          };
        }

        if (keywordFailed) {
          return {
            summary: 'Search is currently unavailable.',
            evidence: [],
            freshness,
            error: {
              code: 'RETRIEVAL_FAILED',
              message: 'Keyword and semantic retrieval both failed while processing the hybrid search.',
              action: 'Verify Screenpipe and the local vector store are both available, then retry the query.'
            }
          };
        }

        return applyLatestPrivacyToResult(
          request,
          freshness,
          keywordResults,
          this.deps.privacyState,
          {
            reason: keywordPartialFailure
              ? 'Semantic retrieval failed; preserved partial keyword-backed results gathered before Screenpipe failed.'
              : 'Semantic retrieval failed; returned keyword-backed results instead.',
            fallbackMode: 'keyword'
          },
          keywordBackfiller,
          privacyBackfillKeywordReason()
        );
      }
    }

    if (request.mode === 'hybrid' && keywordFailed) {
      if (semanticResults.length > 0) {
        return applyLatestPrivacyToResult(
          request,
          freshness,
          semanticResults,
          this.deps.privacyState,
          {
            reason: semanticPartialFailure
              ? 'Screenpipe search failed; preserved partial semantic-backed results gathered before the vector store failed.'
              : 'Screenpipe search failed; returned semantic-backed results instead.',
            fallbackMode: 'semantic'
          },
          semanticBackfiller,
          privacyBackfillSemanticReason()
        );
      }

      return {
        summary: 'Screen history is currently unavailable.',
        evidence: [],
        freshness,
        error: {
          code: 'SCREENPIPE_UNAVAILABLE',
          message: 'Screenpipe search failed while processing the hybrid request.',
          action: 'Verify the local Screenpipe service is reachable and retry the query.'
        }
      };
    }

    if (request.mode === 'hybrid') {
      return applyLatestPrivacyToHybridResult(
        request,
        freshness,
        keywordResults,
        semanticResults,
        this.deps.privacyState,
        partialHybridReason(keywordPartialFailure, semanticPartialFailure),
        keywordBackfiller,
        semanticBackfiller
      );
    }

    const evidence = request.mode === 'keyword'
      ? keywordResults
      : semanticResults;

    const backfiller = request.mode === 'keyword'
      ? keywordBackfiller
      : semanticBackfiller;

    return applyLatestPrivacyToResult(
      request,
      freshness,
      evidence,
      this.deps.privacyState,
      request.mode === 'keyword'
        ? (keywordPartialFailure ? { reason: partialKeywordReason() } : undefined)
        : (semanticPartialFailure ? { reason: partialSemanticReason() } : undefined),
      backfiller,
      request.mode === 'keyword'
        ? privacyBackfillKeywordReason()
        : privacyBackfillSemanticReason()
    );


  }
}

export function createSearchScreenService(
  deps: SearchScreenServiceDependencies
): SearchScreenService {
  return new DefaultSearchScreenService(deps);
}
