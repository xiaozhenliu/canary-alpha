/**
 * Unit tests for `DefaultRecallService` (work-activity-analysis task 8.4).
 *
 * The service answers `recall(...)` requests in three shapes:
 *
 *   - `granularity = 'session'` (default) — list session items;
 *     optionally enrich with summaries via `SummaryWorker.ensureSummary`.
 *   - `granularity = 'hour'` / `'day'` — bucket session active-time
 *     by frame timestamp (`bucketSessionActiveSeconds`) and emit
 *     deterministic per-block narratives.
 *
 * Tests run against a real in-memory derived database so the SQL
 * layer is exercised end-to-end. Where behaviour is genuinely
 * provider-coupled (`includeSummary=true`) we substitute a stub
 * `SummaryWorker` so the test does not depend on the privacy reader,
 * the registry, or the template provider's bytes-shape.
 *
 * Coverage maps to the spec contract:
 *
 *   - **R7.10 / W20** — session-mode response carries a non-null
 *     `narrativeText` and an array of session items (possibly empty).
 *   - **R7.10 / R8** — per-item `summary` is populated only when
 *     `includeSummary=true` and reflects the worker's status /
 *     provider kind verbatim.
 *   - **R7.11 / W20** — hour/day-mode response carries a non-null
 *     top-level `narrativeText` and an array of blocks; each block
 *     carries its own non-null `narrativeText`.
 *   - **R7.11** — sessions crossing bucket boundaries split active
 *     seconds across buckets by frame timestamp, and per-bucket
 *     `byApp` aggregates correctly across sessions.
 *   - **R7.16 / W22 (Stateless)** — calling `recall` twice on
 *     unchanged data yields equal results.
 *   - **flushIdleOpenSessions** — the entry-point flush is invoked
 *     exactly once per call (design §4 + R3.6).
 *
 * **Validates: Requirements 7.9, 7.10, 7.11, 7.15, 7.16**
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initDerivedSchema,
  openDerivedDatabase,
  type DerivedDatabase
} from '../../../src/services/work-activity/derived-database.js';
import { SqliteExtractedContentStore } from '../../../src/services/work-activity/extraction/extracted-content-store.js';
import {
  DefaultSessionAggregator,
  type SessionAggregator
} from '../../../src/services/work-activity/sessions/aggregator.js';
import { SqliteSessionStore } from '../../../src/services/work-activity/sessions/session-store.js';
import { DefaultRecallService } from '../../../src/services/work-activity/recall/recall-service.js';
import type { ExtractionResult } from '../../../src/services/work-activity/extraction/types.js';
import type { SummaryWorker, EnsureSummaryResult } from '../../../src/services/work-activity/summary/worker.js';

// ---------------------------------------------------------------------------
// Per-test fixture — fresh in-memory derived database
// ---------------------------------------------------------------------------

const IDLE_THRESHOLD = 120;
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

let db: DerivedDatabase;
let extracted: SqliteExtractedContentStore;
let sessions: SqliteSessionStore;
let aggregator: DefaultSessionAggregator;
let idCounter = 0;

beforeEach(() => {
  db = openDerivedDatabase(':memory:');
  initDerivedSchema(db);
  extracted = new SqliteExtractedContentStore(db);
  sessions = new SqliteSessionStore(db);
  idCounter = 0;
  aggregator = new DefaultSessionAggregator({
    store: sessions,
    idleThresholdSeconds: IDLE_THRESHOLD,
    now: () => FIXED_NOW,
    generateSessionId: () => `sid-${++idCounter}`
  });
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Stub SummaryWorker
// ---------------------------------------------------------------------------

/**
 * Minimal `SummaryWorker` double. Records every call and returns a
 * caller-supplied result, defaulting to a deterministic `'ready'`
 * envelope so existing tests that do not exercise specific status
 * transitions stay short. The class is shaped via inheritance from
 * the real `SummaryWorker` so TypeScript accepts it where the
 * service expects the production type.
 */
class StubSummaryWorker {
  readonly calls: string[] = [];
  result: EnsureSummaryResult = {
    status: 'ready',
    text: 'stub summary',
    providerKind: 'template'
  };

  async ensureSummary(sessionId: string): Promise<EnsureSummaryResult> {
    this.calls.push(sessionId);
    return this.result;
  }
}

