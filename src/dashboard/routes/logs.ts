import { readFile } from 'node:fs/promises';
import type { ApiRouter } from '../api-router.js';
import { sendJson } from '../api-router.js';
import { resolveLogFilePath } from '../../config/paths.js';

const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 1000;

/** Register /logs routes onto the given router. */
export function registerLogsRoutes(router: ApiRouter): void {
  // GET /logs — read the service log file and return parsed log entries
  // Optional query params:
  //   ?level — filter by log level (e.g. "error", "warn", "info", "debug")
  //   ?limit — number of entries to return from the tail (default 200, max 1000)
  router.register('GET', '/logs', async (ctx, app) => {
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
    let rawContent: string;
    try {
      rawContent = await readFile(logFilePath, 'utf8');
    } catch (err) {
      // Treat missing log file as empty — the server may not have written any
      // logs yet or the log directory may not exist.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        sendJson(ctx.res, 200, { entries: [], total: 0 });
        return;
      }
      throw err;
    }

    // Split into non-empty lines and attempt to parse each as a JSON log entry.
    const lines = rawContent.split('\n').filter((line) => line.trim() !== '');

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

    // Return the last N entries (tail behaviour).
    const tail = filtered.slice(-limit);

    sendJson(ctx.res, 200, { entries: tail, total: filtered.length });
  });
}
