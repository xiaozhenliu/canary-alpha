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
      description: "Check, start, or stop the local Screenpipe recording process. action='status' is read-only; 'start' and 'stop' have side effects — they launch or terminate the screen-capture daemon on this machine.",
      inputSchema
    },
    async (input) => {
      // Audit log lifecycle actions before execution
      if (input.action === 'start' || input.action === 'stop') {
        app.logger.warn('screenpipe-control action requested', { action: input.action });
      }

      const result = await app.services.screenpipeControl.execute(input);

      // Audit log lifecycle actions after execution
      if (input.action === 'start' || input.action === 'stop') {
        app.logger.warn('screenpipe-control action completed', {
          action: input.action,
          running: result.running,
          pid: result.pid,
          error: result.error,
        });
      }

      return formatResult(result);
    }
  );
}