function asWorker(stub: StubSummaryWorker): SummaryWorker {
  // The service depends only on the `ensureSummary` method, so
  // structural typing is enough. A `vi.mocked` style would have
  // worked here too — we keep the bare class for readability.
  return stub as unknown as SummaryWorker;
}

// ---------------------------------------------------------------------------
// Service factory + fixture helpers
// ---------------------------------------------------------------------------

interface BuildOptions {
  worker?: StubSummaryWorker;
  aggregatorOverride?: SessionAggregator;
  now?: () => Date;
}

function buildService(options: BuildOptions = {}): {
  service: DefaultRecallService;
  worker: StubSummaryWorker;
} {
  const worker = options.worker ?? new StubSummaryWorker();
  const service = new DefaultRecallService({
    sessionStore: sessions,
    extractedContentStore: extracted,
    sessionAggregator: options.aggregatorOverride ?? aggregator,
    summaryWorker: asWorker(worker),
    now: options.now ?? (() => FIXED_NOW),
    idleThresholdSeconds: IDLE_THRESHOLD
  });
  return { service, worker };
}

/**
 * Generates an ISO-8601 timestamp `secondsAfterEpoch` seconds after a
 * fixed base. Tests build per-frame sequences by counting seconds.
 */
function tsAt(secondsAfterEpoch: number): string {
  const base = Date.UTC(2026, 5, 1, 9, 0, 0); // 09:00 UTC on the test day
  return new Date(base + secondsAfterEpoch * 1000).toISOString();
}

function makeExtraction(
  secondsAfterEpoch: number,
  overrides: Partial<ExtractionResult> = {}
): ExtractionResult {
  const appName = overrides.appName ?? 'TestApp';
  const contextLabel = overrides.contextLabel ?? 'Window.txt';
  return {
    frameId: overrides.frameId ?? secondsAfterEpoch,
    frameTimestamp: tsAt(secondsAfterEpoch),
    appName,
    contextLabel,
    contextKey:
      overrides.contextKey ??
      `${appName}::${contextLabel.toLocaleLowerCase('en-US')}`,
    extractedText: overrides.extractedText ?? 'sample text',
    extractedTextHash: overrides.extractedTextHash ?? null,
    extractionRuleKind: overrides.extractionRuleKind ?? 'generic',
    sourceTypes: overrides.sourceTypes ?? ['accessibility']
  };
}

/**
 * Walks a frame sequence through the aggregator AND mirrors each
 * frame into `extracted_content`. The recall service reads both
 * tables, so tests that exercise hour/day bucketing need both
 * surfaces populated — without the `extracted_content` rows
 * `bucketSessionActiveSeconds` would see an empty frame list and
 * skip the session.
 */
async function ingest(frames: ExtractionResult[]): Promise<void> {
  for (const f of frames) {
    await extracted.upsert(f);
    await aggregator.handleExtraction(f);
  }
}

// ---------------------------------------------------------------------------
// granularity = 'session'
// ---------------------------------------------------------------------------

