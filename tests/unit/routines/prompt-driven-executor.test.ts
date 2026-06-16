/**
 * Unit tests for PromptDrivenExecutor (Routines v2).
 *
 * Coverage:
 *   AC #1  — LLM execution path: complete() is called with prompt + evidence
 *   AC #2  — Prompt differentiation: distinct definitions → distinct user messages
 *   AC #3  — LLM fallback when not configured
 *   AC #4  — Evidence deduplication (identical extractedText collapsed to one)
 *   AC #5  — Context truncation with evidenceCharLimit
 *   AC #13 — Secret redaction before LLM call
 *   AC #14 — Privacy pause guard skips LLM
 *   AC #15 — Degraded marker appended to output
 */

import { describe, it, expect, vi } from 'vitest';

import {
  PromptDrivenExecutor,
  type PromptDrivenExecutorConfig,
  type PromptDrivenExecutorDependencies
} from '../../../src/services/routines/prompt-driven-executor.js';
import type { RoutineDefinition } from '../../../src/services/routines/types.js';
import type { FindService, FindResult, EvidenceItem } from '../../../src/services/work-activity/find/find-service.js';
import type { RecallService, RecallResult, RecallSessionItem } from '../../../src/services/work-activity/recall/recall-service.js';
import type { LlmClient, LlmResult } from '../../../src/services/llm/llm-client.js';
import type { PrivacyStateReader, PrivacyState } from '../../../src/services/privacy/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefinition(overrides: Partial<RoutineDefinition> = {}): RoutineDefinition {
  const now = new Date().toISOString();
  return {
    name: 'test-routine',
    schedule: '0 9 * * *',
    enabled: true,
    prompt: 'What did I work on today?',
    recentActivityMinutes: 60,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeEvidenceItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    frameId: 1,
    contextLabel: 'work',
    extractedText: 'some screen content',
    timestamp: new Date().toISOString(),
    matchSource: 'keyword',
    sourceTypes: ['ocr'],
    appName: 'TestApp',
    ...overrides
  };
}

function makeSession(overrides: Partial<RecallSessionItem> = {}): RecallSessionItem {
  return {
    sessionId: 'session-1',
    appName: 'TestApp',
    contextLabel: 'work',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    activeSeconds: 300,
    evidenceFrameIds: ['1'],
    sourceTypes: ['ocr'],
    ...overrides
  };
}

function makeFindResult(items: EvidenceItem[] = [], degraded?: FindResult['degraded']): FindResult {
  return {
    data: items,
    narrativeText: `Found ${items.length} items.`,
    ...(degraded !== undefined ? { degraded } : {})
  };
}

function makeRecallResult(sessions: RecallSessionItem[] = []): RecallResult {
  return {
    granularity: 'session',
    sessions,
    narrativeText: `Found ${sessions.length} sessions.`
  };
}

/**
 * Build a PromptDrivenExecutor with fully mocked dependencies.
 * All mock return values can be overridden per-test.
 */
function makeExecutor(opts: {
  findResult?: FindResult;
  recallResult?: RecallResult;
  llmResult?: LlmResult;
  privacyState?: PrivacyState;
  config?: PromptDrivenExecutorConfig;
  model?: string;
  omitLlm?: boolean;
  omitPrivacy?: boolean;
}) {
  const findMock = vi.fn<FindService['find']>();
  findMock.mockResolvedValue(opts.findResult ?? makeFindResult([makeEvidenceItem()]));

  const recallMock = vi.fn<RecallService['recall']>();
  recallMock.mockResolvedValue(opts.recallResult ?? makeRecallResult([makeSession()]));

  const completeMock = vi.fn<LlmClient['complete']>();
  completeMock.mockResolvedValue(
    opts.llmResult ?? { kind: 'ok' as const, text: 'LLM response', latencyMs: 100 }
  );

  const llmClient: LlmClient = { complete: completeMock };

  const privacyReadMock = vi.fn<PrivacyStateReader['read']>();
  privacyReadMock.mockResolvedValue(
    opts.privacyState ?? { paused: false, excludedApps: [] }
  );
  const privacyState: PrivacyStateReader = { read: privacyReadMock };

  const deps: PromptDrivenExecutorDependencies = {
    find: { find: findMock },
    recall: { recall: recallMock },
    ...(opts.omitLlm ? {} : { llmClient }),
    ...(opts.omitPrivacy ? {} : { privacyState })
  };

  const executor = new PromptDrivenExecutor(deps, opts.config, opts.model);

  return { executor, findMock, recallMock, completeMock, privacyReadMock };
}

