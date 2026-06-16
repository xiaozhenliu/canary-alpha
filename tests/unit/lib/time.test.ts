import { describe, it, expect } from 'vitest';
import { normalizeToUtc } from '../../../src/lib/time.js';

describe('normalizeToUtc', () => {
  it('passes through UTC Z-suffix timestamps', () => {
    expect(normalizeToUtc('2026-06-15T10:30:00.000Z')).toBe('2026-06-15T10:30:00.000Z');
  });

  it('converts +08:00 offset to UTC', () => {
    expect(normalizeToUtc('2026-06-15T18:30:00.000+08:00')).toBe('2026-06-15T10:30:00.000Z');
  });

  it('converts -05:00 offset to UTC', () => {
    expect(normalizeToUtc('2026-06-15T05:30:00.000-05:00')).toBe('2026-06-15T10:30:00.000Z');
  });

  it('preserves millisecond precision', () => {
    expect(normalizeToUtc('2026-06-15T10:30:00.123Z')).toBe('2026-06-15T10:30:00.123Z');
  });

  it('rejects offset-less timestamps', () => {
    expect(() => normalizeToUtc('2026-06-15T10:30:00.000')).toThrow('Timestamp lacks timezone offset');
  });

  it('rejects completely invalid timestamps', () => {
    expect(() => normalizeToUtc('not-a-date+00:00')).toThrow('Invalid timestamp');
  });

  it('handles lowercase z', () => {
    expect(normalizeToUtc('2026-06-15T10:30:00.000z')).toBe('2026-06-15T10:30:00.000Z');
  });
});