describe('DefaultRecallService — granularity="session"', () => {
  it('returns sessions ordered most-recent-first (matches sessionStore)', async () => {
    await ingest([
      makeExtraction(0, { appName: 'AppA', contextLabel: 'A.txt' })
    ]);
    await ingest([
      makeExtraction(500, { appName: 'AppB', contextLabel: 'B.txt' })
    ]);
    const { service } = buildService();

    const result = await service.recall({ from: tsAt(-10), to: tsAt(1000) });
    if (result.granularity !== 'session') throw new Error('granularity guard');
    expect(result.sessions).toHaveLength(2);
    // SqliteSessionStore.listSessions orders by `started_at DESC`.
    expect(result.sessions[0].appName).toBe('AppB');
    expect(result.sessions[1].appName).toBe('AppA');
  });

  it('omits the summary block when includeSummary=false (W22 / R7.10)', async () => {
    await ingest([makeExtraction(0)]);
    const { service, worker } = buildService();

    const result = await service.recall({
      from: tsAt(-10),
      to: tsAt(100),
      includeSummary: false
    });
    if (result.granularity !== 'session') throw new Error('granularity guard');

    expect(result.sessions[0].summary).toBeUndefined();
    expect(worker.calls).toEqual([]);
  });

  it('populates the summary block when includeSummary=true (R7.10)', async () => {
    await ingest([makeExtraction(0)]);
    const { service, worker } = buildService();
    worker.result = {
      status: 'ready',
      text: 'a deterministic stub summary',
      providerKind: 'template'
    };

    const result = await service.recall({
      from: tsAt(-10),
      to: tsAt(100),
      includeSummary: true
    });
    if (result.granularity !== 'session') throw new Error('granularity guard');

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].summary).toEqual({
      text: 'a deterministic stub summary',
      status: 'ready',
      providerKind: 'template'
    });
    expect(worker.calls).toHaveLength(1);
  });

  it('defaults includeSummary to true (R7.10 default)', async () => {
    await ingest([makeExtraction(0)]);
    const { service, worker } = buildService();

    const result = await service.recall({ from: tsAt(-10), to: tsAt(100) });
    if (result.granularity !== 'session') throw new Error('granularity guard');
    expect(result.sessions[0].summary).toBeDefined();
    expect(worker.calls).toHaveLength(1);
  });

  it('coerces null summary text to empty string (schema requires string)', async () => {
    await ingest([makeExtraction(0)]);
    const { service, worker } = buildService();
    worker.result = { status: 'failed', text: null, providerKind: 'template' };

    const result = await service.recall({ from: tsAt(-10), to: tsAt(100) });
    if (result.granularity !== 'session') throw new Error('granularity guard');
    expect(result.sessions[0].summary).toEqual({
      text: '',
      status: 'failed',
      providerKind: 'template'
    });
  });

  it('stringifies evidenceFrameIds (R7.10 schema declares string[])', async () => {
    await ingest([
      makeExtraction(0, { frameId: 7 }),
      makeExtraction(10, { frameId: 8 })
    ]);
    const { service } = buildService();

    const result = await service.recall({
      from: tsAt(-10),
      to: tsAt(100),
      includeSummary: false
    });
    if (result.granularity !== 'session') throw new Error('granularity guard');
    expect(result.sessions[0].evidenceFrameIds).toEqual(['7', '8']);
    expect(result.sessions[0].evidenceFrameIds.every((id) => typeof id === 'string')).toBe(
      true
    );
  });

  it('filters by appName when provided', async () => {
    await ingest([makeExtraction(0, { appName: 'AppA', contextLabel: 'A' })]);
    await ingest([makeExtraction(500, { appName: 'AppB', contextLabel: 'B' })]);
    const { service } = buildService();

    const result = await service.recall({
      from: tsAt(-10),
      to: tsAt(1000),
      appName: 'AppB',
      includeSummary: false
    });
    if (result.granularity !== 'session') throw new Error('granularity guard');
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].appName).toBe('AppB');
  });
});

// ---------------------------------------------------------------------------
// granularity = 'hour' / 'day'
// ---------------------------------------------------------------------------

