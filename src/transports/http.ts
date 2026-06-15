import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';

import type { AppContext } from '../types/app-config.js';
import { createMcpServer } from '../mcp/create-server.js';
import { registerTools } from '../mcp/register-tools.js';
import { verifyBearerToken } from '../dashboard/api-auth.js';
import { createDashboardRouter } from '../dashboard/create-router.js';
import { createStaticHandler } from '../dashboard/serve-static.js';

export interface StartedHttpTransport {
  address: {
    host: string;
    port: number;
  };
  server: Server;
}

export async function startHttpTransport(app: AppContext): Promise<StartedHttpTransport> {
  if (!app.config.server.authToken) {
    app.logger.warn(
      'HTTP mode started without authToken — all requests will be rejected with 401. ' +
      'Set server.authToken in config.yaml or CANARY_ALPHA_MCP_AUTH_TOKEN env var.'
    );
  }

  const maxConnections = app.config.server.maxConnections;
  let activeConnections = 0;

  // Set up the dashboard API router and static file handler before creating the server.
  const dashboardRouter = createDashboardRouter();
  const dashboardRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'dashboard');
  const serveDashboardStatic = createStaticHandler(dashboardRoot);

  const server = createServer(async (request, response) => {
    const url = request.url ?? '/';

    // Route: /mcp — MCP protocol endpoint with bearer auth and connection limiting.
    if (url.startsWith('/mcp')) {
      if (!verifyBearerToken(request, app.config.server.authToken)) {
        response.statusCode = 401;
        response.setHeader('content-type', 'application/json');
        response.setHeader('www-authenticate', 'Bearer');
        response.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (activeConnections >= maxConnections) {
        response.statusCode = 503;
        response.setHeader('content-type', 'application/json');
        response.setHeader('retry-after', '1');
        response.end(JSON.stringify({ error: 'Service Unavailable' }));
        return;
      }

      activeConnections++;
      try {
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: undefined
        });
        const mcpServer = createMcpServer();
        registerTools(mcpServer, app);
        await mcpServer.connect(transport);
        await transport.handleRequest(request, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        app.logger.error('HTTP transport request failed', { message });
        if (!response.headersSent) {
          response.statusCode = 500;
          response.setHeader('content-type', 'application/json');
        }
        response.end(JSON.stringify({ error: 'Internal server error' }));
      } finally {
        activeConnections--;
      }
      return;
    }

    // Route: /api/* — Dashboard REST API with auth handled inside the router.
    if (url.startsWith('/api/')) {
      const handled = await dashboardRouter.handle(request, response, app);
      if (handled) return;
    }

    // Route: everything else — serve static dashboard assets with SPA fallback.
    const pathname = url.split('?')[0] || '/';
    const served = await serveDashboardStatic(pathname, response);
    if (!served) {
      response.statusCode = 404;
      response.end('Not Found');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(app.config.server.port, app.config.server.host, () => {
      resolve();
    });
  });

  const addressInfo = server.address();
  if (!addressInfo || typeof addressInfo === 'string') {
    throw new Error('HTTP transport did not expose a TCP address.');
  }

  app.logger.info('HTTP MCP server listening', {
    host: addressInfo.address,
    port: addressInfo.port
  });

  return {
    address: {
      host: addressInfo.address,
      port: addressInfo.port
    },
    server
  };
}
