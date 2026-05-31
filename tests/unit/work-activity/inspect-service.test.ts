/**
 * Unit tests for `DefaultInspectService` (work-activity-analysis
 * task 8.5).
 *
 * The inspect service has two distinct code paths gated on the
 * `target.kind` discriminator. The tests cover both end-to-end
 * against fresh in-memory derived databases plus an in-memory
 * stub for the upstream {@link ScreenpipeFramesReader}, asserting
 * that:
 *
 *   - `target.kind='session'` returns the session row, the per-frame
 *     evidence (in input order), and a SummaryWorker-materialised
 *     summary block (`status: 'ready'`, `providerKind: 'template'`).
 *   - `target.kind='session'` for a missing session collapses to
 *     `session: null`, an empty evidence array, and a friendly
 *     narrative (W20 / R7.15 — narrativeText is always present).
 *   - `target.kind='frame'` returns the five-column ScreenPipe
 *     projection plus the derived extraction record, and the
 *     narrative carries the extraction rule kind.
 *   - `target.kind='frame'` for a missing frame returns `frame:
 *     null`, `extractedContent: null`, and a friendly narrative.
 *   - The frame path also handles the "ScreenPipe row missing,
 *     derived row present" mid-cascade-delete state by surfacing
 *     the documented "原始 AX 树不可访问" narrative.
 *   - W20 holds: every path returns a non-null `narrativeText`
 *     string (empty allowed but stringly typed and always present).
 *
 * **Validates: Requirements 7.12, 7.13, 7.14, 7.15**
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  initDerivedSchema,
  openDerivedDatabase,
  type DerivedDatabase
} from '../../../src/services/work-activity/derived-database.js';
import { SqliteExtractedContentStore } from '../../../src/services/work-activity/extraction/extracted-content-store.js';
import {
  DefaultInspectService,
  type InspectFrameResult,
  type InspectSessionResult
} from '../../../src/services/work-activity/inspect/inspect-service.js';
import type {
  ScreenpipeFrameRow,
  ScreenpipeFramesReader
} from '../../../src/services/work-activity/inspect/screenpipe-frames-reader.js';
import { SqliteSessionStore } from '../../../src/services/work-activity/sessions/session-store.js';
import { TemplateSummaryProvider } from '../../../src/services/work-activity/summary/template.js';
import { SummaryProviderRegistry } from '../../../src/services/work-activity/summary/registry.js';
import { SummaryWorker } from '../../../src/services/work-activity/summary/worker.js';
import type { PrivacyStateReader } from '../../../src/services/privacy/types.js';
import type { ExtractionResult } from '../../../src/services/work-activity/extraction/types.js';

// ---------------------------------------------------------------------------
// Per-test fixture
// ---------------------------------------------------------------------------

let db: DerivedDatabase;
let extracted: SqliteExtractedContentStore;
let sessions: SqliteSessionStore;
let framesReader: StubScreenpipeFramesReader;
let summaryWorker: SummaryWorker;
let service: DefaultInspectService;

beforeEach(() => {
  db = openDerivedDatabase(':memory:');
  initDerivedSchema(db);
  extracted = new SqliteExtractedContentStore(db);
  sessions = new SqliteSessionStore(db);
  framesReader = new StubScreenpipeFramesReader();

  const registry = new SummaryProviderRegistry(new TemplateSummaryProvider());
  // Privacy reader stub: always "not paused" so the worker uses
  // the active provider (template). The inspect tests do not
  // exercise the W27 paused path — that property is owned by the
  // SummaryWorker / Registry tests.
  const privacyState: PrivacyStateReader = {
    read: async () => ({ paused: false, excludedApps: [] })
  };

  summaryWorker = new SummaryWorker({
    registry,
    sessionStore: sessions,
    extractedContentStore: extracted,
    privacyState,
    now: () => new Date('2026-05-25T11:00:00.000Z')
  });
  service = new DefaultInspectService({
    sessionStore: sessions,
    extractedContentStore: extracted,
    summaryWorker,
    screenpipeFramesReader: framesReader,
    now: () => new Date('2026-05-25T11:00:00.000Z')
  });
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    frameId: 1,
    frameTimestamp: tsAt(0),
    appName: 'Code',
    contextLabel: 'project — main.ts',
    contextKey: 'code::project — main.ts',
    extractedText: 'function add(a, b) { return a + b; }',
    extractedTextHash:
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    extractionRuleKind: 'generic',
    sourceTypes: ['accessibility'],
    ...overrides
  };
}

async function attachSession(
  sessionId: string,
  frames: ExtractionResult[]
): Promise<void> {
  if (frames.length === 0) return;
  await sessions.createSession({ session_id: sessionId, ...frames[0] });
  for (let i = 1; i < frames.length; i++) {
    await sessions.appendFrame(sessionId, frames[i], { activeSecondsDelta: 1 });
  }
}

function tsAt(secondsAfterEpoch: number): string {
  const base = Date.UTC(2026, 4, 25, 10, 0, 0);
  return new Date(base + secondsAfterEpoch * 1000).toISOString();
}

/**
 * In-memory `ScreenpipeFramesReader` stub. Tests register frame rows
 * indexed by ID; missing IDs return `null` (matching the production
 * adapter's "frame not found / ScreenPipe DB unavailable" semantics).
 */