describe('DefaultRecallService — granularity="hour" / "day"', () => {
  it('buckets a session entirely inside one hour', async () => {
    // Session: 09:00:00 → 09:00:30 (within a single 09:00 hour bucket)
    await ingest([
      makeExtraction(0, { appName: 'AppA', frameId: 1 }),
      makeExtraction(10, { appName: 'AppA', frameId: 2 }),
      makeExtraction(30, { appName: 'AppA', frameId: 3 })
    ]);
    const { service } = buildService();

    const result = await service.recall({
      from: tsAt(-10),
      to: tsAt(120),
      granularity: 'hour'
    });
    if (result.granularity !== 'hour') throw new Error('granularity guard');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].start).toBe('2026-06-01T09:00:00.000Z');
    expect(result.blocks[0].end).toBe('2026-06-01T10:00:00.000Z');
    expect(result.blocks[0].sessionCount).toBe(1);
    // Active time = (10s gap clamped) + (20s gap clamped) + 1s tail = 31s
    expect(result.blocks[0].totalActiveSeconds).toBe(31);
    expect(result.blocks[0].byApp).toEqual({ AppA: 31 });
  });

  it('splits a session that crosses an hour boundary across two buckets (R7.11)', async () => {
    // Frames at 09:59:00, 09:59:30, 10:00:30 (cross 10:00 boundary).
    // Use small enough gaps so canExtend keeps them in one session.
    const f1 = makeExtraction(59 * 60, { appName: 'AppX', frameId: 1 });
    const f2 = makeExtraction(59 * 60 + 30, { appName: 'AppX', frameId: 2 });
    const f3 = makeExtraction(60 * 60 + 30, { appName: 'AppX', frameId: 3 });
    await ingest([f1, f2, f3]);
    const { service } = buildService();

    const result = await service.recall({
      from: tsAt(0),
      to: tsAt(2 * 60 * 60),
      granularity: 'hour'
    });
    if (result.granularity !== 'hour') throw new Error('granularity guard');
    expect(result.blocks).toHaveLength(2);

    // Bucket 09:00..10:00 -> contains f1 (gap to f2 = 30s) and f2 (gap to f3 = 60s) → 30 + 60 = 90s.
    // Bucket 10:00..11:00 -> contains f3 (tail = 1s).
    const bucket0900 = result.blocks.find((b) => b.start.endsWith('T09:00:00.000Z'));
    const bucket1000 = result.blocks.find((b) => b.start.endsWith('T10:00:00.000Z'));
    expect(bucket0900?.totalActiveSeconds).toBe(90);
    expect(bucket1000?.totalActiveSeconds).toBe(1);
    expect(bucket0900?.sessionCount).toBe(1);
    expect(bucket1000?.sessionCount).toBe(1);
    expect(bucket0900?.byApp).toEqual({ AppX: 90 });
    expect(bucket1000?.byApp).toEqual({ AppX: 1 });
  });

  it('aggregates byApp across multiple sessions in the same bucket', async () => {
    await ingest([
      makeExtraction(0, { appName: 'AppA', frameId: 1, contextLabel: 'A' }),
      makeExtraction(10, { appName: 'AppA', frameId: 2, contextLabel: 'A' })
    ]);
    await ingest([
      makeExtraction(300, { appName: 'AppB', frameId: 3, contextLabel: 'B' }),
      makeExtraction(310, { appName: 'AppB', frameId: 4, contextLabel: 'B' })
    ]);
    const { service } = buildService();

    const result = await service.recall({
      from: tsAt(-10),
      to: tsAt(1000),
      granularity: 'hour'
    });
    if (result.granularity !== 'hour') throw new Error('granularity guard');
    expect(result.blocks).toHaveLength(1);
    const byApp = result.blocks[0].byApp;
    expect(byApp.AppA).toBe(11); // 10 (gap) + 1 (tail)
    expect(byApp.AppB).toBe(11);
    expect(result.blocks[0].sessionCount).toBe(2);
    expect(result.blocks[0].totalActiveSeconds).toBe(22);
  });

  it('emits day buckets aligned to UTC midnight when granularity="day"', async () => {
    await ingest([
      makeExtraction(0, { frameId: 1 }),
      makeExtraction(60, { frameId: 2 })
    ]);
    const { service } = buildService();

    const result = await service.recall({
      from: tsAt(-1000),
      to: tsAt(2000),
      granularity: 'day'
    });
    if (result.granularity !== 'day') throw new Error('granularity guard');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].start).toBe('2026-06-01T00:00:00.000Z');
    expect(result.blocks[0].end).toBe('2026-06-02T00:00:00.000Z');
  });

  it('renders deterministic block narratives (per-block W22 input)', async () => {
    await ingest([
      makeExtraction(0, { appName: 'Code', frameId: 1, contextLabel: 'A' }),
      makeExtraction(60, { appName: 'Code', frameId: 2, contextLabel: 'A' })
    ]);
    const { service } = buildService();

    const result = await service.recall({
      from: tsAt(-10),
      to: tsAt(200),
      granularity: 'hour'
    });
    if (result.granularity !== 'hour') throw new Error('granularity guard');
    expect(result.blocks[0].narrativeText).toContain('该时段共 1 个会话');
    expect(result.blocks[0].narrativeText).toContain('Code: 1 分');
    expect(result.blocks[0].narrativeText).toContain('活跃');
  });
});

// ---------------------------------------------------------------------------
// narrativeText is always present (W20 / R7.15)
// ---------------------------------------------------------------------------

