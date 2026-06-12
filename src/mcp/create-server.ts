import { McpServer } from '@modelcontextprotocol/server';

import { getPackageVersion } from '../lib/version.js';

export function createMcpServer(): McpServer {
  return new McpServer(
    {
      name: 'canary-alpha-mcp',
      version: getPackageVersion()
    },
    {
      capabilities: {
        logging: {}
      },
      instructions: 'Use the Crimson tool registry for local screen memory operations. Some tools are placeholders in Phase 1 and return explicit unavailable responses.'
    }
  );
}
