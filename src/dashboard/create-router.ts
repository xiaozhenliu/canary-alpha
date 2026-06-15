import { ApiRouter } from './api-router.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerRoutinesRoutes } from './routes/routines.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerPrivacyRoutes } from './routes/privacy.js';
import { registerLogsRoutes } from './routes/logs.js';

/**
 * Assemble and return the dashboard API router with all route groups registered.
 * Each route group registers its own set of paths and handlers onto the shared router.
 */
export function createDashboardRouter(): ApiRouter {
  const router = new ApiRouter();

  registerStatusRoutes(router);
  registerConfigRoutes(router);
  registerRoutinesRoutes(router);
  registerActivityRoutes(router);
  registerPrivacyRoutes(router);
  registerLogsRoutes(router);

  return router;
}
