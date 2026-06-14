import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';

import type { AppContext } from '../types/app-config.js';
import { createMcpServer } from '../mcp/create-server.js';
import { registerTools } from '../mcp/register-tools.js';

export interface StartedHttpTransport {
  address: {
    host: string;
    port: number;
  };
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

  const server = createServer(async (request, response) => {
    if (!request.url || !request.url.startsWith('/mcp')) {
      response.statusCode = 404;
      response.end('Not Found');
      return;
    }

    const expectedToken = app.config.server.authToken;
    const authorization = request.headers.authorization ?? '';
    const expected = Buffer.from(`Bearer ${expectedToken ?? ''}`);
    const actual = Buffer.from(authorization);
    if (!expectedToken || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
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
    }
  };
}
