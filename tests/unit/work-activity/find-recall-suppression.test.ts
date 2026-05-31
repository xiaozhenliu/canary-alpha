/**
 * Coverage for the P0-2 retrieval-side filter: when a privacy
 * cascade-failure tombstone is active, `find` and `recall` MUST
 * exclude evidence / sessions whose timestamps fall inside that
 * window. After reconciliation clears the tombstone, the same
 * queries surface the rows again.
 */

import { describe, expect, it } from 'vitest';

import {
  initDerivedSchema,
  openDerivedDatabase
} from '../../../src/services/work-activity/derived-database.js';
import { SqliteExtractedContentStore } from '../../../src/services/work-activity/extraction/extracted-content-store.js';
import { SqliteSessionStore } from '../../../src/services/work-activity/sessions/session-store.js';
import { DefaultFindService, collectActiveCascadeFailureIntervals } from '../../../src/services/work-activity/find/find-service.js';
import { DefaultRecallService } from '../../../src/services/work-activity/recall/recall-service.js';
import type { PrivacyState, PrivacyStateReader } from '../../../src/services/privacy/types.js';
import type { ExtractionResult } from '../../../src/services/work-activity/extraction/types.js';
import type { SessionAggregator } from '../../../src/services/work-activity/sessions/aggregator.js';
import type { SummaryWorker } from '../../../src/services/work-activity/summary/worker.js';

function makeExtraction(frameId: number, ts: string): ExtractionResult {
  return {
    frameId,
    frameTimestamp: ts,
    appName: 'TestApp',
    contextLabel: 'Test Window',
    contextKey: 'TestApp::test window',
    extractedText: `evidence ${frameId}`,
    extractedTextHash: `hash-${frameId}`,
    extractionRuleKind: 'generic',
    sourceTypes: ['accessibility']
  };
}

class StaticPrivacyReader implements PrivacyStateReader {
  constructor(private readonly state: PrivacyState) {}
  async read(): Promise<PrivacyState> {
    return this.state;
  }
}

describe('collectActiveCascadeFailureIntervals', () => {
  it('returns only unresolved cascade-failure rows', () => {
    const intervals = collectActiveCascadeFailureIntervals([
      { from: '2026-04-13T11:00:00.000Z', to: '2026-04-13T12:00:00.000Z', reason: 'cascade-failure' },
      { from: '2026-04-13T13:00:00.000Z', to: '2026-04-13T14:00:00.000Z', reason: 'cascade-failure', resolvedAt: '2026-04-13T15:00:00.000Z' },
      { from: '2026-04-13T15:00:00.000Z', to: '2026-04-13T16:00:00.000Z', reason: 'pause' }
    ]);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.from).toBe(Date.parse('2026-04-13T11:00:00.000Z'));
  });

  it('drops malformed timestamps without throwing', () => {
    const intervals = collectActiveCascadeFailureIntervals([
      { from: 'not-a-date', to: '2026-04-13T12:00:00.000Z', reason: 'cascade-failure' }
    ]);
    expect(intervals).toEqual([]);
  });
});

describe('FindService filters evidence inside an active cascade-failure window', () => {
  it('hides matched rows whose timestamp falls in the suppression window', async () => {
    const db = openDerivedDatabase(':memory:');
    initDerivedSchema(db);
    const extractedContentStore = new SqliteExtractedContentStore(db);

    await extractedContentStore.upsert(makeExtraction(1, '2026-04-13T10:30:00.000Z')); // outside
    await extractedContentStore.upsert(makeExtraction(2, '2026-04-13T11:30:00.000Z')); // inside
    await extractedContentStore.upsert(makeExtraction(3, '2026-04-13T12:30:00.000Z')); // outside

    const find = new DefaultFindService({
      db,
      privacyState: new StaticPrivacyReader({
        paused: false,
        excludedApps: [],
        suppressedRanges: [
          {
            from: '2026-04-13T11:00:00.000Z',
            to: '2026-04-13T12:00:00.000Z',
            reason: 'cascade-failure'
          }
        ]
      })
    });

    const result = await find.find({ query: 'evidence' });
    const ids = result.data.map((item) => item.frameId).sort();
    expect(ids).toEqual([1, 3]);
  });

  it('does not filter when only resolved tombstones exist', async () => {
    const db = openDerivedDatabase(':memory:');
    initDerivedSchema(db);
    const extractedContentStore = new SqliteExtractedContentStore(db);

    await extractedContentStore.upsert(makeExtraction(11, '2026-04-13T11:30:00.000Z'));

    const find = new DefaultFindService({
      db,
      privacyState: new StaticPrivacyReader({
        paused: false,
        excludedApps: [],
        suppressedRanges: [
          {
            from: '2026-04-13T11:00:00.000Z',
            to: '2026-04-13T12:00:00.000Z',
            reason: 'cascade-failure',
            resolvedAt: '2026-04-13T13:00:00.000Z'
          }
        ]
      })
    });

    const result = await find.find({ query: 'evidence' });
    expect(result.data).toHaveLength(1);
  });
});

describe('RecallService filters sessions intersecting an active cascade-failure window', () => {
  it('hides sessions whose [started_at, ended_at] overlaps the suppression window', async () => {
    const db = openDerivedDatabase(':memory:');
    initDerivedSchema(db);
    const sessionStore = new SqliteSessionStore(db);
    const extractedContentStore = new SqliteExtractedContentStore(db);

    db.exec(`
      INSERT INTO sessions (
        session_id, app_name, context_key, context_label,
        started_at, ended_at, active_seconds, source_types,
        evidence_frame_ids, is_open
      ) VALUES
        ('s-outside', 'TestApp', 'TestApp::test window', 'Test Window',
         '2026-04-13T10:00:00.000Z', '2026-04-13T10:45:00.000Z', 120,
         '["accessibility"]', '[1]', 0),
        ('s-inside', 'TestApp', 'TestApp::test window', 'Test Window',
         '2026-04-13T11:15:00.000Z', '2026-04-13T11:45:00.000Z', 120,
         '["accessibility"]', '[2]', 0),
        ('s-future', 'TestApp', 'TestApp::test window', 'Test Window',
         '2026-04-13T13:00:00.000Z', '2026-04-13T13:30:00.000Z', 60,
         '["accessibility"]', '[3]', 0);
    `);

    const aggregator: SessionAggregator = {
      flushIdleOpenSessions: async () => 0
    } as unknown as SessionAggregator;
    const summaryWorker: SummaryWorker = {
      ensureSummary: async () => ({ text: '', status: 'not_applicable', providerKind: 'template' })
    } as unknown as SummaryWorker;

    const recall = new DefaultRecallService({
      sessionStore,
      extractedContentStore,
      sessionAggregator: aggregator,
      summaryWorker,
      now: () => new Date('2026-04-13T13:30:00.000Z'),
      idleThresholdSeconds: 120,
      privacyState: new StaticPrivacyReader({
        paused: false,
        excludedApps: [],
        suppressedRanges: [
          {
            from: '2026-04-13T11:00:00.000Z',
            to: '2026-04-13T12:00:00.000Z',
            reason: 'cascade-failure'
          }
        ]
      })
    });

    const result = await recall.recall({
      from: '2026-04-13T00:00:00.000Z',
      to: '2026-04-13T23:59:59.999Z',
      includeSummary: false
    });

    if (result.granularity !== 'session') {
      throw new Error('expected session granularity');
    }
    const ids = result.sessions.map((session) => session.sessionId).sort();
    expect(ids).toEqual(['s-future', 's-outside']);
  });
});