// ---------------------------------------------------------------------------
// AC #1 — LLM execution path
// ---------------------------------------------------------------------------

describe('PromptDrivenExecutor — AC #1: LLM execution path', () => {
  it('calls llmClient.complete once and includes prompt, activity, and evidence in user message', async () => {
    const definition = makeDefinition({ prompt: 'Review my coding session' });

    const session = makeSession({ appName: 'VSCode', contextLabel: 'coding' });
    const evidence1 = makeEvidenceItem({ frameId: 1, extractedText: 'function foo() {}', appName: 'VSCode' });
    const evidence2 = makeEvidenceItem({ frameId: 2, extractedText: 'const bar = 42;', appName: 'VSCode' });

    const { executor, completeMock } = makeExecutor({
      findResult: makeFindResult([evidence1, evidence2]),
      recallResult: makeRecallResult([session]),
      llmResult: { kind: 'ok', text: 'LLM response', latencyMs: 100 }
    });

    const result = await executor.execute(definition);

    // complete() called exactly once
    expect(completeMock).toHaveBeenCalledTimes(1);

    const callArgs = completeMock.mock.calls[0][0];
    const userMessage = callArgs.messages[1].content;

    // User message contains the definition's prompt text
    expect(userMessage).toContain('Review my coding session');

    // User message contains session data (activity overview)
    expect(userMessage).toContain('VSCode');
    expect(userMessage).toContain('coding');

    // User message contains evidence text
    expect(userMessage).toContain('function foo() {}');
    expect(userMessage).toContain('const bar = 42;');

    // Result is the LLM response
    expect(result.summary).toBe('LLM response');
    expect(result.output).toBe('LLM response');
  });
});

// ---------------------------------------------------------------------------
// AC #2 — Prompt differentiation
// ---------------------------------------------------------------------------

describe('PromptDrivenExecutor — AC #2: Prompt differentiation', () => {
  it('produces different user messages for definitions with different prompts', async () => {
    const def1 = makeDefinition({ prompt: 'What meetings did I have?' });
    const def2 = makeDefinition({ prompt: 'What code did I write?' });

    const { executor, completeMock } = makeExecutor({});

    await executor.execute(def1);
    await executor.execute(def2);

    expect(completeMock).toHaveBeenCalledTimes(2);

    const userMessage1 = completeMock.mock.calls[0][0].messages[1].content;
    const userMessage2 = completeMock.mock.calls[1][0].messages[1].content;

    expect(userMessage1).not.toBe(userMessage2);
    expect(userMessage1).toContain('What meetings did I have?');
    expect(userMessage2).toContain('What code did I write?');
  });
});

// ---------------------------------------------------------------------------
// AC #3 — LLM fallback when not configured
// ---------------------------------------------------------------------------

