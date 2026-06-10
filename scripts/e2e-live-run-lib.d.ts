export const RECALL_TOOL_MARKER: string;

export function classifyHermesOutcome(input: {
  transcript: string;
  chatFailed: boolean;
}): {
  outcome: 'pass' | 'fail:llm-not-configured' | 'fail:tool-call-failed' | 'fail:empty-recall';
  failureMode: 'none' | 'llm-not-configured' | 'tool-call-failed' | 'empty-recall';
};

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
