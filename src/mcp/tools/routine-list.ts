import * as z from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../../types/app-config.js';
import type { RoutineDefinition, RoutineRunRecord } from '../../services/routines/types.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  enabled: z
    .boolean()
    .optional()
    .describe('When provided, only return routines with a matching enabled state.')
});

const runRecordSchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  status: z.enum(['success', 'failed', 'skipped']),
  summary: z.string()
});

const routineInfoSchema = z.object({
  name: z.string(),
  schedule: z.string(),
  enabled: z.boolean(),
  kind: z.enum(['daily_summary']),
  prompt: z.string(),
  recentActivityMinutes: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  latestRun: runRecordSchema.optional()
});

const outputSchema = z.object({
  routines: z.array(routineInfoSchema),
  total: z.number().int().nonnegative()
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

type RoutineListInput = z.infer<typeof inputSchema>;

export function registerRoutineListTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'routine-list',
    {
      title: 'List Routines',
      description:
        'List all configured routines with their schedule, enabled state, and latest run summary. ' +
        'Optionally filter to only enabled or only disabled routines.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async (input: RoutineListInput): Promise<CallToolResult> => {
      const { store } = app.services.routines;

      let definitions: RoutineDefinition[];
      try {
        definitions = await store.listDefinitions();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        app.logger.warn('routine-list: failed to list definitions', { message });
        return {
          isError: true,
          content: [{ type: 'text', text: `routine-list failed: ${message}` }],
          structuredContent: { routines: [], total: 0 }
        };
      }

      // Apply optional enabled filter.
      const filtered =
        typeof input.enabled === 'boolean'
          ? definitions.filter((d) => d.enabled === input.enabled)
          : definitions;

      // Fetch the most recent run for each definition in parallel.
      const routines = await Promise.all(
        filtered.map(async (definition) => {
          let latestRun: RoutineRunRecord | undefined;
          try {
            const runs = await store.listRuns(definition.name, 1);
            latestRun = runs[0];
          } catch (error) {
            // Non-fatal: surface the definition without history.
            app.logger.debug('routine-list: failed to read run history', {
              name: definition.name,
              message: error instanceof Error ? error.message : String(error)
            });
          }

          return {
            name: definition.name,
            schedule: definition.schedule,
            enabled: definition.enabled,
            kind: definition.kind,
            prompt: definition.prompt,
            recentActivityMinutes: definition.recentActivityMinutes,
            createdAt: definition.createdAt,
            updatedAt: definition.updatedAt,
            ...(latestRun
              ? {
                  latestRun: {
                    runId: latestRun.runId,
                    startedAt: latestRun.startedAt,
                    completedAt: latestRun.completedAt,
                    status: latestRun.status,
                    summary: latestRun.summary
                  }
                }
              : {})
          };
        })
      );

      const narrativeText =
        routines.length === 0
          ? 'No routines configured.'
          : `${routines.length} routine(s) configured.`;

      return {
        content: [{ type: 'text', text: narrativeText }],
        structuredContent: {
          routines,
          total: routines.length
        }
      };
    }
  );
}
