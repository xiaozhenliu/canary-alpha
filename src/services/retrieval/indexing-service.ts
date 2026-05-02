import type { PrivacyState, PrivacyStateReader, PrivacySuppressedRange } from '../privacy/types.js';
import { DEFAULT_PRIVACY_STATE } from '../privacy/types.js';
import type {
  CheckpointStore,
  EmbeddingProvider,
  IndexedBacklogProgress,
  IndexedCheckpoint,
  IndexingRunResult,
  IndexingService,
  ScreenpipeClient,
  ScreenpipeRecord,
  VectorStoreRecord,
  VectorStore
} from './types.js';

export interface IndexingServiceDependencies {
  embeddingProvider: EmbeddingProvider;
  screenpipeClient: ScreenpipeClient;
  vectorStore: VectorStore;
  checkpointStore: CheckpointStore;
  freshnessWindowMinutes: number;
  maxCatchUpBatches: number;
  maxCatchUpRecords: number;
  privacyState?: PrivacyStateReader;
}

interface FetchCandidateRecordsResult {
  fetched: number;
  records: ScreenpipeRecord[];
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

function isNewerThanCheckpoint(record: ScreenpipeRecord, checkpoint: IndexedCheckpoint | null): boolean {
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

function compareRecords(left: ScreenpipeRecord, right: ScreenpipeRecord): number {
  const timestampComparison = compareTimestamps(left.timestamp, right.timestamp);
  if (timestampComparison === 0) {
    return left.id.localeCompare(right.id);
  }

  return timestampComparison;
}

function toVectorStoreRecord(record: ScreenpipeRecord, embedding: number[]): VectorStoreRecord {
  return {
    ...record,
    embedding
  };
}

function toCheckpoint(record: ScreenpipeRecord): IndexedCheckpoint {
  return {
    cursor: record.id,
    timestamp: record.timestamp
  };
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

function isExcluded(record: ScreenpipeRecord, privacy: PrivacyState): boolean {
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

function isSuppressed(record: ScreenpipeRecord, privacy: PrivacyState): boolean {
  const suppressedRanges = privacy.suppressedRanges ?? [];
  return suppressedRanges.some((range) => intersectsSuppressedRange(record.timestamp, range));
}

function isBlockedByPause(record: ScreenpipeRecord, privacy: PrivacyState): boolean {
  if (!privacy.paused || !privacy.pauseStartedAt) {
    return false;
  }

  return compareTimestamps(record.timestamp, privacy.pauseStartedAt) >= 0;
}

function isBlockedByPrivacy(record: ScreenpipeRecord, privacy: PrivacyState): boolean {
  return isExcluded(record, privacy) || isSuppressed(record, privacy) || isBlockedByPause(record, privacy);
}

async function readPrivacyState(reader?: PrivacyStateReader): Promise<PrivacyState> {
  if (!reader) {
    return DEFAULT_PRIVACY_STATE;
  }

  return reader.read();
}

async function fetchCandidateRecords(
  deps: Pick<IndexingServiceDependencies, 'screenpipeClient' | 'freshnessWindowMinutes' | 'maxCatchUpBatches' | 'maxCatchUpRecords'>,
  checkpoint: IndexedCheckpoint | null,
  now: Date,
  forcedBacklog?: IndexedBacklogProgress | null
): Promise<FetchCandidateRecordsResult> {
  const backlog = forcedBacklog ?? getBacklogProgress(checkpoint, now, deps);
  if (!backlog) {
    const windowMinutes = getFetchWindowMinutes(checkpoint, now, deps);
    const records = await deps.screenpipeClient.recent(windowMinutes);
    return {
      fetched: records.length,
      records,
      backlogAfter: null,
      usedBacklog: false
    };
  }

  const records: ScreenpipeRecord[] = [];
  let offset = backlog.nextOffset;
  let backlogAfter: IndexedBacklogProgress | null = backlog;

  for (let batch = 0; batch < deps.maxCatchUpBatches; batch += 1) {
    const page = await deps.screenpipeClient.search({
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

    let refreshedPrivacy: PrivacyState;

    const vectorRecords: VectorStoreRecord[] = [];
    let blockedRecords: ScreenpipeRecord[] = [];
    let firstEmbeddingError: unknown;
    let latestCheckpoint: IndexedCheckpoint | null = checkpointBefore
      ? {
          cursor: checkpointBefore.cursor,
          timestamp: checkpointBefore.timestamp
        }
      : null;

    for (const record of recordsAfterCheckpoint) {
      try {
        refreshedPrivacy = await readPrivacyState(this.deps.privacyState);
      } catch {
        throw new Error('Privacy controls could not be loaded while processing indexing.');
      }

      if (isBlockedByPrivacy(record, refreshedPrivacy)) {
        blockedRecords.push(record);
        continue;
      }

      try {
        const embedding = await this.deps.embeddingProvider.embed(record.text);
        vectorRecords.push(toVectorStoreRecord(record, embedding));
        if (isNewerThanCheckpoint(record, latestCheckpoint)) {
          latestCheckpoint = toCheckpoint(record);
        }
      } catch (error) {
        firstEmbeddingError ??= error;
      }
    }

    let finalPrivacy: PrivacyState;
    while (true) {
      try {
        finalPrivacy = await readPrivacyState(this.deps.privacyState);
      } catch {
        throw new Error('Privacy controls could not be loaded while processing indexing.');
      }

      const stillBlockedRecords: ScreenpipeRecord[] = [];
      let releasedBlockedRecord = false;

      for (const record of blockedRecords) {
        if (isBlockedByPrivacy(record, finalPrivacy)) {
          stillBlockedRecords.push(record);
          continue;
        }

        releasedBlockedRecord = true;
        try {
          const embedding = await this.deps.embeddingProvider.embed(record.text);
          vectorRecords.push(toVectorStoreRecord(record, embedding));
          if (isNewerThanCheckpoint(record, latestCheckpoint)) {
            latestCheckpoint = toCheckpoint(record);
          }
        } catch (error) {
          firstEmbeddingError ??= error;
        }
      }

      blockedRecords = stillBlockedRecords;
      if (!releasedBlockedRecord) {
        break;
      }
    }

    for (const record of blockedRecords) {
      if (firstEmbeddingError) {
        break;
      }

      if (isNewerThanCheckpoint(record, latestCheckpoint)) {
        latestCheckpoint = toCheckpoint(record);
      }
    }

    const checkpointAfter = withBacklogState(latestCheckpoint, backlogAfter);
    const shouldPersistCheckpointBeforeThrow = firstEmbeddingError
      && blockedRecords.length > 0
      && vectorRecords.length === 0;

    if (shouldPersistCheckpointBeforeThrow) {
      await persistCheckpointIfChanged(this.deps.checkpointStore, checkpointBefore, checkpointAfter);
    }

    if (vectorRecords.length === 0) {
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

      throw firstEmbeddingError instanceof Error
        ? firstEmbeddingError
        : new Error('Embedding provider failed for every record in the indexing batch.');
    }

    const persistedRecords = [...vectorRecords]
      .sort(compareRecords)
      .filter((record) => !isBlockedByPrivacy(record, finalPrivacy));
    if (persistedRecords.length === 0) {
      if (firstEmbeddingError) {
        throw firstEmbeddingError instanceof Error
          ? firstEmbeddingError
          : new Error('Embedding provider failed before privacy filtering removed the remaining indexed records.');
      }

      await persistCheckpointIfChanged(this.deps.checkpointStore, checkpointBefore, checkpointAfter);

      return {
        fetched,
        indexed: 0,
        checkpointBefore,
        checkpointAfter,
        hadEmbeddingFailures: false
      };
    }

    await this.deps.vectorStore.upsert(persistedRecords);

    await persistCheckpointIfChanged(this.deps.checkpointStore, checkpointBefore, checkpointAfter);

    return {
      fetched,
      indexed: persistedRecords.length,
      checkpointBefore,
      checkpointAfter,
      hadEmbeddingFailures: firstEmbeddingError !== undefined
    };
  }
}

export function createIndexingService(deps: IndexingServiceDependencies): IndexingService {
  return new DefaultIndexingService(deps);
}
