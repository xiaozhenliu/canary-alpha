// Pure decision helpers for scripts/e2e-live-run.js. Keep this module free of
// I/O so every branch is unit-testable.

const DURATION_PATTERN = /^(\d+)(s|m|h)$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 };

export function parseDuration(text) {
  const match = DURATION_PATTERN.exec(String(text ?? '').trim());
  if (!match) {
    throw new Error(`Invalid duration '${text}': expected formats like 30s, 10m, 1h.`);
  }
  const value = Number(match[1]);
  if (value <= 0) {
    throw new Error(`Invalid duration '${text}': value must be positive.`);
  }
  return value * UNIT_MS[match[2]];
}

export function parseLiveRunArgs(argv = []) {
  const options = { durationMs: 5 * 60_000, indexTimeoutMs: 120_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--duration') {
      index += 1;
      options.durationMs = parseDuration(argv[index]);
    } else if (argument === '--index-timeout') {
      index += 1;
      options.indexTimeoutMs = parseDuration(argv[index]);
    } else {
      throw new Error(`Unknown argument '${argument}'. Supported: --duration, --index-timeout.`);
    }
  }
  return options;
}

export function evaluateIndexReadiness({ lastExtractedAt, recordEndIso, previousWindowCount, currentWindowCount }) {
  const endMs = Date.parse(recordEndIso);
  if (Number.isNaN(endMs)) {
    throw new Error(`evaluateIndexReadiness: invalid recordEndIso '${recordEndIso}'`);
  }
  if (
    typeof lastExtractedAt === 'string'
    && lastExtractedAt.length > 0
    && Date.parse(lastExtractedAt) >= endMs
  ) {
    return { ready: true, reason: 'watermark' };
  }
  if (
    typeof currentWindowCount === 'number'
    && currentWindowCount > 0
    && currentWindowCount === previousWindowCount
  ) {
    return { ready: true, reason: 'stable-count' };
  }
  return { ready: false, reason: 'waiting' };
}
