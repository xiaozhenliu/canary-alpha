import { describe, expect, it } from 'vitest';

import type { PrivacyState, PrivacyStateReader } from '../../../src/services/privacy/types.js';
import { createFreshnessPolicy } from '../../../src/services/retrieval/freshness-policy.js';
import { createRecentActivityService } from '../../../src/services/retrieval/recent-activity-service.js';
import type { CheckpointStore, IndexedCheckpoint, ScreenpipeClient, ScreenpipeRecord } from '../../../src/services/retrieval/types.js';

const now = Date.now();
const checkpointTimestamp = new Date(now - 2 * 60_000).toISOString();

function toOffsetTimestamp(timestamp: number, offsetMinutes: number): string {
  const shifted = new Date(timestamp + offsetMinutes * 60_000).toISOString().replace('Z', '');
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteOffsetMinutes / 60)).padStart(2, '0');
  const minutes = String(absoluteOffsetMinutes % 60).padStart(2, '0');

  return `${shifted}${sign}${hours}:${minutes}`;
}

const records: ScreenpipeRecord[] = [
  {
    id: 'recent-1',
    text: 'Opened retrieval planning notes',
    timestamp: new Date(now - 10 * 60_000).toISOString(),
    appName: 'Notes'
  },
  {
    id: 'recent-2',
    text: 'Checked Screenpipe logs',
    timestamp: new Date(now - 5 * 60_000).toISOString(),
    appName: 'Terminal'
  }
];

class StubCheckpointStore implements CheckpointStore {
  constructor(private readonly checkpoint: IndexedCheckpoint | null = {
    cursor: 'checkpoint-1',
    timestamp: checkpointTimestamp
  }) {}

  async readLatest() {
    return this.checkpoint;
  }

  async writeLatest(): Promise<void> {}

  async reset(): Promise<void> {}
}

class StubPrivacyStateReader implements PrivacyStateReader {
  constructor(private readonly state: PrivacyState = { paused: false, excludedApps: [] }) {}

  async read(): Promise<PrivacyState> {
    return this.state;
  }
}

class MutablePrivacyStateReader implements PrivacyStateReader {
  private readCount = 0;

  constructor(private readonly states: PrivacyState[]) {}

  async read(): Promise<PrivacyState> {
    const index = Math.min(this.readCount, this.states.length - 1);
    const state = this.states[index] ?? { paused: false, excludedApps: [] };
    this.readCount += 1;
    return state;
  }
}

class SequencePrivacyStateReader implements PrivacyStateReader {
  private readCount = 0;

  constructor(private readonly steps: Array<PrivacyState | Error>) {}

  async read(): Promise<PrivacyState> {
    const index = Math.min(this.readCount, this.steps.length - 1);
    const step = this.steps[index] ?? { paused: false, excludedApps: [] };
    this.readCount += 1;

    if (step instanceof Error) {
      throw step;
    }

    return step;
  }
}

class ThrowingPrivacyStateReader implements PrivacyStateReader {
  async read(): Promise<PrivacyState> {
    throw new Error('privacy state unavailable');
  }
}

class StubScreenpipeClient implements ScreenpipeClient {
  constructor(private readonly records: ScreenpipeRecord[]) {}

  async search(): Promise<ScreenpipeRecord[]> {
    return this.records;
  }

  async recent(minutes: number): Promise<ScreenpipeRecord[]> {
    const cutoff = Date.now() - minutes * 60_000;
    return this.records.filter((record) => Date.parse(record.timestamp) >= cutoff);
  }
}

class ThrowingScreenpipeClient implements ScreenpipeClient {
  async search(): Promise<ScreenpipeRecord[]> {
    throw new Error('search should not run while paused');
  }

  async recent(): Promise<ScreenpipeRecord[]> {
    throw new Error('recent should not run while paused');
  }
}

class RecordingRecentScreenpipeClient implements ScreenpipeClient {
  recentCalls = 0;

  constructor(private readonly records: ScreenpipeRecord[]) {}

  async search(): Promise<ScreenpipeRecord[]> {
    return this.records;
  }

  async recent(minutes: number): Promise<ScreenpipeRecord[]> {
    this.recentCalls += 1;
    const cutoff = Date.now() - minutes * 60_000;
    return this.records.filter((record) => Date.parse(record.timestamp) >= cutoff);
  }
}

