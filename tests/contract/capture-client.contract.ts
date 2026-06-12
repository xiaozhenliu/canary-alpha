import { expect } from 'vitest';

import type { CaptureClient } from '../../src/services/capture/types.js';

/**
 * Provider-agnostic contract every CaptureClient implementation must pass.
 * Future providers add one test file that builds their client against a
 * fixture backend and calls this function — the assertions never change.
 */
export async function assertCaptureClientContract(client: CaptureClient): Promise<void> {
  const records = await client.search({ limit: 10, offset: 0 });

  expect(Array.isArray(records)).toBe(true);
  for (const record of records) {
    // Identity invariants
    expect(typeof record.id).toBe('string');
    expect(record.id.length).toBeGreaterThan(0);
    expect(typeof record.text).toBe('string');
    // Timestamp must be ISO-8601 parseable
    expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
    // sourceTypes must be a non-empty label array
    expect(Array.isArray(record.sourceTypes)).toBe(true);
    expect(record.sourceTypes.length).toBeGreaterThan(0);
  }

  // Determinism: same request twice yields identically ordered ids
  const again = await client.search({ limit: 10, offset: 0 });
  expect(again.map((r) => r.id)).toEqual(records.map((r) => r.id));
}