class StubScreenpipeFramesReader implements ScreenpipeFramesReader {
  private readonly rows = new Map<number, ScreenpipeFrameRow>();

  setRow(row: ScreenpipeFrameRow): void {
    this.rows.set(row.id, row);
  }

  reset(): void {
    this.rows.clear();
  }

  async getFrame(frameId: number | string): Promise<ScreenpipeFrameRow | null> {
    const key = typeof frameId === 'number' ? frameId : Number(frameId);
    if (!Number.isFinite(key)) return null;
    return this.rows.get(key) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Session path
// ---------------------------------------------------------------------------

describe('DefaultInspectService.inspect — target.kind="session"', () => {
  it('returns the session row, evidence, and SummaryWorker-materialised summary', async () => {
    const f1 = makeExtraction({
      frameId: 11,
      frameTimestamp: tsAt(0),
      extractedText: 'first frame text'
    });
    const f2 = makeExtraction({
      frameId: 12,
      frameTimestamp: tsAt(30),
      extractedText: 'second frame text'
    });
    await extracted.upsert(f1);
    await extracted.upsert(f2);
    await attachSession('sess-1', [f1, f2]);

    const result = (await service.inspect({
      kind: 'session',
      sessionId: 'sess-1'
    })) as InspectSessionResult;

    expect(result.kind).toBe('session');
    expect(result.session).not.toBeNull();
    expect(result.session?.sessionId).toBe('sess-1');
    expect(result.session?.appName).toBe('Code');
    expect(result.session?.contextLabel).toBe('project — main.ts');
    expect(result.session?.evidenceFrameIds).toEqual([11, 12]);

    // Evidence comes back in input order (matching evidenceFrameIds).
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.map((e) => e.frameId)).toEqual([11, 12]);
    // Each evidence item carries the parent sessionId.
    expect(result.evidence.every((e) => e.sessionId === 'sess-1')).toBe(true);
    expect(result.evidence[0].extractedText).toBe('first frame text');
    expect(result.evidence[1].extractedText).toBe('second frame text');

    // Summary block was materialised by the worker (template provider,
    // ready status). The exact text is owned by TemplateSummaryProvider
    // tests; here we just assert the shape.
    expect(result.session?.summary).toBeDefined();
    expect(result.session?.summary?.status).toBe('ready');
    expect(result.session?.summary?.providerKind).toBe('template');
    expect(result.session?.summary?.text.length).toBeGreaterThan(0);

    // narrativeText starts with the session header template, plus
    // a trailing summary line.
    expect(result.narrativeText).toContain('会话 Code | project — main.ts');
    expect(result.narrativeText).toContain('2 帧');
  });

  it('returns session=null with a friendly narrative when sessionId is unknown (W20)', async () => {
    const result = (await service.inspect({
      kind: 'session',
      sessionId: 'does-not-exist'
    })) as InspectSessionResult;

    expect(result.kind).toBe('session');
    expect(result.session).toBeNull();
    expect(result.evidence).toEqual([]);
    // W20 / R7.15: narrativeText is always present and stringly typed.
    expect(typeof result.narrativeText).toBe('string');
    expect(result.narrativeText).toContain('does-not-exist');
  });

  it('drops evidence frames whose extracted_content rows have been cascade-deleted', async () => {
    // Simulate a partial-failure window: the session row references
    // three frames but only two have surviving extracted_content
    // rows. The service should skip the missing one rather than
    // throwing.
    const f1 = makeExtraction({ frameId: 21, frameTimestamp: tsAt(0) });
    const f2 = makeExtraction({ frameId: 22, frameTimestamp: tsAt(10) });
    const f3 = makeExtraction({ frameId: 23, frameTimestamp: tsAt(20) });
    await extracted.upsert(f1);
    await extracted.upsert(f3); // f2 is intentionally missing
    await attachSession('sess-2', [f1, f2, f3]);

    const result = (await service.inspect({
      kind: 'session',
      sessionId: 'sess-2'
    })) as InspectSessionResult;

    expect(result.evidence.map((e) => e.frameId)).toEqual([21, 23]);
    // The evidenceFrameIds in the session row still mentions all
    // three IDs; the service exposes the persisted state verbatim so
    // observability can detect the discrepancy.
    expect(result.session?.evidenceFrameIds).toEqual([21, 22, 23]);
  });
});

// ---------------------------------------------------------------------------
// Frame path
// ---------------------------------------------------------------------------

describe('DefaultInspectService.inspect — target.kind="frame"', () => {
  it('returns the ScreenPipe row + derived extraction + rule-aware narrative', async () => {
    const e = makeExtraction({
      frameId: 101,
      frameTimestamp: tsAt(5),
      extractionRuleKind: 'terminal',
      extractedText: 'cd ~/projects && ls'
    });
    await extracted.upsert(e);
    framesReader.setRow({
      id: 101,
      timestamp: tsAt(5),
      appName: 'iTerm2',
      windowName: 'zsh — ~/projects',
      accessibilityTreeJson: '{"AXRole":"AXTextArea"}'
    });

    const result = (await service.inspect({
      kind: 'frame',
      frameId: 101
    })) as InspectFrameResult;

    expect(result.kind).toBe('frame');
    expect(result.frame).not.toBeNull();
    expect(result.frame?.frameId).toBe(101);
    expect(result.frame?.appName).toBe('iTerm2');
    expect(result.frame?.windowName).toBe('zsh — ~/projects');
    expect(result.frame?.accessibilityTreeJson).toBe('{"AXRole":"AXTextArea"}');

    expect(result.extractedContent).not.toBeNull();
    expect(result.extractedContent?.frameId).toBe(101);
    expect(result.extractedContent?.extractedText).toBe('cd ~/projects && ls');

    // W20 / R7.15: narrativeText present and string. Includes the
    // rule kind so callers can tell which extractor produced the row.
    expect(typeof result.narrativeText).toBe('string');
    expect(result.narrativeText).toContain('帧 101');
    expect(result.narrativeText).toContain('iTerm2');
    expect(result.narrativeText).toContain('terminal');
  });

  it('returns a frame projection with accessibilityTreeJson=null when ScreenPipe nulled the row', async () => {
    framesReader.setRow({
      id: 202,
      timestamp: tsAt(0),
      appName: 'Chrome',
      windowName: 'Pricing — Stripe',
      // ScreenPipe's trim service nulls this column once elements
      // have been extracted. The inspect tool MUST surface the null
      // verbatim so the operator can tell why a frame has no AX
      // tree available.
      accessibilityTreeJson: null
    });

    const result = (await service.inspect({
      kind: 'frame',
      frameId: 202
    })) as InspectFrameResult;

    expect(result.frame?.accessibilityTreeJson).toBeNull();
    // No derived row → extractedContent stays null too.
    expect(result.extractedContent).toBeNull();
  });

  it('returns frame=null and extractedContent=null when neither store has the frame (W20)', async () => {
    const result = (await service.inspect({
      kind: 'frame',
      frameId: 999
    })) as InspectFrameResult;

    expect(result.kind).toBe('frame');
    expect(result.frame).toBeNull();
    expect(result.extractedContent).toBeNull();
    expect(typeof result.narrativeText).toBe('string');
    expect(result.narrativeText).toContain('999');
  });

  it('surfaces the documented "原始 AX 树不可访问" narrative when only the derived row survives', async () => {
    // Cascade-delete race condition: ScreenPipe's `frames` row was
    // retention-trimmed but the derived `extracted_content` row has
    // not yet been GC'd. The tool should still return the derived
    // row plus the documented degraded narrative (design §"Failure
    // modes").
    const e = makeExtraction({
      frameId: 333,
      frameTimestamp: tsAt(0),
      extractionRuleKind: 'generic'
    });
    await extracted.upsert(e);
    // No corresponding row in framesReader.

    const result = (await service.inspect({
      kind: 'frame',
      frameId: 333
    })) as InspectFrameResult;

    expect(result.frame).toBeNull();
    expect(result.extractedContent).not.toBeNull();
    expect(result.extractedContent?.frameId).toBe(333);
    expect(result.narrativeText).toContain('原始 AX 树不可访问');
    expect(result.narrativeText).toContain('generic');
  });

  it('accepts a string frameId and round-trips it on the response shape', async () => {
    framesReader.setRow({
      id: 404,
      timestamp: tsAt(0),
      appName: 'Code',
      windowName: 'main.ts',
      accessibilityTreeJson: '{}'
    });

    const result = (await service.inspect({
      kind: 'frame',
      frameId: '404'
    })) as InspectFrameResult;

    expect(result.frame).not.toBeNull();
    // String input round-trips as a string; the underlying
    // ScreenPipe column is INTEGER but the tool surface preserves
    // the caller's type so a JSON deserialiser receives what it
    // sent.
    expect(result.frame?.frameId).toBe('404');
    expect(result.frame?.timestamp).toBe(tsAt(0));
  });

  it('returns frame=null + extractedContent=null for a non-numeric string frameId (W20)', async () => {
    const result = (await service.inspect({
      kind: 'frame',
      frameId: 'not-a-number'
    })) as InspectFrameResult;

    expect(result.frame).toBeNull();
    expect(result.extractedContent).toBeNull();
    expect(typeof result.narrativeText).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// W20 — narrativeText always present
// ---------------------------------------------------------------------------

describe('DefaultInspectService.inspect — narrativeText (W20 / R7.15)', () => {
  it('returns a string narrativeText for every documented branch', async () => {
    // 1. Session present.
    const f = makeExtraction({ frameId: 1 });
    await extracted.upsert(f);
    await attachSession('s-1', [f]);
    const r1 = await service.inspect({ kind: 'session', sessionId: 's-1' });
    expect(typeof r1.narrativeText).toBe('string');
    expect(r1.narrativeText.length).toBeGreaterThan(0);

    // 2. Session missing.
    const r2 = await service.inspect({ kind: 'session', sessionId: 'missing' });
    expect(typeof r2.narrativeText).toBe('string');
    expect(r2.narrativeText.length).toBeGreaterThan(0);

    // 3. Frame present (ScreenPipe + derived).
    framesReader.setRow({
      id: 1,
      timestamp: tsAt(0),
      appName: 'Code',
      windowName: 'main.ts',
      accessibilityTreeJson: '{}'
    });
    const r3 = await service.inspect({ kind: 'frame', frameId: 1 });
    expect(typeof r3.narrativeText).toBe('string');
    expect(r3.narrativeText.length).toBeGreaterThan(0);

    // 4. Frame missing both stores.
    const r4 = await service.inspect({ kind: 'frame', frameId: 9999 });
    expect(typeof r4.narrativeText).toBe('string');
    expect(r4.narrativeText.length).toBeGreaterThan(0);

    // 5. Derived only (ScreenPipe row missing).
    const e2 = makeExtraction({ frameId: 555 });
    await extracted.upsert(e2);
    const r5 = await service.inspect({ kind: 'frame', frameId: 555 });
    expect(typeof r5.narrativeText).toBe('string');
    expect(r5.narrativeText.length).toBeGreaterThan(0);
  });
});
