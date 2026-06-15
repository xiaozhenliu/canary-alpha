import type { ApiRouter } from '../api-router.js';
import { sendJson } from '../api-router.js';

/** Register /status routes onto the given router. */
export function registerStatusRoutes(router: ApiRouter): void {
  // Returns the current bootstrap/server status snapshot.
  router.register('GET', '/status', async (ctx, app) => {
    const status = await app.services.bootstrapStatus.getStatus();
    sendJson(ctx.res, 200, status);
  });
}
