import { McpServer } from '@modelcontextprotocol/server';

export function createMcpServer(): McpServer {
  return new McpServer(
    {
      name: 'canary-alpha-mcp',
      version: '0.1.0'
    },
    {
      capabilities: {
        logging: {}
      },
      instructions: 'Use the focused v1 tool registry for local screen memory operations. Some tools are placeholders in Phase 1 and return explicit unavailable responses.'
    }
  );
}
