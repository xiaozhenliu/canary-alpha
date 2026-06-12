import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../../types/app-config.js';
import type { ScreenpipeControlResult } from '../../services/capture/providers/screenpipe/control-service.js';

const inputSchema = z.object({
  action: z.enum(['status', 'start', 'stop'])
});

function formatResult(result: ScreenpipeControlResult) {
  const lines = [`action: ${result.action}`, `running: ${result.running}`];
  if (result.pid !== undefined) lines.push(`pid: ${result.pid}`);
  if (result.error) lines.push(`error: ${result.error}`);
  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

export function registerScreenpipeControlTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'screenpipe-control',
    {
      title: 'Screenpipe Control',
      description: 'Check, start, or stop the local Screenpipe recording process.',
      inputSchema
    },
    async (input) => {
      const result = await app.services.screenpipeControl.execute(input);
      return formatResult(result);
    }
  );
}
