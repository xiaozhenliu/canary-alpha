import { describe, expect, it } from 'vitest';

import {
  buildCleanupPlan,
  classifyHermesOutcome,
  evaluateIndexReadiness,
  parseDuration,
  parseLiveRunArgs,
  FIND_TOOL_MARKER,
  RECALL_TOOL_MARKER
} from '../../scripts/e2e-live-run-lib.js';

describe('parseDuration', () => {
  it('parses seconds, minutes, hours', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('rejects invalid formats', () => {
    for (const bad of ['', '10', 'm10', '1.5m', '10 m', '-5m', '0s']) {
      expect(() => parseDuration(bad), `'${bad}' must be rejected`).toThrow(/Invalid duration/);
    }
  });
});

describe('parseLiveRunArgs', () => {
  it('applies defaults: duration 5m, index-timeout 120s', () => {
    expect(parseLiveRunArgs([])).toEqual({ durationMs: 300_000, indexTimeoutMs: 120_000 });
  });

  it('parses --duration and --index-timeout', () => {
    expect(parseLiveRunArgs(['--duration', '10m', '--index-timeout', '90s'])).toEqual({
      durationMs: 600_000,
      indexTimeoutMs: 90_000
    });
  });

  it('rejects unknown arguments', () => {
    expect(() => parseLiveRunArgs(['--what'])).toThrow(/Unknown argument/);
  });

  it('rejects missing option value', () => {
    expect(() => parseLiveRunArgs(['--duration'])).toThrow(/Invalid duration/);
  });
});

describe('evaluateIndexReadiness', () => {
  const recordEndIso = '2026-06-10T08:00:00.000Z';

  it('is ready when extraction watermark passes recordEnd', () => {
    expect(evaluateIndexReadiness({
      lastExtractedAt: '2026-06-10T08:00:05.000Z',
      recordEndIso,
      previousWindowCount: 0,
      currentWindowCount: 0
    })).toEqual({ ready: true, reason: 'watermark' });
  });

  it('is not ready when watermark is behind and counts still grow', () => {
    expect(evaluateIndexReadiness({
      lastExtractedAt: '2026-06-10T07:59:00.000Z',
      recordEndIso,
      previousWindowCount: 10,
      currentWindowCount: 14
    })).toEqual({ ready: false, reason: 'waiting' });
  });

  it('falls back to stable non-zero window count', () => {
    expect(evaluateIndexReadiness({
      lastExtractedAt: null,
      recordEndIso,
      previousWindowCount: 14,
      currentWindowCount: 14
    })).toEqual({ ready: true, reason: 'stable-count' });
  });

  it('zero stable count is NOT ready (nothing indexed yet)', () => {
    expect(evaluateIndexReadiness({
      lastExtractedAt: null,
      recordEndIso,
      previousWindowCount: 0,
      currentWindowCount: 0
    })).toEqual({ ready: false, reason: 'waiting' });
  });

  it('throws on invalid recordEndIso', () => {
    expect(() => evaluateIndexReadiness({
      lastExtractedAt: null,
      recordEndIso: 'not-a-date',
      previousWindowCount: 0,
      currentWindowCount: 0
    })).toThrow(/invalid recordEndIso/);
  });

  it('treats malformed lastExtractedAt as not-ready watermark', () => {
    expect(evaluateIndexReadiness({
      lastExtractedAt: 'garbage',
      recordEndIso,
      previousWindowCount: 0,
      currentWindowCount: 0
    })).toEqual({ ready: false, reason: 'waiting' });
  });

  it('is ready when watermark equals recordEnd exactly', () => {
    expect(evaluateIndexReadiness({
      lastExtractedAt: recordEndIso,
      recordEndIso,
      previousWindowCount: 0,
      currentWindowCount: 0
    })).toEqual({ ready: true, reason: 'watermark' });
  });
});

describe('classifyHermesOutcome', () => {
  const okTranscript = `${RECALL_TOOL_MARKER}\nDuring that window you mainly worked in VS Code on canary-alpha-mcp.`;

  it('passes when tool marker present, chat succeeded, answer substantive', () => {
    expect(classifyHermesOutcome({ transcript: okTranscript, chatFailed: false }))
      .toEqual({ outcome: 'pass', failureMode: 'none' });
  });

  it('detects llm-not-configured before tool-call check', () => {
    expect(classifyHermesOutcome({ transcript: 'error: no provider configured', chatFailed: true }))
      .toEqual({ outcome: 'fail:llm-not-configured', failureMode: 'llm-not-configured' });
  });

  it('fails tool-call-failed when marker missing', () => {
    expect(classifyHermesOutcome({ transcript: 'I cannot access your screen data.', chatFailed: false }))
      .toEqual({ outcome: 'fail:tool-call-failed', failureMode: 'tool-call-failed' });
  });

  it('fails tool-call-failed when chat process failed despite marker', () => {
    expect(classifyHermesOutcome({ transcript: okTranscript, chatFailed: true }))
      .toEqual({ outcome: 'fail:tool-call-failed', failureMode: 'tool-call-failed' });
  });

  it('fails empty-recall when tool ran but returned no data', () => {
    const transcript = `${RECALL_TOOL_MARKER}\nThe recall tool returned no results found for that window.`;
    expect(classifyHermesOutcome({ transcript, chatFailed: false }))
      .toEqual({ outcome: 'fail:empty-recall', failureMode: 'empty-recall' });
  });

  it('fails empty-recall on Chinese empty-result phrasing', () => {
    const transcript = `${RECALL_TOOL_MARKER}\nrecall 在该时间窗内没有找到任何记录。`;
    expect(classifyHermesOutcome({ transcript, chatFailed: false }))
      .toEqual({ outcome: 'fail:empty-recall', failureMode: 'empty-recall' });
  });

  it('passes when only the find tool marker is present', () => {
    const transcript = `${FIND_TOOL_MARKER}\nYou were reading the canary-alpha-mcp repo in a terminal.`;
    expect(classifyHermesOutcome({ transcript, chatFailed: false }))
      .toEqual({ outcome: 'pass', failureMode: 'none' });
  });

  it('detects empty-result phrasings the original list missed (fallback path)', () => {
    for (const phrase of ['returned no results for that window', '都没有返回任何内容', '没有任何会话']) {
      const transcript = `${RECALL_TOOL_MARKER}\n${phrase}`;
      expect(classifyHermesOutcome({ transcript, chatFailed: false }))
        .toEqual({ outcome: 'fail:empty-recall', failureMode: 'empty-recall' });
    }
  });

  describe('retrievalProbe is authoritative when ok', () => {
    // The false-pass this guards against: the transcript reads like a full,
    // substantive answer (the agent reconstructed it from fallback metadata),
    // but the direct recall probe proves the window was not retrievable.
    it('fails empty-recall on an empty probe even when the transcript looks substantive', () => {
      expect(classifyHermesOutcome({
        transcript: okTranscript,
        chatFailed: false,
        retrievalProbe: { ok: true, hasContent: false }
      })).toEqual({ outcome: 'fail:empty-recall', failureMode: 'empty-recall' });
    });

    it('passes on a non-empty probe even when the transcript contains an empty-result phrase', () => {
      const transcript = `${RECALL_TOOL_MARKER}\nno results found at first, then I broadened the search.`;
      expect(classifyHermesOutcome({
        transcript,
        chatFailed: false,
        retrievalProbe: { ok: true, hasContent: true }
      })).toEqual({ outcome: 'pass', failureMode: 'none' });
    });

    it('falls back to transcript heuristics when the probe could not run', () => {
      const transcript = `${RECALL_TOOL_MARKER}\nThe recall tool returned no results found for that window.`;
      expect(classifyHermesOutcome({
        transcript,
        chatFailed: false,
        retrievalProbe: { ok: false, recallSessions: null }
      })).toEqual({ outcome: 'fail:empty-recall', failureMode: 'empty-recall' });
    });

    it('still applies the llm-not-configured and tool-call checks before the probe', () => {
      // A green probe must not paper over a chat process failure.
      expect(classifyHermesOutcome({
        transcript: okTranscript,
        chatFailed: true,
        retrievalProbe: { ok: true, hasContent: true }
      })).toEqual({ outcome: 'fail:tool-call-failed', failureMode: 'tool-call-failed' });
    });
  });
});

describe('buildCleanupPlan', () => {
  it('stops only what the script started', () => {
    expect(buildCleanupPlan({ startedScreenpipe: true, startedMcpService: false }))
      .toEqual(['stop-screenpipe']);
    expect(buildCleanupPlan({ startedScreenpipe: false, startedMcpService: true }))
      .toEqual(['stop-mcp-service']);
    expect(buildCleanupPlan({ startedScreenpipe: true, startedMcpService: true }))
      .toEqual(['stop-screenpipe', 'stop-mcp-service']);
  });

  it('keeps reused instances running', () => {
    expect(buildCleanupPlan({ startedScreenpipe: false, startedMcpService: false })).toEqual([]);
  });
});
