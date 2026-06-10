import { describe, expect, it } from 'vitest';

import {
  classifyHermesOutcome,
  evaluateIndexReadiness,
  parseDuration,
  parseLiveRunArgs,
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
});
