import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Verifies the Bearer token in the Authorization header of an incoming HTTP request.
 *
 * Returns false when no expectedToken is configured (fail-closed: reject all requests).
 * Uses timingSafeEqual to prevent timing-based token oracle attacks.
 */
export function verifyBearerToken(
  request: IncomingMessage,
  expectedToken: string | undefined
): boolean {
  if (!expectedToken) {
    return false;
  }

  const authorization = request.headers.authorization ?? '';
  const expected = Buffer.from(`Bearer ${expectedToken}`);
  const actual = Buffer.from(authorization);

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
