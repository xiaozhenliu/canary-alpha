import { StdioServerTransport } from '@modelcontextprotocol/server';

import type { AppContext } from '../types/app-config.js';
import { createMcpServer } from '../mcp/create-server.js';
import { registerTools } from '../mcp/register-tools.js';

export async function startStdioTransport(app: AppContext): Promise<void> {
  const server = createMcpServer();
  registerTools(server, app);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  app.logger.info('Stdio MCP server running', {
    mode: app.config.server.mode
  });
}
