/**
 * `PromptDrivenExecutor` — LLM-backed routine executor for Routines v2.
 *
 * Replaces `DailySummaryExecutor` as the primary execution strategy.
 * The user's `definition.prompt` drives both retrieval (keyword search via
 * `FindService`) and the LLM request. When no LLM is configured or privacy
 * pause is active, the executor falls back to a deterministic template output.
 *
 * Design references:
 *   - Spec: `docs/specs/routines-v2-llm-execution.md` (ROUT-E01 through ROUT-GP02)
 *   - Architecture: `docs/architecture.md` §Routines subsystem
 */

import type { FindService, EvidenceItem } from '../work-activity/find/find-service.js';
import type { RecallService, RecallSessionItem } from '../work-activity/recall/recall-service.js';
import type { LlmClient } from '../llm/llm-client.js';
import type { PrivacyStateReader } from '../privacy/types.js';
import { redactSecrets } from '../work-activity/summary/remote-llm.js';
import type { RoutineDefinition } from './types.js';
import type { RoutineExecutionResult, RoutineExecutor } from './executor.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Optional per-instance configuration overrides for context size limits. */
export interface PromptDrivenExecutorConfig {
  /**
   * Maximum character length of the combined evidence section sent to the LLM.
   * Defaults to 6000. When truncated, "[truncated]" is appended.
   */
  evidenceCharLimit?: number;
  /**
   * Maximum character length of the activity overview section sent to the LLM.
   * Defaults to 2000. When truncated, "[truncated]" is appended.
   */
  activityCharLimit?: number;
}

/** Runtime dependencies injected at construction time. */
export interface PromptDrivenExecutorDependencies {
  find: FindService;
  recall: RecallService;
  /** When absent, all executions fall back to template output (ROUT-E06). */
  llmClient?: LlmClient;
  /** When provided, privacy pause gates evidence sending (ROUT-GP02). */
  privacyState?: PrivacyStateReader;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EVIDENCE_CHAR_LIMIT = 6000;
const DEFAULT_ACTIVITY_CHAR_LIMIT = 2000;

/**
 * LLM model to use when calling the configured endpoint. This value is
 * expected to be injected at construction time if callers pass a pre-built
 * LlmClient; the executor exposes a `model` property for callers that
 * need to pass the model separately.
 *
 * The executor itself does not read `config.llm.model` directly — it
 * receives the model string from the bootstrap layer through
 * `PromptDrivenExecutorDependencies`.
 */
const DEFAULT_MODEL = 'gpt-4o-mini';

const SYSTEM_MESSAGE =
  'You are a work analysis assistant. Based on the following two data sources, answer the user\'s request:\n' +
  '1. Activity overview — session statistics for the time window\n' +
  '2. Relevant evidence — screen text fragments matching the request\n' +
  'Prioritize evidence content; use activity overview for context.\n' +
  'Respond in the same language as the user\'s request.';

// ---------------------------------------------------------------------------
// PromptDrivenExecutor
// ---------------------------------------------------------------------------

/**
 * Prompt-driven routine executor (ROUT-E01).
 *
 * Retrieves activity context and relevant screen evidence for the routine's
 * time window, then calls an LLM to produce a tailored briefing. Falls back
 * to a deterministic template when the LLM is not configured or privacy
 * pause is active.
 */
export class PromptDrivenExecutor implements RoutineExecutor {
  private readonly find: FindService;
  private readonly recall: RecallService;
  private readonly llmClient: LlmClient | undefined;
  private readonly privacyState: PrivacyStateReader | undefined;
  private readonly evidenceCharLimit: number;
  private readonly activityCharLimit: number;
  /** LLM model identifier passed to `LlmClient.complete()`. */
  readonly model: string;

  constructor(
    deps: PromptDrivenExecutorDependencies,
    config: PromptDrivenExecutorConfig = {},
    model: string = DEFAULT_MODEL
  ) {
    this.find = deps.find;
    this.recall = deps.recall;
    this.llmClient = deps.llmClient;
    this.privacyState = deps.privacyState;
    this.evidenceCharLimit = config.evidenceCharLimit ?? DEFAULT_EVIDENCE_CHAR_LIMIT;
    this.activityCharLimit = config.activityCharLimit ?? DEFAULT_ACTIVITY_CHAR_LIMIT;
    this.model = model;
  }

