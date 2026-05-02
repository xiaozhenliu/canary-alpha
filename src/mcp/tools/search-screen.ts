import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../../types/app-config.js';
import { formatSearchScreenToolResult } from './shared.js';

const inputSchema = z.object({
  query: z.string().min(1).describe('Natural-language screen history query.'),
  mode: z.enum(['semantic', 'keyword', 'hybrid']).default('hybrid'),
  appName: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional()
});

export function registerSearchScreenTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'search-screen',
    {
      title: 'Search Screen History',
      description: 'Search indexed screen history with natural language and optional filters.',
      inputSchema
    },
    async (input) => {
      const result = await app.services.retrieval.searchScreen.search(input);
      return formatSearchScreenToolResult(result);
    }
  );
}