describe('DefaultRecallService — W20 narrativeText always present', () => {
  it('returns a non-empty narrative even when no sessions match', async () => {
    const { service } = buildService();

    const result = await service.recall({
      from: tsAt(-1000),
      to: tsAt(0),
      granularity: 'session',
      includeSummary: false
    });
    expect(result.granularity).toBe('session');
    expect(typeof result.narrativeText).toBe('string');
    expect(result.narrativeText).toBe('该时段内未发现会话。');
  });

  it('returns a non-empty narrative for empty hour mode too', async () => {
    const { service } = buildService();
    const result = await service.recall({
      from: tsAt(-1000),
      to: tsAt(0),
      granularity: 'hour'
    });
    expect(result.granularity).toBe('hour');
    expect(result.narrativeText).toBe('该时段内未发现会话。');
  });

  it('renders the session-mode top-level narrative template (R7.10)', async () => {
    await ingest([
      makeExtraction(0, { appName: 'Code' }),
      makeExtraction(10, { appName: 'Code' })
    ]);
    await ingest([
      makeExtraction(500, { appName: 'Chrome', contextLabel: 'tab' })
    ]);
    const { service } = buildService();

    const result = await service.recall({
      from: tsAt(-10),
      to: tsAt(1000),
      includeSummary: false
    });
    expect(result.narrativeText).toContain('个会话');
    expect(result.narrativeText).toContain('总活跃');
    expect(result.narrativeText).toContain('Chrome');
    expect(result.narrativeText).toContain('Code');
  });

  it('renders the time-block top-level narrative template (R7.11)', async () => {
    await ingest([
      makeExtraction(0, { appName: 'Code', frameId: 1 }),
      makeExtraction(60, { appName: 'Code', frameId: 2 })
    ]);
    const { service } = buildService();

    const result = await service.recall({
      from: tsAt(-10),
      to: tsAt(200),
      granularity: 'hour'
    });
    expect(result.narrativeText).toContain('个时段');
    expect(result.narrativeText).toContain('总活跃');
  });
});

// ---------------------------------------------------------------------------
// W22 — Stateless across two identical calls
// ---------------------------------------------------------------------------

