/**
 * Faithfulness_Evaluation script for the `remote-llm` SummaryProvider.
 *
 * This script is NOT part of the CI gate. Run it manually when you want to
 * evaluate how faithfully the TemplateSummaryProvider (or a remote-llm
 * provider) summarises the synthetic fixture evidence.
 *
 * Usage:
 *   EVAL_JUDGE_BASE_URL=https://api.deepseek.com \
 *   EVAL_JUDGE_API_KEY=sk-... \
 *   EVAL_JUDGE_MODEL=deepseek-chat \
 *   tsx tests/evaluations/work-activity/run-faithfulness.ts
 *
 * Environment variables:
 *   EVAL_JUDGE_BASE_URL  — DeepSeek-compatible endpoint base URL (required)
 *   EVAL_JUDGE_API_KEY   — API key for the judge endpoint (required)
 *   EVAL_JUDGE_MODEL     — Model name to use for judging (required)
 *
 * If any of the three variables is missing the script prints a skip message
 * and exits with code 0 (so CI pipelines that accidentally include this step
 * do not fail).
 *
 * Script flow:
 *   1. Check environment variables; skip if any is missing.
 *   2. Load synthetic fixtures that have non-empty extractedText.
 *   3. Generate a summary for each fixture using TemplateSummaryProvider.
 *   4. Call the judge LLM to evaluate faithfulness of each summary.
 *   5. Print a JSON report to stdout.
 *
 * Requirements: 12.4, 12.5
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TemplateSummaryProvider } from '../../../src/services/work-activity/summary/template.js';
import type { SummaryProviderInput } from '../../../src/services/work-activity/summary/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FixtureFrame {
  id: number;
  timestamp: string;
  app_name: string;
  window_name: string;
  accessibility_tree_json: string;
}

interface FixtureGroundTruth {
  frame_id: number;
  extractedText: string;
  extractionRuleKind: string;
  contextLabel: string;
  contextKey: string;
}

interface FixtureEntry {
  name: string;
  frame: FixtureFrame;
  groundTruth: FixtureGroundTruth;
}

interface ClaimVerdict {
  claim: string;
  verdict: 'FAITHFUL' | 'UNFAITHFUL' | 'UNVERIFIABLE';
  reason: string;
}

interface JudgeResponse {
  claims: ClaimVerdict[];
  faithfulCount: number;
  unfaithfulCount: number;
  unverifiableCount: number;
  faithfulnessScore: number;
  overallVerdict: 'PASS' | 'FAIL';
  overallReason: string;
}

interface EvaluationEntry {
  fixtureName: string;
  appName: string;
  contextLabel: string;
  evidenceFragmentCount: number;
  summary: string;
  judgeResponse: JudgeResponse | null;
  judgeError: string | null;
}

interface FaithfulnessEvalResult {
  timestamp: string;
  judgeModel: string;
  judgeBaseUrl: string;
  totalFixtures: number;
  evaluatedFixtures: number;
  skippedFixtures: number;
  overallPassCount: number;
  overallFailCount: number;
  overallPassRate: number;
  averageFaithfulnessScore: number;
  entries: EvaluationEntry[];
}

// ---------------------------------------------------------------------------
// Environment variable check
// ---------------------------------------------------------------------------

const EVAL_JUDGE_BASE_URL = process.env['EVAL_JUDGE_BASE_URL'];
const EVAL_JUDGE_API_KEY = process.env['EVAL_JUDGE_API_KEY'];
const EVAL_JUDGE_MODEL = process.env['EVAL_JUDGE_MODEL'];

if (!EVAL_JUDGE_BASE_URL || !EVAL_JUDGE_API_KEY || !EVAL_JUDGE_MODEL) {
  const missing: string[] = [];
  if (!EVAL_JUDGE_BASE_URL) missing.push('EVAL_JUDGE_BASE_URL');
  if (!EVAL_JUDGE_API_KEY) missing.push('EVAL_JUDGE_API_KEY');
  if (!EVAL_JUDGE_MODEL) missing.push('EVAL_JUDGE_MODEL');

  console.log(
    `[eval:faithfulness] SKIP — missing environment variable(s): ${missing.join(', ')}\n` +
      'Set all three to run the faithfulness evaluation:\n' +
      '  EVAL_JUDGE_BASE_URL  — OpenAI-compatible endpoint base URL\n' +
      '  EVAL_JUDGE_API_KEY   — API key for the judge endpoint\n' +
      '  EVAL_JUDGE_MODEL     — Model name to use for judging'
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = join(__dirname, '../../fixtures/work-activity/synthetic');

const FIXTURE_NAMES = [
  'ide-vscode',
  'terminal-iterm',
  'chrome-doc',
  'unknown-app'
  // noise-control-center is intentionally excluded: it has no extractedText
];

function loadFixtures(): FixtureEntry[] {
  const entries: FixtureEntry[] = [];

  for (const name of FIXTURE_NAMES) {
    const frameRaw = readFileSync(join(FIXTURES_DIR, name, 'frame.json'), 'utf-8');
    const groundTruthRaw = readFileSync(
      join(FIXTURES_DIR, name, 'ground-truth.json'),
      'utf-8'
    );

    const frame = JSON.parse(frameRaw) as FixtureFrame;
    const groundTruth = JSON.parse(groundTruthRaw) as FixtureGroundTruth;

    // Skip fixtures with empty extractedText (Empty_Extraction)
    if (!groundTruth.extractedText || groundTruth.extractedText.trim() === '') {
      console.error(`[eval:faithfulness] Skipping fixture "${name}": empty extractedText`);
      continue;
    }

    entries.push({ name, frame, groundTruth });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Summary generation via TemplateSummaryProvider
// ---------------------------------------------------------------------------

async function generateSummary(entry: FixtureEntry): Promise<string> {
  const provider = new TemplateSummaryProvider();

  const input: SummaryProviderInput = {
    kind: 'session',
    sessionId: `eval-${entry.frame.id}`,
    appName: entry.frame.app_name,
    contextLabel: entry.groundTruth.contextLabel,
    startedAt: entry.frame.timestamp,
    endedAt: entry.frame.timestamp,
    activeSeconds: 60,
    evidenceFragments: [
      {
        frameId: entry.frame.id,
        timestamp: entry.frame.timestamp,
        extractedText: entry.groundTruth.extractedText
      }
    ]
  };

  const result = await provider.generate(input);
  if (result.kind === 'error') {
    throw new Error(`TemplateSummaryProvider error: ${result.error.message}`);
  }
  return result.text;
}

// ---------------------------------------------------------------------------
// Judge LLM call
// ---------------------------------------------------------------------------

function loadJudgePromptTemplate(): string {
  const promptPath = join(__dirname, 'judge-prompt.md');
  return readFileSync(promptPath, 'utf-8');
}

function buildJudgePrompt(
  template: string,
  evidence: string,
  summary: string
): string {
  return template.replace('{evidence}', evidence).replace('{summary}', summary);
}

async function callJudgeLlm(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  timeoutMs = 60_000
): Promise<JudgeResponse> {
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0,
        max_tokens: 1024
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)');
    throw new Error(`Judge LLM HTTP ${response.status}: ${body}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Judge LLM response missing choices[0].message.content');
  }

  // Strip markdown code fences if the model wrapped the JSON
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: JudgeResponse;
  try {
    parsed = JSON.parse(cleaned) as JudgeResponse;
  } catch (err) {
    throw new Error(
      `Failed to parse judge LLM response as JSON: ${(err as Error).message}\nRaw content: ${content}`
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Main evaluation loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.error('[eval:faithfulness] Starting Faithfulness_Evaluation...');
  console.error(`[eval:faithfulness] Judge model: ${EVAL_JUDGE_MODEL}`);
  console.error(`[eval:faithfulness] Judge endpoint: ${EVAL_JUDGE_BASE_URL}`);

  const fixtures = loadFixtures();
  console.error(`[eval:faithfulness] Loaded ${fixtures.length} fixture(s) with non-empty extraction`);

  const promptTemplate = loadJudgePromptTemplate();
  const entries: EvaluationEntry[] = [];

  for (const fixture of fixtures) {
    console.error(`[eval:faithfulness] Evaluating fixture: ${fixture.name}`);

    // Generate summary
    let summary: string;
    try {
      summary = await generateSummary(fixture);
    } catch (err) {
      console.error(
        `[eval:faithfulness]   ERROR generating summary: ${(err as Error).message}`
      );
      entries.push({
        fixtureName: fixture.name,
        appName: fixture.frame.app_name,
        contextLabel: fixture.groundTruth.contextLabel,
        evidenceFragmentCount: 1,
        summary: '',
        judgeResponse: null,
        judgeError: `Summary generation failed: ${(err as Error).message}`
      });
      continue;
    }

    console.error(`[eval:faithfulness]   Summary: ${summary}`);

    // Build evidence string for the judge prompt
    const evidence = `- [${fixture.frame.timestamp}] ${fixture.groundTruth.extractedText}`;
    const prompt = buildJudgePrompt(promptTemplate, evidence, summary);

    // Call judge LLM
    let judgeResponse: JudgeResponse | null = null;
    let judgeError: string | null = null;

    try {
      judgeResponse = await callJudgeLlm(
        EVAL_JUDGE_BASE_URL!,
        EVAL_JUDGE_API_KEY!,
        EVAL_JUDGE_MODEL!,
        prompt
      );
      console.error(
        `[eval:faithfulness]   Judge verdict: ${judgeResponse.overallVerdict} ` +
          `(score=${judgeResponse.faithfulnessScore}, ` +
          `faithful=${judgeResponse.faithfulCount}, ` +
          `unfaithful=${judgeResponse.unfaithfulCount}, ` +
          `unverifiable=${judgeResponse.unverifiableCount})`
      );
    } catch (err) {
      judgeError = (err as Error).message;
      console.error(`[eval:faithfulness]   ERROR calling judge LLM: ${judgeError}`);
    }

    entries.push({
      fixtureName: fixture.name,
      appName: fixture.frame.app_name,
      contextLabel: fixture.groundTruth.contextLabel,
      evidenceFragmentCount: 1,
      summary,
      judgeResponse,
      judgeError
    });
  }

  // Aggregate results
  const evaluated = entries.filter((e) => e.judgeResponse !== null);
  const skipped = entries.filter((e) => e.judgeResponse === null);
  const passCount = evaluated.filter((e) => e.judgeResponse?.overallVerdict === 'PASS').length;
  const failCount = evaluated.filter((e) => e.judgeResponse?.overallVerdict === 'FAIL').length;
  const avgScore =
    evaluated.length > 0
      ? evaluated.reduce((sum, e) => sum + (e.judgeResponse?.faithfulnessScore ?? 0), 0) /
        evaluated.length
      : 0;

  const result: FaithfulnessEvalResult = {
    timestamp: new Date().toISOString(),
    judgeModel: EVAL_JUDGE_MODEL!,
    judgeBaseUrl: EVAL_JUDGE_BASE_URL!,
    totalFixtures: fixtures.length,
    evaluatedFixtures: evaluated.length,
    skippedFixtures: skipped.length,
    overallPassCount: passCount,
    overallFailCount: failCount,
    overallPassRate: evaluated.length > 0 ? passCount / evaluated.length : 0,
    averageFaithfulnessScore: Math.round(avgScore * 100) / 100,
    entries
  };

  // Print JSON report to stdout
  console.log(JSON.stringify(result, null, 2));

  console.error(
    `\n[eval:faithfulness] Done. ` +
      `${evaluated.length}/${fixtures.length} evaluated, ` +
      `${passCount} PASS / ${failCount} FAIL, ` +
      `avg faithfulness score: ${result.averageFaithfulnessScore}`
  );
}

main().catch((err: unknown) => {
  console.error('[eval:faithfulness] Fatal error:', err);
  process.exit(1);
});
