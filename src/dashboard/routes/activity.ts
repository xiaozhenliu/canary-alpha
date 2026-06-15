import type { ApiRouter } from '../api-router.js';
import { sendJson } from '../api-router.js';
import type { FindMode } from '../../services/work-activity/find/find-service.js';

/** Register /activity routes onto the given router. */
export function registerActivityRoutes(router: ApiRouter): void {
  // GET /activity/sessions — time-window session recall
  // Required query params: from, to (ISO-8601)
  router.register('GET', '/activity/sessions', async (ctx, app) => {
    const from = ctx.req.query.get('from');
    const to = ctx.req.query.get('to');

    if (!from || !to) {
      sendJson(ctx.res, 400, {
        error: 'Query parameters "from" and "to" are required (ISO-8601 timestamps)'
      });
      return;
    }

    const appName = ctx.req.query.get('appName') ?? undefined;
    const includeSummaryRaw = ctx.req.query.get('includeSummary');
    const includeSummary =
      includeSummaryRaw !== null ? includeSummaryRaw === 'true' : undefined;

    const result = await app.services.workActivity.recall.recall({
      from,
      to,
      granularity: 'session',
      appName,
      includeSummary
    });

    sendJson(ctx.res, 200, result);
  });

  // POST /activity/search — keyword/semantic/hybrid evidence search
  // Required body field: query
  router.register('POST', '/activity/search', async (ctx, app) => {
    const body = ctx.req.body as Record<string, unknown> | undefined;

    if (!body || typeof body !== 'object') {
      sendJson(ctx.res, 400, { error: 'Request body is required' });
      return;
    }

    const { query, mode, appName, from, to, limit } = body as {
      query?: unknown;
      mode?: unknown;
      appName?: unknown;
      from?: unknown;
      to?: unknown;
      limit?: unknown;
    };

    if (typeof query !== 'string' || query.trim() === '') {
      sendJson(ctx.res, 400, {
        error: 'Field "query" is required and must be a non-empty string'
      });
      return;
    }

    // Resolve and cap limit.
    let resolvedLimit: number | undefined;
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      resolvedLimit = Math.min(Math.floor(limit), 100);
    }

    const resolvedMode: FindMode = (['keyword', 'semantic', 'hybrid'] as FindMode[]).includes(
      mode as FindMode
    )
      ? (mode as FindMode)
      : 'keyword';

    const result = await app.services.workActivity.find.find({
      query,
      mode: resolvedMode,
      appName: typeof appName === 'string' ? appName : undefined,
      from: typeof from === 'string' ? from : undefined,
      to: typeof to === 'string' ? to : undefined,
      limit: resolvedLimit
    });

    sendJson(ctx.res, 200, result);
  });
}