describe('DefaultRecallService — W22 Stateless', () => {
  it('returns equal results for two identical session-mode calls', async () => {
    await ingest([
      makeExtraction(0, { appName: 'AppA', frameId: 1 }),
      makeExtraction(10, { appName: 'AppA', frameId: 2 })
    ]);
    await ingest([
      makeExtraction(500, { appName: 'AppB', frameId: 3 })
    ]);
    const { service } = buildService();

    const a = await service.recall({
      from: tsAt(-10),
      to: tsAt(1000),
      includeSummary: true
    });
    const b = await service.recall({
      from: tsAt(-10),
      to: tsAt(1000),
      includeSummary: true
    });
    expect(a).toEqual(b);
  });

  it('returns equal results for two identical hour-mode calls', async () => {
    await ingest([
      makeExtraction(0, { appName: 'AppA', frameId: 1 }),
      makeExtraction(10, { appName: 'AppA', frameId: 2 })
    ]);
    const { service } = buildService();

    const a = await service.recall({
      from: tsAt(-10),
      to: tsAt(200),
      granularity: 'hour'
    });
    const b = await service.recall({
      from: tsAt(-10),
      to: tsAt(200),
      granularity: 'hour'
    });
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// flushIdleOpenSessions is called on entry (design §4 + R3.6)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// flushIdleOpenSessions is called on entry (design §4 + R3.6)
// ---------------------------------------------------------------------------

describe('DefaultRecallService — flushIdleOpenSessions invocation', () => {
  it('calls flushIdleOpenSessions once per recall(...)', async () => {
    await ingest([makeExtraction(0)]);
    const flushSpy = vi.fn().mockResolvedValue({ closed: 0 });
    const aggregatorOverride: SessionAggregator = {
      handleExtraction: aggregator.handleExtraction.bind(aggregator),
      flushIdleOpenSessions: flushSpy
    };

    const { service } = buildService({ aggregatorOverride });
    await service.recall({
      from: tsAt(-10),
      to: tsAt(100),
      includeSummary: false
    });
    expect(flushSpy).toHaveBeenCalledTimes(1);
    // The flush MUST receive a Date (the service's `now()` snapshot).
    expect(flushSpy.mock.calls[0][0]).toBeInstanceOf(Date);
  });

  it('forwards the now() snapshot from the service deps', async () => {
    const customNow = new Date('2026-06-02T08:00:00.000Z');
    const flushSpy = vi.fn().mockResolvedValue({ closed: 0 });
    const aggregatorOverride: SessionAggregator = {
      handleExtraction: aggregator.handleExtraction.bind(aggregator),
      flushIdleOpenSessions: flushSpy
    };

    const { service } = buildService({
      aggregatorOverride,
      now: () => customNow
    });
    await service.recall({
      from: tsAt(-10),
      to: tsAt(100),
      includeSummary: false
    });
    expect(flushSpy.mock.calls[0][0]).toEqual(customNow);
  });
});

// ---------------------------------------------------------------------------
// Robustness — non-UTC timestamps, fractional gaps, missing evidence frames
// ---------------------------------------------------------------------------

describe('DefaultRecallService — robustness', () => {
  it('emits integer totalActiveSeconds even with sub-second frame gaps', async () => {
    // Two frames 250ms apart: a naive `gapMs / 1000` would emit 0.25
    // seconds and violate the schema's `int().nonnegative()` contract.
    // The service must floor the slice to keep the type stable.
    const f1 = makeExtraction(0, { frameId: 1 });
    const f2 = {
      ...makeExtraction(0, { frameId: 2 }),
      frameTimestamp: new Date(Date.parse(f1.frameTimestamp) + 250).toISOString()
    };
    await ingest([f1, f2]);
    const { service } = buildService();

    const result = await service.recall({
      from: tsAt(-10),
      to: tsAt(100),
      granularity: 'hour'
    });
    if (result.granularity !== 'hour') throw new Error('granularity guard');
    // 250ms gap floors to 0s, plus the tail's fixed 1s = 1s.
    expect(result.blocks[0].totalActiveSeconds).toBe(1);
    expect(Number.isInteger(result.blocks[0].totalActiveSeconds)).toBe(true);
    for (const v of Object.values(result.blocks[0].byApp)) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('orders frames by parsed epoch when getByFrameIds returns them out of order', async () => {
    // The store's `getByFrameIds` returns rows in primary-key
    // (frame_id) order, which is NOT necessarily chronological.
    // Setup: frameId=1 at 10:00Z (later) and frameId=2 at 09:00Z
    // (earlier). The default SQLite scan returns [1, 2]; the
    // service must sort by parsed-epoch milliseconds to re-order
    // to [2, 1] before bucketing — otherwise the gap from f1 to
    // f2 is negative, clamps to 0, and the 09:00Z bucket would
    // miss the 3600s-clamped-to-120s gap entirely.
    const f1: ExtractionResult = {
      ...makeExtraction(0, { frameId: 1 }),
      frameTimestamp: '2026-06-01T10:00:00.000Z' // later
    };
    const f2: ExtractionResult = {
      ...makeExtraction(0, { frameId: 2 }),
      frameTimestamp: '2026-06-01T09:00:00.000Z' // earlier
    };
    await extracted.upsert(f1);
    await extracted.upsert(f2);
    // Use the chronologically-earlier frame as the session's
    // `started_at` so listSessions includes it within the recall
    // window (the store filters by `started_at` lexically; 09:00Z
    // is well inside the window we pass).
    await sessions.createSession({ session_id: 'manual-1', ...f2 });
    await sessions.appendFrame('manual-1', f1, { activeSecondsDelta: 0 });

    const { service } = buildService();
    const result = await service.recall({
      from: '2026-06-01T08:00:00.000Z',
      to: '2026-06-01T11:00:00.000Z',
      granularity: 'hour'
    });
    if (result.granularity !== 'hour') throw new Error('granularity guard');

    // Chronologically-sorted: f2 (09:00Z) → gap to f1 = 3600s,
    // clamped to idle threshold 120s in the 09:00Z bucket; f1
    // (10:00Z) is the last frame so it contributes the tail 1s
    // to the 10:00Z bucket.
    const bucket0900 = result.blocks.find((b) =>
      b.start.endsWith('T09:00:00.000Z')
    );
    const bucket1000 = result.blocks.find((b) =>
      b.start.endsWith('T10:00:00.000Z')
    );
    expect(bucket0900?.totalActiveSeconds).toBe(120);
    expect(bucket1000?.totalActiveSeconds).toBe(1);
  });

  it('falls back to 1s per missing frame at the started_at bucket (design §"Failure modes" 5)', async () => {
    // Design §"Failure modes" 5 specifies "缺失帧按 1 秒计入桶，并不
    // 阻断 recall 返回". A session whose evidence_frame_ids reference
    // rows missing from `extracted_content` (cascade-delete race or
    // upstream pruning ahead of the session row) contributes
    // N seconds (one per missing frame) to the bucket containing
    // `started_at`. The session itself stays visible in 'session'
    // mode regardless.
    const ghost: ExtractionResult = makeExtraction(0, { frameId: 999 });
    // Extra evidence frame so we can verify the count is per-frame,
    // not per-session.
    const ghost2: ExtractionResult = makeExtraction(60, { frameId: 1000 });
    // Note: do NOT call `extracted.upsert(ghost*)` — the
    // extracted_content rows are intentionally absent.
    await sessions.createSession({ session_id: 'ghost-session', ...ghost });
    await sessions.appendFrame('ghost-session', ghost2, {
      activeSecondsDelta: 60
    });

    const { service } = buildService();
    const result = await service.recall({
      from: tsAt(-10),
      to: tsAt(200),
      granularity: 'hour'
    });
    if (result.granularity !== 'hour') throw new Error('granularity guard');
    expect(result.blocks).toHaveLength(1);
    // Two missing frames → 2 seconds at the session's started_at
    // bucket. The session is visible (sessionCount === 1) and the
    // recall call did not error out.
    expect(result.blocks[0].sessionCount).toBe(1);
    expect(result.blocks[0].totalActiveSeconds).toBe(2);
    expect(result.blocks[0].byApp).toEqual({ TestApp: 2 });
  });

  it('attributes 1s per partially-missing frame to the started_at bucket', async () => {
    // Partial-loss case: 3 evidence frames, only frame 2 survives.
    // The two missing frames (1 and 3) each contribute 1s to the
    // bucket containing `started_at`. The surviving frame is
    // bucketed normally (tail 1s for a singleton).
    const f1 = makeExtraction(0, { frameId: 1 });
    const f2 = makeExtraction(60, { frameId: 2 });
    const f3 = makeExtraction(120, { frameId: 3 });
    // Only persist f2 to extracted_content; the other two are
    // "missing" from the cascade-delete race perspective.
    await extracted.upsert(f2);
    await sessions.createSession({ session_id: 'partial', ...f1 });
    await sessions.appendFrame('partial', f2, { activeSecondsDelta: 0 });
    await sessions.appendFrame('partial', f3, { activeSecondsDelta: 0 });

    const { service } = buildService();
    const result = await service.recall({
      from: tsAt(-10),
      to: tsAt(200),
      granularity: 'hour'
    });
    if (result.granularity !== 'hour') throw new Error('granularity guard');
    expect(result.blocks).toHaveLength(1);
    // f2 surviving alone contributes 1s tail; the two missing
    // frames contribute 2s at the started_at bucket. Both are the
    // same hour bucket here (all timestamps within seconds of
    // each other), so the total comes out 3s.
    expect(result.blocks[0].totalActiveSeconds).toBe(3);
    expect(result.blocks[0].sessionCount).toBe(1);
  });

  it('does not throw when a frame timestamp is unparseable', async () => {
    // A row with a malformed timestamp must not collapse the entire
    // recall response. The malformed frame is skipped and the
    // remaining frames bucket cleanly.
    const f1 = makeExtraction(0, { frameId: 1 });
    const f2: ExtractionResult = {
      ...makeExtraction(0, { frameId: 2 }),
      frameTimestamp: 'not-a-date'
    };
    const f3 = makeExtraction(60, { frameId: 3 });
    await extracted.upsert(f1);
    await extracted.upsert(f2);
    await extracted.upsert(f3);
    await sessions.createSession({ session_id: 'mixed', ...f1 });
    await sessions.appendFrame('mixed', f2, { activeSecondsDelta: 0 });
    await sessions.appendFrame('mixed', f3, { activeSecondsDelta: 60 });

    const { service } = buildService();
    const result = await service.recall({
      from: tsAt(-10),
      to: tsAt(200),
      granularity: 'hour'
    });
    if (result.granularity !== 'hour') throw new Error('granularity guard');
    expect(result.blocks.length).toBeGreaterThanOrEqual(1);
    // Total active seconds is some non-negative integer; the exact
    // value depends on which frame's gap survives the unparseable
    // timestamp. The contract here is "did not throw" + "produced
    // a sane integer".
    for (const block of result.blocks) {
      expect(Number.isInteger(block.totalActiveSeconds)).toBe(true);
      expect(block.totalActiveSeconds).toBeGreaterThanOrEqual(0);
    }
  });
});
