import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../../types/app-config.js';
import { formatRecentActivityToolResult } from './shared.js';

const inputSchema = z.object({
  minutes: z.number().int().positive().max(1440).default(60),
  format: z.enum(['summary', 'raw']).default('summary')
});

export function registerRecentActivityTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'recent-activity',
    {
      title: 'Recent Activity',
      description: 'Retrieve recent activity from local screen history.',
      inputSchema
    },
    async (input) => {
      const result = await app.services.retrieval.recentActivity.getRecentActivity(input);
      return formatRecentActivityToolResult(result);
    }
  );
}
