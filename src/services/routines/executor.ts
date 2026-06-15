/**
 * RoutineExecutor — interface and built-in implementations.
 *
 * Each executor receives a RoutineDefinition and produces a structured result
 * containing a short human-readable summary and a longer output body.
 *
 * ROUT-08: daily_summary must be deterministic — no LLM calls allowed.
 */

import type { FindService } from '../work-activity/find/find-service.js';
import type { RecallService, RecallSessionItem } from '../work-activity/recall/recall-service.js';
import type { RoutineDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface RoutineExecutionResult {
  summary: string;
  output: string;
}

export interface RoutineExecutor {
  execute(definition: RoutineDefinition): Promise<RoutineExecutionResult>;
}

// ---------------------------------------------------------------------------
// DailySummaryExecutor — deterministic text formatter, no LLM
// ---------------------------------------------------------------------------

/**
 * Formats a daily activity summary using recent work-activity data.
 *
 * Queries recall for sessions within `definition.recentActivityMinutes`
 * and formats the result as structured text without any LLM call.
 */
export class DailySummaryExecutor implements RoutineExecutor {
  constructor(
    private readonly services: {
      find: FindService;
      recall: RecallService;
    }
  ) {}

  async execute(definition: RoutineDefinition): Promise<RoutineExecutionResult> {
    const now = new Date();
    const fromDate = new Date(now.getTime() - definition.recentActivityMinutes * 60 * 1_000);

    const from = fromDate.toISOString();
    const to = now.toISOString();

    // Fetch sessions within the requested time window.
    const recallResult = await this.services.recall.recall({
      from,
      to,
      granularity: 'session',
      includeSummary: false
    });

    // RecallResult is a discriminated union; narrow to the 'session' branch.
    const sessionItems: RecallSessionItem[] =
      recallResult.granularity === 'session' ? recallResult.sessions : [];

    // Build deterministic text output.
    const lines: string[] = [
      `Daily Summary — ${now.toISOString()}`,
      `Window: ${from} to ${to} (${definition.recentActivityMinutes} minutes)`,
      `Routine: ${definition.name}`,
      ''
    ];

    if (sessionItems.length === 0) {
      lines.push('No activity recorded in this window.');
    } else {
      lines.push(`Sessions: ${sessionItems.length}`);
      lines.push('');

      for (const session of sessionItems) {
        lines.push(`  Session ${session.sessionId}`);
        lines.push(`    App:     ${session.appName || 'unknown'}`);
        lines.push(`    Context: ${session.contextLabel}`);
        lines.push(`    Started: ${session.startedAt}`);
        lines.push(`    Ended:   ${session.endedAt}`);
        lines.push(`    Active:  ${session.activeSeconds}s`);
        lines.push('');
      }

      // Compute total active time across all sessions.
      const totalActiveSeconds = sessionItems.reduce(
        (sum, s) => sum + (s.activeSeconds ?? 0),
        0
      );
      lines.push(`Total active time: ${totalActiveSeconds}s`);
    }

    if (recallResult.narrativeText) {
      lines.push('');
      lines.push('--- Narrative ---');
      lines.push(recallResult.narrativeText);
    }

    const output = lines.join('\n');
    const summary = sessionItems.length > 0
      ? `${sessionItems.length} session(s) in last ${definition.recentActivityMinutes}m`
      : `No activity in last ${definition.recentActivityMinutes}m`;

    return { summary, output };
  }
}
