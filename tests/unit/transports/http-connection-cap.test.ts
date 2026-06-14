import { describe, expect, it } from 'vitest';

/**
 * Pure decision function mirroring the guard in src/transports/http.ts:
 *   if (activeConnections >= maxConnections) → reject (503)
 */
function shouldReject(active: number, max: number): boolean {
  return active >= max;
}

describe('HTTP connection cap — shouldReject(active, max)', () => {
  const DEFAULT_MAX = 10;

  it('admits when well under the cap', () => {
    expect(shouldReject(0, DEFAULT_MAX)).toBe(false);
    expect(shouldReject(3, DEFAULT_MAX)).toBe(false);
  });

  it('admits at cap-1 (one slot remaining)', () => {
    expect(shouldReject(DEFAULT_MAX - 1, DEFAULT_MAX)).toBe(false);
  });

  it('rejects at exactly the cap', () => {
    expect(shouldReject(DEFAULT_MAX, DEFAULT_MAX)).toBe(true);
  });

  it('rejects above the cap', () => {
    expect(shouldReject(DEFAULT_MAX + 1, DEFAULT_MAX)).toBe(true);
    expect(shouldReject(100, DEFAULT_MAX)).toBe(true);
  });

  it('respects a custom maxConnections value', () => {
    const custom = 5;
    expect(shouldReject(4, custom)).toBe(false);
    expect(shouldReject(5, custom)).toBe(true);
    expect(shouldReject(6, custom)).toBe(true);
  });

  it('works with maxConnections = 1 (single-connection mode)', () => {
    expect(shouldReject(0, 1)).toBe(false);
    expect(shouldReject(1, 1)).toBe(true);
  });
});
