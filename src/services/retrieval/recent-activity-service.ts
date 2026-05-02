import type { PrivacyState, PrivacyStateReader, PrivacySuppressedRange } from '../privacy/types.js';
import { DEFAULT_PRIVACY_STATE } from '../privacy/types.js';
import type {
  CheckpointStore,
  FreshnessPolicy,
  RecentActivityRequest,
  RecentActivityResult,
  RecentActivityService,
  RetrievalEvidenceItem,
  ScreenpipeClient
} from './types.js';

export interface RecentActivityServiceDependencies {
  screenpipeClient: ScreenpipeClient;
  checkpointStore: CheckpointStore;
  freshnessPolicy: FreshnessPolicy;
  privacyState?: PrivacyStateReader;
}

const ACTIVE_PAUSE_OPEN_END = '9999-12-31T23:59:59.999Z';

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

async function filterEvidenceWithLatestPrivacy(
  items: RetrievalEvidenceItem[],
  reader?: PrivacyStateReader
): Promise<{ privacy: PrivacyState; items: RetrievalEvidenceItem[] }> {
  const privacy = await readPrivacyState(reader);
  return {
    privacy,
    items: filterSuppressedRanges(filterExcludedApps(items, privacy), privacy)
  };
}

function mapEvidence(records: Awaited<ReturnType<ScreenpipeClient['recent']>>): RetrievalEvidenceItem[] {
  return records.map((record) => ({
    id: record.id,
    text: record.text,
    timestamp: record.timestamp,
    appName: record.appName,
    source: 'keyword'
  }));
}

function createPrivacyUnavailableResult(
  request: RecentActivityRequest,
  freshness: RecentActivityResult['freshness']
): RecentActivityResult {
  return {
    summary: 'Recent activity is currently unavailable.',
    evidence: [],
    raw: request.format === 'raw' ? [] : undefined,
    freshness,
    error: {
      code: 'RETRIEVAL_FAILED',
      message: 'Privacy controls could not be loaded while processing recent activity.',
      action: 'Verify the local privacy-state file is readable and contains valid JSON, then retry the request.'
    }
  };
}

function summarize(minutes: number, evidence: RetrievalEvidenceItem[]): string {
  if (evidence.length === 0) {
    return `No recent activity was captured in the last ${minutes} minute(s).`;
  }

  return `Recent activity returned ${evidence.length} item(s) from the last ${minutes} minute(s).`;
}

export class DefaultRecentActivityService implements RecentActivityService {
  constructor(private readonly deps: RecentActivityServiceDependencies) {}

  async getRecentActivity(request: RecentActivityRequest): Promise<RecentActivityResult> {
    const checkpoint = await this.deps.checkpointStore.readLatest();
    const freshness = this.deps.freshnessPolicy.evaluate(checkpoint);

    try {
      await readPrivacyState(this.deps.privacyState);
    } catch {
      return createPrivacyUnavailableResult(request, freshness);
    }

    let records: Awaited<ReturnType<ScreenpipeClient['recent']>>;
    try {
      records = await this.deps.screenpipeClient.recent(request.minutes);
    } catch {
      return {
        summary: 'Recent activity is currently unavailable.',
        evidence: [],
        raw: request.format === 'raw' ? [] : undefined,
        freshness,
        error: {
          code: 'SCREENPIPE_UNAVAILABLE',
          message: 'Screenpipe recent activity retrieval failed.',
          action: 'Verify the local Screenpipe service is running and retry the request.'
        }
      };
    }

    const evidence = mapEvidence(records);

    try {
      const filteredResult = await filterEvidenceWithLatestPrivacy(evidence, this.deps.privacyState);

      return {
        summary: summarize(request.minutes, filteredResult.items),
        evidence: filteredResult.items,
        raw: request.format === 'raw' ? filteredResult.items : undefined,
        freshness
      };
    } catch {
      return createPrivacyUnavailableResult(request, freshness);
    }
  }
}

export function createRecentActivityService(
  deps: RecentActivityServiceDependencies
): RecentActivityService {
  return new DefaultRecentActivityService(deps);
}
