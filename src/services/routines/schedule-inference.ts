/**
 * Infers a sensible look-back window (in minutes) from a 5-field cron expression.
 *
 * The heuristic maps schedule frequency to a look-back window so that each
 * execution covers roughly one period's worth of activity:
 *   - Weekly schedules  → 10 080 min (7 days)
 *   - Monthly schedules → 43 200 min (30 days)
 *   - Daily schedules   →  1 440 min (24 hours)
 *   - Sub-daily         →     60 min (1 hour, conservative default)
 */
export function inferRecentActivityMinutes(cron: string): number {
  const parts = cron.split(' ');
  // node-cron accepts both 5-field and 6-field (seconds prefix) expressions.
  // Normalise to 5-field by stripping the leading seconds field when present.
  const fields = parts.length === 6 ? parts.slice(1) : parts;
  if (fields.length < 5) return 60;
  const [, hour, dayOfMonth, , dayOfWeek] = fields;
  if (dayOfWeek !== '*') return 10080;   // weekly (7 days)
  if (dayOfMonth !== '*') return 43200;  // monthly (30 days)
  if (hour !== '*') return 1440;         // daily (24 hours)
  return 60;                             // sub-daily
}
