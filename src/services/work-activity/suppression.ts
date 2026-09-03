/**
 * Collapse the persisted suppressed-range list to the millisecond
 * intervals that should hide derived rows from `find` / `recall`.
 *
 * Only rows tagged with `reason: 'cascade-failure'` and without
 * `resolvedAt` are returned — the older `pause` and `delete-range`
 * tombstones are treated as audit trace and do NOT gate retrieval
 * (their derived rows were already cleaned at the time the
 * tombstone was written).
 *
 * Unparseable timestamps are dropped silently rather than collapsed
 * to NaN — the worst case is a malformed tombstone fails to suppress
 * the rows it was supposed to, which is recoverable on the next
 * reconciliation pass.
 */
export function collectActiveCascadeFailureIntervals(
  ranges: readonly { from: string; to: string; reason?: string; resolvedAt?: string }[] | undefined
): Array<{ from: number; to: number }> {
  if (!ranges || ranges.length === 0) return [];
  const intervals: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    if (range.reason !== 'cascade-failure') continue;
    if (range.resolvedAt !== undefined) continue;
    const from = Date.parse(range.from);
    const to = Date.parse(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    intervals.push({ from: Math.min(from, to), to: Math.max(from, to) });
  }
  return intervals;
}
