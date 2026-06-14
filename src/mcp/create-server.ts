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
      instructions:
        'This server exposes THIS MACHINE\'S local screen-capture memory: text and activity that was on the ' +
        "user's own screen over the past days. Use `find` / `recall` / `inspect` ONLY to answer questions " +
        'about what the user previously saw or did on their screen — never as a general web search, ' +
        'filesystem search, or external lookup. Other tools manage long-term memory, file analysis, privacy ' +
        'controls, and the local recorder. All data is local; some tools may return explicit unavailable responses.'
    }
  );
}