describe('recent activity service', () => {
  const service = createRecentActivityService({
    screenpipeClient: new StubScreenpipeClient(records),
    checkpointStore: new StubCheckpointStore(),
    freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 })
  });

  it('returns summary output by default', async () => {
    const result = await service.getRecentActivity({
      minutes: 60,
      format: 'summary'
    });

    expect(result.summary).toContain('Recent activity returned 2 item(s)');
    expect(result.evidence).toHaveLength(2);
    expect(result.raw).toBeUndefined();
    expect(result.freshness?.status).toBe('fresh');
  });

  it('returns raw chunk output when requested', async () => {
    const result = await service.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(result.evidence).toHaveLength(2);
    expect(result.raw).toEqual(result.evidence);
    expect(result.raw?.[0]?.text).toContain('Opened retrieval planning notes');
  });

  it('filters excluded apps from recent activity output', async () => {
    const filteredService = createRecentActivityService({
      screenpipeClient: new StubScreenpipeClient(records),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['Terminal']
      })
    });

    const result = await filteredService.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.id).toBe('recent-1');
    expect(result.evidence.every((item) => item.appName !== 'Terminal')).toBe(true);
  });

  it('filters excluded apps case-insensitively with locale-invariant normalization', async () => {
    const filteredService = createRecentActivityService({
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'recent-iina',
          text: 'Watched video notes',
          timestamp: new Date(now - 5 * 60_000).toISOString(),
          appName: 'IINA'
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: ['iina']
      })
    });

    const result = await filteredService.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(result.evidence).toEqual([]);
  });

  it('filters records captured inside suppressed privacy windows after resume', async () => {
    const suppressedService = createRecentActivityService({
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'suppressed',
          text: 'Private work during pause',
          timestamp: new Date(now - 12 * 60_000).toISOString(),
          appName: 'Notes'
        },
        {
          id: 'visible',
          text: 'Visible work after resume',
          timestamp: new Date(now - 4 * 60_000).toISOString(),
          appName: 'Terminal'
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: [],
        suppressedRanges: [
          {
            from: new Date(now - 15 * 60_000).toISOString(),
            to: new Date(now - 5 * 60_000).toISOString()
          }
        ]
      })
    });

    const result = await suppressedService.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['visible']);
  });

  it('filters suppressed records when provider timestamps use timezone offsets', async () => {
    const offsetSuppressedService = createRecentActivityService({
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'suppressed-offset',
          text: 'Private work during pause with offset timestamp',
          timestamp: toOffsetTimestamp(now - 10 * 60_000, 8 * 60),
          appName: 'Notes'
        },
        {
          id: 'visible-offset',
          text: 'Visible work after resume with offset timestamp',
          timestamp: toOffsetTimestamp(now - 4 * 60_000, 8 * 60),
          appName: 'Terminal'
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: false,
        excludedApps: [],
        suppressedRanges: [
          {
            from: new Date(now - 15 * 60_000).toISOString(),
            to: new Date(now - 5 * 60_000).toISOString()
          }
        ]
      })
    });

    const result = await offsetSuppressedService.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['visible-offset']);
  });

  it('applies newly excluded apps before returning recent activity results', async () => {
    const service = createRecentActivityService({
      screenpipeClient: new StubScreenpipeClient(records),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: false, excludedApps: ['terminal'] }
      ])
    });

    const result = await service.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['recent-1']);
    expect(result.evidence.every((item) => item.appName !== 'Terminal')).toBe(true);
  });

  it('restores records when privacy becomes less restrictive before returning recent activity results', async () => {
    const service = createRecentActivityService({
      screenpipeClient: new StubScreenpipeClient(records),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: ['Terminal'] },
        { paused: false, excludedApps: [] }
      ])
    });

    const result = await service.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['recent-1', 'recent-2']);
    expect(result.raw?.map((item) => item.id)).toEqual(['recent-1', 'recent-2']);
  });

  it('does not hide all recent activity for legacy paused states without pauseStartedAt', async () => {
    const service = createRecentActivityService({
      screenpipeClient: new StubScreenpipeClient([
        {
          id: 'recent-legacy-paused-visible',
          text: 'Visible note from before legacy pause',
          timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
          appName: 'Notes'
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: true, excludedApps: [] }
      ])
    });

    const result = await service.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['recent-legacy-paused-visible']);
    expect(result.raw?.map((item) => item.id)).toEqual(['recent-legacy-paused-visible']);
    expect(result.error).toBeUndefined();
  });

  it('hides only records captured during an active pause before recent activity returns', async () => {
    const pauseStartedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const pausedRecords: ScreenpipeRecord[] = [
      {
        id: 'recent-before-pause',
        text: 'Visible note from before pause',
        timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
        appName: 'Notes'
      },
      {
        id: 'recent-during-pause',
        text: 'Hidden note during pause',
        timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
        appName: 'Claude'
      }
    ];
    const service = createRecentActivityService({
      screenpipeClient: new StubScreenpipeClient(pausedRecords),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new MutablePrivacyStateReader([
        { paused: false, excludedApps: [] },
        { paused: true, excludedApps: [], pauseStartedAt }
      ])
    });

    const result = await service.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['recent-before-pause']);
    expect(result.raw?.map((item) => item.id)).toEqual(['recent-before-pause']);
    expect(result.error).toBeUndefined();
  });


  it('returns an actionable error when privacy reread fails after Screenpipe succeeds', async () => {
    const service = createRecentActivityService({
      screenpipeClient: new StubScreenpipeClient(records),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new SequencePrivacyStateReader([
        { paused: false, excludedApps: [] },
        new Error('privacy state unavailable')
      ])
    });

    const result = await service.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(result.summary).toContain('currently unavailable');
    expect(result.evidence).toEqual([]);
    expect(result.raw).toEqual([]);
    expect(result.error).toMatchObject({
      code: 'RETRIEVAL_FAILED',
      message: 'Privacy controls could not be loaded while processing recent activity.'
    });
  });

  it('returns an actionable error when privacy persistence is unreadable', async () => {
    const fallbackService = createRecentActivityService({
      screenpipeClient: new StubScreenpipeClient(records),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new ThrowingPrivacyStateReader()
    });

    const result = await fallbackService.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(result.summary).toContain('currently unavailable');
    expect(result.evidence).toEqual([]);
    expect(result.raw).toEqual([]);
    expect(result.error).toMatchObject({
      code: 'RETRIEVAL_FAILED'
    });
  });

  it('still queries Screenpipe while paused and filters the active pause window', async () => {
    const pauseStartedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const pausedRecords: ScreenpipeRecord[] = [
      {
        id: 'recent-before-pause',
        text: 'Visible note from before pause',
        timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
        appName: 'Notes'
      },
      {
        id: 'recent-during-pause',
        text: 'Hidden note during pause',
        timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
        appName: 'Claude'
      }
    ];
    const screenpipeClient = new RecordingRecentScreenpipeClient(pausedRecords);
    const pausedService = createRecentActivityService({
      screenpipeClient,
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: true,
        excludedApps: [],
        pauseStartedAt
      })
    });

    const result = await pausedService.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(screenpipeClient.recentCalls).toBe(1);
    expect(result.evidence.map((item) => item.id)).toEqual(['recent-before-pause']);
    expect(result.raw?.map((item) => item.id)).toEqual(['recent-before-pause']);
    expect(result.error).toBeUndefined();
  });

  it('filters paused records even when provider timestamps are slightly ahead of the local clock', async () => {
    const pauseStartedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const futurePausedRecordTimestamp = new Date(Date.now() + 60_000).toISOString();
    const pausedService = createRecentActivityService({
      screenpipeClient: new RecordingRecentScreenpipeClient([
        {
          id: 'recent-before-pause',
          text: 'Visible note from before pause',
          timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
          appName: 'Notes'
        },
        {
          id: 'recent-future-during-pause',
          text: 'Hidden note during pause despite future timestamp',
          timestamp: futurePausedRecordTimestamp,
          appName: 'Claude'
        }
      ]),
      checkpointStore: new StubCheckpointStore(),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 }),
      privacyState: new StubPrivacyStateReader({
        paused: true,
        excludedApps: [],
        pauseStartedAt
      })
    });

    const result = await pausedService.getRecentActivity({
      minutes: 60,
      format: 'raw'
    });

    expect(result.evidence.map((item) => item.id)).toEqual(['recent-before-pause']);
    expect(result.raw?.map((item) => item.id)).toEqual(['recent-before-pause']);
    expect(result.error).toBeUndefined();
  });

  it('reports stale-catchup-allowed freshness while backlog catch-up is unfinished', async () => {
    const backlogService = createRecentActivityService({
      screenpipeClient: new StubScreenpipeClient(records),
      checkpointStore: new StubCheckpointStore({
        cursor: 'checkpoint-1',
        timestamp: checkpointTimestamp,
        backlog: {
          from: '2026-04-13T11:45:00.000Z',
          to: '2026-04-13T12:00:00.000Z',
          nextOffset: 2
        }
      }),
      freshnessPolicy: createFreshnessPolicy({ freshnessWindowMinutes: 15 })
    });

    const result = await backlogService.getRecentActivity({
      minutes: 60,
      format: 'summary'
    });

    expect(result.freshness?.status).toBe('stale-catchup-allowed');
  });
});