describe('PromptDrivenExecutor — AC #3: LLM fallback when not configured', () => {
  it('returns template fallback when llmClient is not provided', async () => {
    const definition = makeDefinition();

    const { executor, completeMock } = makeExecutor({ omitLlm: true });

    const result = await executor.execute(definition);

    // summary starts with '[template]'
    expect(result.summary).toMatch(/^\[template\]/);

    // output contains 'LLM not configured'
    expect(result.output).toContain('LLM not configured');

    // LLM complete was never invoked
    expect(completeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC #4 — Evidence deduplication
// ---------------------------------------------------------------------------

describe('PromptDrivenExecutor — AC #4: Evidence deduplication', () => {
  it('collapses 100 identical evidence items to one occurrence in the LLM user message', async () => {
    const definition = makeDefinition();

    // 100 items all with identical extractedText
    const items: EvidenceItem[] = Array.from({ length: 100 }, (_, i) =>
      makeEvidenceItem({ frameId: i + 1, extractedText: 'same content' })
    );

    const { executor, completeMock } = makeExecutor({
      findResult: makeFindResult(items)
    });

    await executor.execute(definition);

    expect(completeMock).toHaveBeenCalledTimes(1);

    const userMessage = completeMock.mock.calls[0][0].messages[1].content;

    // Count occurrences of 'same content' in the user message
    const matches = userMessage.match(/same content/g) ?? [];

    // Deduplicated: only one copy should appear
    expect(matches.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC #5 — Context truncation
// ---------------------------------------------------------------------------

describe('PromptDrivenExecutor — AC #5: Context truncation', () => {
  it('appends [truncated] to user message when evidence exceeds evidenceCharLimit', async () => {
    const definition = makeDefinition();

    // Evidence text is long enough to exceed a very small limit
    const longText = 'A'.repeat(100);
    const items: EvidenceItem[] = [
      makeEvidenceItem({ frameId: 1, extractedText: longText })
    ];

    const { executor, completeMock } = makeExecutor({
      findResult: makeFindResult(items),
      config: { evidenceCharLimit: 50 }
    });

    await executor.execute(definition);

    expect(completeMock).toHaveBeenCalledTimes(1);

    const userMessage = completeMock.mock.calls[0][0].messages[1].content;

    expect(userMessage).toContain('[truncated]');
  });
});

// ---------------------------------------------------------------------------
// AC #15 — Degraded marker
// ---------------------------------------------------------------------------

describe('PromptDrivenExecutor — AC #15: Degraded marker', () => {
  it('appends [degraded: <reason>] to output when find result has degraded field', async () => {
    const definition = makeDefinition();

    const degraded: FindResult['degraded'] = {
      requestedMode: 'semantic',
      actualMode: 'keyword',
      reason: 'embedding provider unavailable'
    };

    const { executor } = makeExecutor({
      findResult: makeFindResult([makeEvidenceItem()], degraded),
      llmResult: { kind: 'ok', text: 'LLM output', latencyMs: 50 }
    });

    const result = await executor.execute(definition);

    expect(result.output).toContain('[degraded: embedding provider unavailable]');
  });
});

// ---------------------------------------------------------------------------
// AC #14 — Privacy pause
// ---------------------------------------------------------------------------

describe('PromptDrivenExecutor — AC #14: Privacy pause', () => {
  it('returns template fallback and skips LLM when privacy pause is active', async () => {
    const definition = makeDefinition();

    const { executor, completeMock } = makeExecutor({
      privacyState: { paused: true, excludedApps: [] }
    });

    const result = await executor.execute(definition);

    // summary starts with '[template]'
    expect(result.summary).toMatch(/^\[template\]/);

    // output contains 'Privacy pause is active'
    expect(result.output).toContain('Privacy pause is active');

    // LLM complete was NOT called
    expect(completeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC #13 — Secret redaction
// ---------------------------------------------------------------------------

describe('PromptDrivenExecutor — AC #13: Secret redaction', () => {
  it('redacts API keys in evidence text before sending to LLM', async () => {
    const definition = makeDefinition();

    // Evidence contains a secret API key pattern
    const secretText = 'my key is sk-abcdefghij0123456789012345';
    const items: EvidenceItem[] = [
      makeEvidenceItem({ frameId: 1, extractedText: secretText })
    ];

    const { executor, completeMock } = makeExecutor({
      findResult: makeFindResult(items)
    });

    await executor.execute(definition);

    expect(completeMock).toHaveBeenCalledTimes(1);

    const userMessage = completeMock.mock.calls[0][0].messages[1].content;

    // The raw secret must NOT appear in the user message sent to LLM
    expect(userMessage).not.toContain('sk-abcdefghij0123456789012345');

    // The redacted placeholder MUST appear instead
    expect(userMessage).toContain('[REDACTED_API_KEY]');
  });
});
