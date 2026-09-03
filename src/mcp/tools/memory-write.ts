import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../../types/app-config.js';
import { formatMemoryWriteToolResult } from './shared.js';

const inputSchema = z.object({
  scope: z.enum(['memory', 'user']).default('memory'),
  content: z.string().min(1).max(65536),
  mode: z.enum(['append', 'replace']).default('append')
});

export function registerMemoryWriteTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'memory-write',
    {
      title: 'Write Memory',
      description: "Append or replace long-term memory content. mode='append' adds to existing content; mode='replace' overwrites it entirely. Scope selects the memory partition to write to ('memory' or 'user').",
      inputSchema
    },
    async (input) => {
      const result = await app.services.memory.write(input);
      return formatMemoryWriteToolResult(result);
    }
  );
}