  /**
   * Execute the routine definition and return a structured result.
   *
   * Steps:
   *   1. Compute the look-back time window from `definition.recentActivityMinutes`.
   *   2. Check privacy pause (ROUT-GP02).
   *   3. Retrieve activity overview and evidence in parallel (ROUT-E03).
   *   4. Deduplicate and truncate evidence (ROUT-F05, ROUT-F06).
   *   5. Call LLM with assembled prompt (ROUT-E04).
   *   6. Return structured result (ROUT-E05), or fall back on error (ROUT-E06).
   */
  async execute(definition: RoutineDefinition): Promise<RoutineExecutionResult> {
    // Step 1: compute the time window (ROUT-E02).
    const now = Date.now();
    const fromMs = now - definition.recentActivityMinutes * 60_000;
    const from = new Date(fromMs).toISOString();
    const to = new Date(now).toISOString();

    // Step 2: privacy pause guard (ROUT-GP02).
    // Fail-closed: if we cannot determine privacy state, assume paused
    // to avoid accidentally sending screen evidence to an external endpoint.
    if (this.privacyState !== undefined) {
      let paused = true;
      try {
        const state = await this.privacyState.read();
        paused = state.paused;
      } catch {
        // Cannot read privacy state — fail closed.
      }
      if (paused) {
        return this.templateFallback(
          definition,
          from,
          to,
          'Privacy pause is active — screen evidence not sent to external endpoint.'
        );
      }
    }

    // Step 3: parallel retrieval (ROUT-E03).
    const [recallResult, findResult] = await Promise.all([
      this.recall.recall({
        from,
        to,
        granularity: 'session',
        includeSummary: true
      }),
      this.find.find({
        query: definition.prompt,
        from,
        to,
        mode: 'keyword',
        limit: 200
      })
    ]);

    // Extract sessions from recall result (granularity is always 'session' here).
    const sessions: RecallSessionItem[] =
      recallResult.granularity === 'session' ? recallResult.sessions : [];

    // Step 4a: check LLM availability (ROUT-E06).
    if (this.llmClient == null) {
      return this.templateFallbackWithData(
        definition,
        from,
        to,
        'LLM not configured — using template fallback.',
        sessions,
        findResult.data
      );
    }

    // Step 4b: deduplicate evidence by extractedText (ROUT-F05).
    const seenTexts = new Set<string>();
    const dedupedEvidence: EvidenceItem[] = [];
    for (const item of findResult.data) {
      if (!seenTexts.has(item.extractedText)) {
        seenTexts.add(item.extractedText);
        dedupedEvidence.push(item);
      }
    }

    // Step 4c: apply secret redaction to all evidence text (ROUT-GP01).
    const redactedEvidence = dedupedEvidence.map((item) => ({
      ...item,
      extractedText: redactSecrets(item.extractedText)
    }));

    // Step 4d: assemble and truncate context sections (ROUT-F06).
    const activityText = this.buildActivityOverview(sessions);
    const evidenceText = this.buildEvidenceText(redactedEvidence);

    const { text: truncatedActivity, truncated: activityTruncated } =
      truncateText(activityText, this.activityCharLimit);
    const { text: truncatedEvidence, truncated: evidenceTruncated } =
      truncateText(evidenceText, this.evidenceCharLimit);

    const finalActivity = activityTruncated
      ? truncatedActivity + '[truncated]'
      : truncatedActivity;
    const finalEvidence = evidenceTruncated
      ? truncatedEvidence + '[truncated]'
      : truncatedEvidence;

    // Step 5: assemble LLM user message (ROUT-E04).
    const userMessage =
      `Request: ${definition.prompt}\n` +
      `Time window: ${from} to ${to}\n\n` +
      `=== Activity Overview (${sessions.length} sessions) ===\n` +
      finalActivity +
      `\n\n=== Relevant Evidence (${redactedEvidence.length} items) ===\n` +
      finalEvidence;

    // Step 6: call the LLM (ROUT-E04).
    const llmResult = await this.llmClient.complete({
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_MESSAGE },
        { role: 'user', content: userMessage }
      ]
    });

    // Step 7: handle LLM error (ROUT-E06).
    if (llmResult.kind === 'error') {
      return this.templateFallbackWithData(
        definition,
        from,
        to,
        `LLM error (${llmResult.error.code}): ${llmResult.error.message}`,
        sessions,
        findResult.data
      );
    }

    // Step 8: build the success result (ROUT-E05).
    const fullResponse = llmResult.text;

