import { open, stat } from 'node:fs/promises';
import type { ApiRouter } from '../api-router.js';
import { sendJson } from '../api-router.js';
import { resolveLogFilePath } from '../../config/paths.js';

const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 1000;

// When a level filter is active we over-read to ensure we collect enough
// matching entries after filtering. Reading 10x MAX_LOG_LIMIT lines limits
// memory to ~10K lines regardless of file size.
const FILTER_OVERSCAN_LINES = MAX_LOG_LIMIT * 10;

// Hard byte cap: never hold more than 10 MiB in raw buffer fragments regardless
// of line count. Prevents OOM on pathological files (e.g. single huge lines).
const MAX_BYTES_IN_MEMORY = 10 * 1024 * 1024;

// Chunk size for backward reads (64 KiB).
const READ_CHUNK_SIZE = 64 * 1024;

/**
 * Read up to `maxLines` non-empty lines from the tail of a file using
 * backward chunk reads. Never loads more than MAX_BYTES_IN_MEMORY bytes
 * into memory regardless of file size or line content.
 *
 * Buffer fragments are kept as Buffers and decoded once at the end to avoid
 * UTF-8 multi-byte character corruption at chunk boundaries.
 *
 * Returns the lines in forward (chronological) order.
 */
async function readTailLines(filePath: string, maxLines: number): Promise<string[]> {
  let fileSize: number;
  try {
    const stats = await stat(filePath);
    fileSize = stats.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  if (fileSize === 0) {
    return [];
  }

  const fh = await open(filePath, 'r');
  try {
    // Accumulate Buffer fragments in forward order (prepend each chunk).
    // Storing Buffers and decoding once at the end prevents UTF-8 corruption
    // that would occur if we decoded each chunk independently.
    const fragments: Buffer[] = [];
    let bytesAccumulated = 0;
    let position = fileSize;

    while (position > 0 && bytesAccumulated < MAX_BYTES_IN_MEMORY) {
      const chunkSize = Math.min(READ_CHUNK_SIZE, position, MAX_BYTES_IN_MEMORY - bytesAccumulated);
      position -= chunkSize;

      const buffer = Buffer.allocUnsafe(chunkSize);
      // Use the actual bytes read in case the file shrinks (e.g. log rotation)
      // between the stat() call and the read().
      const { bytesRead: actual } = await fh.read(buffer, 0, chunkSize, position);
      const slice = actual < chunkSize ? buffer.subarray(0, actual) : buffer;

      // Prepend so fragments remain in forward file order after concat.
      fragments.unshift(slice);
      bytesAccumulated += actual;

      // Early exit check: decode accumulated bytes to count non-empty lines.
      // Decoding the joined buffer on each iteration is O(bytesAccumulated)
      // but acceptable since iterations are bounded (64 KiB steps, 10 MiB cap
      // → at most ~160 iterations).
      const combined = Buffer.concat(fragments).toString('utf8');
      const nonEmptyLineCount = combined
        .split('\n')
        .filter((l) => l.trim() !== '').length;

      if (nonEmptyLineCount >= maxLines) {
        // We have at least enough non-empty lines; stop reading.
        break;
      }
    }

    // Final decode — single UTF-8 decode over the full buffer prevents
    // multi-byte character splitting that would occur with per-chunk decoding.
    const combined = Buffer.concat(fragments).toString('utf8');
    const allLines = combined.split('\n').filter((line) => line.trim() !== '');

    // Return the last maxLines lines in forward order.
    return allLines.slice(-maxLines);
  } finally {
    await fh.close();
  }
}

/** Register /logs routes onto the given router. */
export function registerLogsRoutes(router: ApiRouter): void {
  // GET /logs — tail the service log file and return parsed log entries.
  // Uses a backward chunk reader bounded by MAX_BYTES_IN_MEMORY to avoid OOM.
  // Optional query params:
  //   ?level — filter by log level (e.g. "error", "warn", "info", "debug")
  //   ?limit — number of entries to return from the tail (default 200, max 1000)
  router.register('GET', '/logs', async (ctx, _app) => {
    const levelFilter = ctx.req.query.get('level');

    const rawLimit = ctx.req.query.get('limit');
    let limit = DEFAULT_LOG_LIMIT;
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(Math.floor(parsed), MAX_LOG_LIMIT);
      }
    }

    const logFilePath = resolveLogFilePath();

    // When a level filter is active we need more raw lines to find enough
    // matching entries, so we over-scan. The byte cap in readTailLines provides
    // the hard memory bound regardless of this multiplier.
    const rawLineCount = levelFilter !== null ? FILTER_OVERSCAN_LINES : limit;

    let lines: string[];
    try {
      lines = await readTailLines(logFilePath, rawLineCount);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        sendJson(ctx.res, 200, { entries: [], total: 0 });
        return;
      }
      throw err;
    }

    // Parse each line as a JSON log entry; keep non-JSON lines as raw strings.
    const entries: unknown[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        entries.push(parsed);
      } catch {
        // Non-JSON lines are kept as raw string entries so they remain visible
        // in the dashboard rather than silently dropping important output.
        entries.push({ raw: line });
      }
    }

    // Apply optional level filter against the parsed "level" field.
    const filtered =
      levelFilter !== null
        ? entries.filter((entry) => {
            if (typeof entry === 'object' && entry !== null && 'level' in entry) {
              return (entry as Record<string, unknown>).level === levelFilter;
            }
            return false;
          })
        : entries;

    // Return the last N entries from the bounded read window (tail behaviour).
    // `total` reflects the count within the read window after filtering.
    // This is an intentional tradeoff: computing the true total across the
    // entire file would require reading the entire file into memory.
    const tail = filtered.slice(-limit);

    sendJson(ctx.res, 200, { entries: tail, total: filtered.length });
  });
}

// Export readTailLines for unit testing.
export { readTailLines };
