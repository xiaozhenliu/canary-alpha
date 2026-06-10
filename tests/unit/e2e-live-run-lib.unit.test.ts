import { describe, expect, it } from 'vitest';

import {
  parseDuration,
  parseLiveRunArgs
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