    // Summary: first line of LLM response, capped at 200 characters.
    const firstLine = fullResponse.split('\n')[0] ?? fullResponse;
    const summary = firstLine.length > 200 ? firstLine.slice(0, 200) : firstLine;

    // Output: full LLM response, with optional degraded marker (ROUT-F07).
    let output = fullResponse;
    if (findResult.degraded !== undefined) {
      output += `\n[degraded: ${findResult.degraded.reason}]`;
    }

    return { summary, output };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Produce a deterministic template fallback result (ROUT-E06).
   * Used when privacy pause is active (no data retrieved yet).
   */
  private templateFallback(
    definition: RoutineDefinition,
    from: string,
    to: string,
    reason: string
  ): RoutineExecutionResult {
    return {
      summary: `[template] ${reason}`,
      output:
        `Routine: ${definition.name}\n` +
        `Prompt: ${definition.prompt}\n` +
        `Window: ${from} to ${to} (${definition.recentActivityMinutes} minutes)\n` +
        `Mode: template fallback\n` +
        `Reason: ${reason}`
    };
  }

  /**
   * Template fallback that includes retrieved session and evidence data so
   * no-LLM installs still produce useful output.
   */
  private templateFallbackWithData(
    definition: RoutineDefinition,
    from: string,
    to: string,
    reason: string,
    sessions: RecallSessionItem[],
    evidence: EvidenceItem[]
  ): RoutineExecutionResult {
    const lines = [
      `Routine: ${definition.name}`,
      `Prompt: ${definition.prompt}`,
      `Window: ${from} to ${to} (${definition.recentActivityMinutes} minutes)`,
      `Mode: template fallback`,
      `Reason: ${reason}`,
      ''
    ];

    if (sessions.length > 0) {
      lines.push(`Sessions: ${sessions.length}`);
      for (const s of sessions) {
        lines.push(`  [${s.startedAt}] ${s.appName} — ${redactSecrets(s.contextLabel)} (${s.activeSeconds}s)`);
      }
      const totalActive = sessions.reduce((sum, s) => sum + (s.activeSeconds ?? 0), 0);
      lines.push(`Total active time: ${totalActive}s`);
    } else {
      lines.push('No activity recorded in this window.');
    }

    if (evidence.length > 0) {
      lines.push('', `Evidence: ${evidence.length} item(s)`);
      const shown = evidence.slice(0, 10);
      for (const item of shown) {
        lines.push(`  [${item.timestamp}] ${item.appName ?? 'unknown'}: ${redactSecrets(item.extractedText).slice(0, 120)}`);
      }
      if (evidence.length > 10) {
        lines.push(`  ... and ${evidence.length - 10} more item(s)`);
      }
    }

    const output = lines.join('\n');
    const summary = sessions.length > 0
      ? `[template] ${sessions.length} session(s) in last ${definition.recentActivityMinutes}m — ${reason}`
      : `[template] ${reason}`;

    return { summary, output };
  }

  /**
   * Format the activity overview section from a list of recall sessions.
   * Each line follows the pattern:
   *   "[{startedAt}] {appName} — {contextLabel} ({activeSeconds}s)"
   * with an optional " | Summary: {text}" suffix when a session summary exists.
   */
  private buildActivityOverview(sessions: RecallSessionItem[]): string {
    if (sessions.length === 0) return '(no sessions in time window)';
    return sessions
      .map((s) => {
        let line =
          `[${s.startedAt}] ${s.appName} — ${redactSecrets(s.contextLabel)} (${s.activeSeconds}s)`;
        if (s.summary !== undefined && s.summary.text.length > 0) {
          line += ` | Summary: ${redactSecrets(s.summary.text)}`;
        }
        return line;
      })
      .join('\n');
  }

  /**
   * Format the evidence section from a list of (already-deduped, already-redacted)
   * evidence items. Each line follows the pattern:
   *   "[{timestamp}] {appName}: {extractedText}"
   */
  private buildEvidenceText(evidence: EvidenceItem[]): string {
    if (evidence.length === 0) return '(no evidence found)';
    return evidence
      .map((item) => `[${item.timestamp}] ${item.appName ?? 'unknown'}: ${item.extractedText}`)
      .join('\n');
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Truncate `text` to at most `limit` characters.
 * Returns the (possibly shortened) text and a boolean flag indicating
 * whether truncation occurred. The caller is responsible for appending
 * a "[truncated]" marker.
 */
function truncateText(
  text: string,
  limit: number
): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, limit), truncated: true };
}
