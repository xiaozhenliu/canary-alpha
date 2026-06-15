import type { ApiRouter } from '../api-router.js';
import { sendJson } from '../api-router.js';
import type {
  PrivacyAction,
  PrivacyDeleteRange
} from '../../services/privacy/types.js';

/** Register /privacy routes onto the given router. */
export function registerPrivacyRoutes(router: ApiRouter): void {
  // GET /privacy — retrieve current privacy status
  router.register('GET', '/privacy', async (ctx, app) => {
    const result = await app.services.privacy.execute({ action: 'status' });
    sendJson(ctx.res, 200, result);
  });

  // POST /privacy/action — execute a privacy action
  router.register('POST', '/privacy/action', async (ctx, app) => {
    const body = ctx.req.body as Record<string, unknown> | undefined;

    if (!body || typeof body !== 'object') {
      sendJson(ctx.res, 400, { error: 'Request body is required' });
      return;
    }

    const { action, appName, range, confirm } = body as {
      action?: unknown;
      appName?: unknown;
      range?: unknown;
      confirm?: unknown;
    };

    if (typeof action !== 'string' || action.trim() === '') {
      sendJson(ctx.res, 400, {
        error: 'Field "action" is required'
      });
      return;
    }

    const result = await app.services.privacy.execute({
      action: action as PrivacyAction,
      appName: typeof appName === 'string' ? appName : undefined,
      range: typeof range === 'string' ? (range as PrivacyDeleteRange) : undefined,
      confirm: typeof confirm === 'boolean' ? confirm : undefined
    });

    sendJson(ctx.res, 200, result);
  });
}
