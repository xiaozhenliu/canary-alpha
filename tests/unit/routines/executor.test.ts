/**
 * Unit tests for DailySummaryExecutor.
 *
 * The executor is deterministic (no LLM calls, ROUT-08) — it formats
 * text from session data returned by the mocked RecallService. Tests
 * cover:
 *  - A non-empty activity window produces a summary with session count
 *    and total active time
 *  - An empty window produces a 'No activity' response
 *  - Narrative text from RecallResult is appended when present
 *  - Summary string accurately reflects session count / time window
 */

import { describe, expect, it } from 'vitest';

import { DailySummaryExecutor } from '../../../src/services/routines/executor.js';
import type { RoutineDefinition } from '../../../src/services/routines/types.js';
import type { RecallResult, RecallService, RecallSessionItem } from '../../../src/services/work-activity/recall/recall-service.js';
import type { FindService } from '../../../src/services/work-activity/find/find-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefinition(overrides: Partial<RoutineDefinition> = {}): RoutineDefinition {
  const now = new Date().toISOString();
  return {
    name: 'daily-summary',
    schedule: '0 9 * * *',
    enabled: true,
    kind: 'daily_summary',
    prompt: 'Summarize the day',
    recentActivityMinutes: 60,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeSessionItem(overrides: Partial<RecallSessionItem> = {}): RecallSessionItem {
  return {
    sessionId: 'session-1',
    appName: 'Code',
    contextLabel: 'editor.ts',
    startedAt: '2026-06-01T08:00:00.000Z',
    endedAt: '2026-06-01T08:30:00.000Z',
    activeSeconds: 1800,
    evidenceFrameIds: ['1', '2'],
    sourceTypes: ['accessibility'],
    ...overrides
  };
}

/**
 * Builds a stub RecallService that always returns the supplied sessions
 * (and optional narrativeText).
 */
function makeRecallService(opts: {
  sessions?: RecallSessionItem[];
  narrativeText?: string;
}): RecallService {
  return {
    async recall(_request): Promise<RecallResult> {
      return {
        granularity: 'session',
        sessions: opts.sessions ?? [],
        narrativeText: opts.narrativeText ?? ''
      };
    }
  };
}

/**
 * Minimal FindService stub — DailySummaryExecutor holds a reference to
 * it but the current implementation only uses RecallService for output.
 */
const stubFindService = {} as FindService;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DailySummaryExecutor — with activity', () => {
  it('produces a success summary referencing session count and activity window', async () => {
    const sessions = [
      makeSessionItem({ sessionId: 'session-1', activeSeconds: 900 }),
      makeSessionItem({ sessionId: 'session-2', appName: 'Chrome', activeSeconds: 300 })
    ];
    const recall = makeRecallService({ sessions });
    const executor = new DailySummaryExecutor({ find: stubFindService, recall });
    const definition = makeDefinition({ recentActivityMinutes: 30 });

    const result = await executor.execute(definition);

    // Summary line should mention 2 sessions and the 30-minute window.
    expect(result.summary).toContain('2 session');
    expect(result.summary).toContain('30m');

    // Output should list each session.
    expect(result.output).toContain('session-1');
    expect(result.output).toContain('session-2');
    expect(result.output).toContain('Code');
    expect(result.output).toContain('Chrome');

    // Output includes total active time (900 + 300 = 1200).
    expect(result.output).toContain('1200s');
  });

  it('includes all session metadata fields in the output', async () => {
    const session = makeSessionItem({
      sessionId: 'sess-abc',
      appName: 'Terminal',
      contextLabel: 'bash',
      startedAt: '2026-06-01T07:00:00.000Z',
      endedAt: '2026-06-01T07:45:00.000Z',
      activeSeconds: 2700
    });
    const recall = makeRecallService({ sessions: [session] });
    const executor = new DailySummaryExecutor({ find: stubFindService, recall });

    const result = await executor.execute(makeDefinition());

    expect(result.output).toContain('sess-abc');
    expect(result.output).toContain('Terminal');
    expect(result.output).toContain('bash');
    expect(result.output).toContain('2026-06-01T07:00:00.000Z');
    expect(result.output).toContain('2026-06-01T07:45:00.000Z');
    expect(result.output).toContain('2700s');
  });

  it('appends narrativeText from RecallResult when present', async () => {
    const recall = makeRecallService({
      sessions: [makeSessionItem()],
      narrativeText: 'You spent most of the morning in Code.'
    });
    const executor = new DailySummaryExecutor({ find: stubFindService, recall });

    const result = await executor.execute(makeDefinition());

    expect(result.output).toContain('Narrative');
    expect(result.output).toContain('You spent most of the morning in Code.');
  });

  it('computes total active time correctly across all sessions', async () => {
    const sessions = [
      makeSessionItem({ sessionId: 's1', activeSeconds: 100 }),
      makeSessionItem({ sessionId: 's2', activeSeconds: 200 }),
      makeSessionItem({ sessionId: 's3', activeSeconds: 300 })
    ];
    const recall = makeRecallService({ sessions });
    const executor = new DailySummaryExecutor({ find: stubFindService, recall });

    const result = await executor.execute(makeDefinition());

    expect(result.output).toContain('600s');
  });
});

// ---------------------------------------------------------------------------

describe('DailySummaryExecutor — empty activity window', () => {
  it('handles empty session list gracefully', async () => {
    const recall = makeRecallService({ sessions: [] });
    const executor = new DailySummaryExecutor({ find: stubFindService, recall });

    const result = await executor.execute(makeDefinition({ recentActivityMinutes: 60 }));

    // Summary indicates no activity.
    expect(result.summary).toContain('No activity');
    expect(result.summary).toContain('60m');

    // Output body should mention the empty state.
    expect(result.output).toContain('No activity');
    expect(result.output).not.toContain('undefined');
  });

  it('does not include session block sections when there are no sessions', async () => {
    const recall = makeRecallService({ sessions: [] });
    const executor = new DailySummaryExecutor({ find: stubFindService, recall });

    const result = await executor.execute(makeDefinition());

    // There should be no "Sessions:" count line (that indicates rows found).
    expect(result.output).not.toContain('Sessions:');
    expect(result.output).not.toContain('Total active time:');
  });

  it('includes routine name and time window metadata even with no sessions', async () => {
    const recall = makeRecallService({ sessions: [] });
    const executor = new DailySummaryExecutor({ find: stubFindService, recall });
    const definition = makeDefinition({ name: 'daily-summary', recentActivityMinutes: 120 });

    const result = await executor.execute(definition);

    expect(result.output).toContain('daily-summary');
    expect(result.output).toContain('120 minutes');
  });
});

// ---------------------------------------------------------------------------

describe('DailySummaryExecutor — output is deterministic', () => {
  it('produces identical output for two calls with the same activity data', async () => {
    const sessions = [
      makeSessionItem({ sessionId: 'sess-x', activeSeconds: 500 })
    ];
    const recall = makeRecallService({ sessions });
    const executor = new DailySummaryExecutor({ find: stubFindService, recall });
    const definition = makeDefinition();

    const r1 = await executor.execute(definition);
    const r2 = await executor.execute(definition);

    // Timestamps in the header will differ between calls, but summary is stable.
    expect(r1.summary).toBe(r2.summary);
    // Session body content is identical.
    expect(r1.output).toContain('sess-x');
    expect(r2.output).toContain('sess-x');
  });
});
