import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../../types/app-config.js';
import { formatMemoryReadToolResult } from './shared.js';

const inputSchema = z.object({
  scope: z.enum(['memory', 'user', 'all']).default('all')
});

export function registerMemoryReadTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'memory-read',
    {
      title: 'Read Memory',
      description: 'Read persisted long-term memory by scope.',
      inputSchema
    },
    async (input) => {
      const result = await app.services.memory.read(input);
      return formatMemoryReadToolResult(result);
    }
  );
}
