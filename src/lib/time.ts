const OFFSET_PATTERN = /[Zz]|[+-]\d{2}(?::?\d{2})?$/;

export function normalizeToUtc(timestamp: string): string {
  if (!OFFSET_PATTERN.test(timestamp)) {
    throw new Error(`Timestamp lacks timezone offset: ${timestamp}`);
  }
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid timestamp: ${timestamp}`);
  }
  return new Date(ms).toISOString();
}
