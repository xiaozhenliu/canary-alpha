/**
 * Returns an ISO-8601 timestamp that is `minutes` minutes before the current
 * wall-clock time. Use this in test fixtures whose records must fall inside
 * the retrieval freshness window or `recent-activity` time window.
 *
 * Hardcoded fixed-date timestamps (e.g. '2026-04-13T...') are unsafe because
 * they age past the freshness window the moment real wall-clock time advances
 * far enough, producing misleading test failures unrelated to the code under
 * test.
 */
export function minusMinutes(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}
