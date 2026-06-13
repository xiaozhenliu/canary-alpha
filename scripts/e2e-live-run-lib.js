// Pure decision helpers for scripts/e2e-live-run.js. Keep this module free of
// I/O so every branch is unit-testable.

const DURATION_PATTERN = /^(\d+)(s|m|h)$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 };

export function parseDuration(text) {
  const match = DURATION_PATTERN.exec(String(text ?? '').trim());
  if (!match) {
    throw new Error(`Invalid duration '${text}': expected formats like 30s, 10m, 1h.`);
  }
  const value = Number(match[1]);
  if (value <= 0) {
    throw new Error(`Invalid duration '${text}': value must be positive.`);
  }
  return value * UNIT_MS[match[2]];
}

export function parseLiveRunArgs(argv = []) {
  const options = { durationMs: 5 * 60_000, indexTimeoutMs: 120_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--duration') {
      index += 1;
      options.durationMs = parseDuration(argv[index]);
    } else if (argument === '--index-timeout') {
      index += 1;
      options.indexTimeoutMs = parseDuration(argv[index]);
    } else {
      throw new Error(`Unknown argument '${argument}'. Supported: --duration, --index-timeout.`);
    }
  }
  return options;
}

// Signal lists mirror hermes-e2e.js so the two verification scripts agree on
// failure-mode vocabulary.
const LLM_NOT_CONFIGURED_SIGNALS = ['no model', 'provider not configured', 'model not set', 'no provider'];
// Fallback-only heuristic, used when no structured retrieval probe is
// available. Phrase-matching the model's prose is brittle (it misses
// paraphrases and is silently defeated when the agent works around an empty
// recall/find by reading other tools' metadata), so a structured probe over
// the recorded window is the authoritative signal — see `retrievalProbe`
// in `classifyHermesOutcome`. These phrases are a best-effort backstop only.
const EMPTY_RECALL_SIGNALS = [
  'no results found',
  'no records found',
  'no results for',
  'nothing was captured',
  '没有找到',
  '未找到任何',
  '没有返回任何',
  '没有任何会话',
  '未返回任何'
];

export const RECALL_TOOL_MARKER = 'preparing mcp_canary_alpha_mcp_recall';
export const FIND_TOOL_MARKER = 'preparing mcp_canary_alpha_mcp_find';

/**
 * @typedef {Object} RetrievalProbe
 * @property {boolean} ok Whether the probe itself ran (false on connection / tool error).
 * @property {boolean} [hasContent] Whether recall returned ≥1 session; only meaningful when `ok`.
 * @property {number|null} [recallSessions] Raw session count, or null when the probe failed.
 */

/**
 * Classify a hermes verification run.
 *
 * `retrievalProbe` (optional) is the harness's own ground-truth measurement
 * of whether the recorded window is actually retrievable through the MCP
 * tools, taken by calling `recall` directly rather than inferring from the
 * model's prose. When the probe succeeded (`ok === true`) it is AUTHORITATIVE
 * for the empty-recall decision — a substantive-looking transcript can no
 * longer mask an empty retrieval (the false-pass this guards against). The
 * transcript phrase heuristics are used only when no successful probe is
 * supplied.
 *
 * @param {{ transcript: string, chatFailed: boolean, retrievalProbe?: RetrievalProbe }} args
 * @returns {{ outcome: string, failureMode: string }}
 */
export function classifyHermesOutcome({ transcript, chatFailed, retrievalProbe }) {
  const lower = transcript.toLowerCase();
  if (LLM_NOT_CONFIGURED_SIGNALS.some((signal) => lower.includes(signal))) {
    return { outcome: 'fail:llm-not-configured', failureMode: 'llm-not-configured' };
  }
  const toolCalled = transcript.includes(RECALL_TOOL_MARKER) || transcript.includes(FIND_TOOL_MARKER);
  if (!toolCalled || chatFailed) {
    return { outcome: 'fail:tool-call-failed', failureMode: 'tool-call-failed' };
  }
  if (retrievalProbe !== undefined && retrievalProbe.ok === true) {
    // Ground truth wins, in both directions: empty probe → fail regardless of
    // how substantive the prose looks; non-empty probe → the window is
    // retrievable, so prose phrase-matching is skipped entirely.
    return retrievalProbe.hasContent
      ? { outcome: 'pass', failureMode: 'none' }
      : { outcome: 'fail:empty-recall', failureMode: 'empty-recall' };
  }
  if (EMPTY_RECALL_SIGNALS.some((signal) => lower.includes(signal))) {
    return { outcome: 'fail:empty-recall', failureMode: 'empty-recall' };
  }
  return { outcome: 'pass', failureMode: 'none' };
}

export function buildCleanupPlan({ startedScreenpipe, startedMcpService }) {
  const actions = [];
  if (startedScreenpipe) {
    actions.push('stop-screenpipe');
  }
  if (startedMcpService) {
    actions.push('stop-mcp-service');
  }
  return actions;
}

export function evaluateIndexReadiness({ lastExtractedAt, recordEndIso, previousWindowCount, currentWindowCount }) {
  const endMs = Date.parse(recordEndIso);
  if (Number.isNaN(endMs)) {
    throw new Error(`evaluateIndexReadiness: invalid recordEndIso '${recordEndIso}'`);
  }
  if (
    typeof lastExtractedAt === 'string'
    && lastExtractedAt.length > 0
    && Date.parse(lastExtractedAt) >= endMs
  ) {
    return { ready: true, reason: 'watermark' };
  }
  if (
    typeof currentWindowCount === 'number'
    && currentWindowCount > 0
    && currentWindowCount === previousWindowCount
  ) {
    return { ready: true, reason: 'stable-count' };
  }
  return { ready: false, reason: 'waiting' };
}
