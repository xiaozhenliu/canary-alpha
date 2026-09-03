import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../../types/app-config.js';
import { formatPrivacyControlToolResult } from './shared.js';

const inputSchema = z.object({
  action: z.enum(['status', 'pause', 'resume', 'exclude-app', 'remove-excluded-app', 'delete-range']),
  appName: z.string().optional(),
  range: z.enum(['last_1h', 'last_1d', 'all']).optional(),
  confirm: z.boolean().optional()
});

export function registerPrivacyControlTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'privacy-control',
    {
      title: 'Privacy Control',
      description: "Check or modify local privacy collection controls. Available actions: 'status' (read current state), 'pause'/'resume' (toggle screen capture), 'exclude-app'/'remove-excluded-app' (manage per-app exclusions), 'delete-range' (permanently remove captured data for a time window).",
      inputSchema
    },
    async (input) => {
      const result = await app.services.privacy.execute(input);
      return formatPrivacyControlToolResult(result);
    }
  );
}
