import { timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';

describe('timing-safe auth comparison logic', () => {
  function isAuthorized(authorization: string | undefined, expectedToken: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${expectedToken ?? ''}`);
    const actual = Buffer.from(authorization ?? '');
    if (!expectedToken || expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  it('accepts a valid token', () => {
    expect(isAuthorized('Bearer my-secret', 'my-secret')).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(isAuthorized('Bearer wrong', 'my-secret')).toBe(false);
  });

  it('rejects missing authorization header', () => {
    expect(isAuthorized(undefined, 'my-secret')).toBe(false);
  });

  it('rejects when expectedToken is undefined', () => {
    expect(isAuthorized('Bearer anything', undefined)).toBe(false);
  });

  it('rejects when both are empty', () => {
    expect(isAuthorized('', '')).toBe(false);
  });

  it('rejects length-mismatched tokens without calling timingSafeEqual', () => {
    expect(isAuthorized('Bearer short', 'a-much-longer-secret-token')).toBe(false);
  });
});
