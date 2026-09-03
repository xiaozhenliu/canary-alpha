/**
 * FNV-1a 32-bit hash producing a stable unsigned numeric id from a string.
 *
 * Used as a fallback `frameId` when CaptureRecord.frameId is absent —
 * dedup-by-frameId vector-store row keying isolates per frame.
 *
 * Exported so test helpers can derive the same fallback `frameId`
 * when wiring stub work-activity collaborators (see
 * `tests/helpers/indexing-test-doubles.ts`).
 */
export function hashStringToNumericId(input: string): number {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // Multiply by FNV prime (16777619) using imul for proper 32-bit semantics
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned 32-bit so the value never appears negative.
  return hash >>> 0;
}
