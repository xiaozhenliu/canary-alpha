import * as z from 'zod';
import * as nodeCron from 'node-cron';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../../types/app-config.js';
import type { RoutineDefinition } from '../../services/routines/types.js';
import { normalizeRoutineName } from '../../services/routines/routine-store.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Routine name. Normalized to lowercase alphanumeric with hyphens.'),
  prompt: z
    .string()
    .min(1)
    .describe('Prompt text executed by the routine executor.'),
  schedule: z
    .string()
    .min(1)
    .describe('Cron expression (e.g. "0 8 * * *" for daily at 08:00).'),
  enabled: z
    .boolean()
    .default(true)
    .describe('Whether the routine is active. Defaults to true.'),
  recentActivityMinutes: z
    .number()
    .int()
    .positive()
    .default(60)
    .describe('Look-back window in minutes when the executor queries recent activity. Defaults to 60.')
});

const outputSchema = z.object({
  routine: z.object({
    name: z.string(),
    schedule: z.string(),
    enabled: z.boolean(),
    kind: z.enum(['daily_summary']),
    prompt: z.string(),
    recentActivityMinutes: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string()
  }),
  isNew: z.boolean().describe('True when the routine was created; false when an existing routine was updated.')
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

type RoutineCreateInput = z.infer<typeof inputSchema>;

export function registerRoutineCreateTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'routine-create',
    {
      title: 'Create or Update Routine',
      description:
        'Create a new routine or update an existing one by name. ' +
        'The schedule must be a valid 5-field cron expression. ' +
        'If the scheduler is running, the new definition is picked up immediately.',
      inputSchema,
      outputSchema
    },
    async (input: RoutineCreateInput): Promise<CallToolResult> => {
      // Validate the cron expression before touching the store.
      if (!nodeCron.validate(input.schedule)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `routine-create: invalid cron expression "${input.schedule}". ` +
                'Provide a valid 5-field cron expression (e.g. "0 8 * * *").'
            }
          ],
          structuredContent: {}
        };
      }

      const normalizedName = normalizeRoutineName(input.name);
      if (!normalizedName) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'routine-create: name must contain at least one letter or number.'
            }
          ],
          structuredContent: {}
        };
      }

      const now = new Date().toISOString();
      const definition: RoutineDefinition = {
        name: normalizedName,
        schedule: input.schedule,
        enabled: input.enabled,
        kind: 'daily_summary',
        prompt: input.prompt,
        recentActivityMinutes: input.recentActivityMinutes,
        createdAt: now,
        updatedAt: now
      };

      const { store, scheduler } = app.services.routines;

      let isNew: boolean;
      try {
        isNew = await store.writeDefinition(definition);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        app.logger.warn('routine-create: failed to write definition', {
          name: normalizedName,
          message
        });
        return {
          isError: true,
          content: [{ type: 'text', text: `routine-create failed: ${message}` }],
          structuredContent: {}
        };
      }

      // Re-read from store to get the canonical record (createdAt may have
      // been preserved from the prior version by writeDefinition).
      let saved: RoutineDefinition;
      try {
        const read = await store.readDefinition(normalizedName);
        if (!read) {
          throw new Error('definition vanished immediately after write');
        }
        saved = read;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        app.logger.warn('routine-create: failed to re-read definition after write', {
          name: normalizedName,
          message
        });
        // Return the in-memory version; it reflects what was written.
        saved = definition;
      }

      // Refresh the scheduler so it picks up the new/updated definition
      // without requiring a server restart.
      if (scheduler) {
        try {
          await scheduler.refresh();
          app.logger.info('routine-create: scheduler refreshed', { name: normalizedName });
        } catch (error) {
          // Non-fatal: the definition is persisted; the scheduler will pick
          // it up on the next restart.
          app.logger.warn('routine-create: scheduler refresh failed; definition is persisted', {
            name: normalizedName,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }

      const action = isNew ? 'created' : 'updated';
      return {
        content: [
          {
            type: 'text',
            text: `Routine "${saved.name}" ${action}.`
          }
        ],
        structuredContent: {
          routine: {
            name: saved.name,
            schedule: saved.schedule,
            enabled: saved.enabled,
            kind: saved.kind,
            prompt: saved.prompt,
            recentActivityMinutes: saved.recentActivityMinutes,
            createdAt: saved.createdAt,
            updatedAt: saved.updatedAt
          },
          isNew
        }
      };
    }
  );
}
