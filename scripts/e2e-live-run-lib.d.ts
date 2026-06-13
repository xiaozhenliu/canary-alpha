export const RECALL_TOOL_MARKER: string;
export const FIND_TOOL_MARKER: string;

/**
 * Ground-truth retrieval measurement taken by the harness (by calling
 * `recall` directly over the recorded window), used to decide empty-recall
 * authoritatively rather than by phrase-matching the model's prose.
 */
export interface RetrievalProbe {
  /** Whether the probe itself ran (false on connection / tool error). */
  ok: boolean;
  /** Whether recall returned >= 1 session; only meaningful when `ok`. */
  hasContent?: boolean;
  /** Raw session count, or null when the probe failed. */
  recallSessions?: number | null;
}

export function classifyHermesOutcome(input: {
  transcript: string;
  chatFailed: boolean;
  /**
   * When supplied with `ok === true`, this is AUTHORITATIVE for the
   * empty-recall decision and overrides the transcript phrase heuristics.
   */
  retrievalProbe?: RetrievalProbe;
}): {
  outcome: 'pass' | 'fail:llm-not-configured' | 'fail:tool-call-failed' | 'fail:empty-recall';
  failureMode: 'none' | 'llm-not-configured' | 'tool-call-failed' | 'empty-recall';
};

export function buildCleanupPlan(input: {
  startedScreenpipe: boolean;
  startedMcpService: boolean;
}): Array<'stop-screenpipe' | 'stop-mcp-service'>;

export function parseDuration(text: string): number;

export function parseLiveRunArgs(argv?: string[]): {
  durationMs: number;
  indexTimeoutMs: number;
};

export function evaluateIndexReadiness(input: {
  lastExtractedAt: string | null;
  recordEndIso: string;
  previousWindowCount: number;
  currentWindowCount: number;
}): { ready: boolean; reason: 'watermark' | 'stable-count' | 'waiting' };
