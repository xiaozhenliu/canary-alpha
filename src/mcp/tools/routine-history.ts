import * as z from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../../types/app-config.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Routine name to look up.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(10)
    .describe('Maximum number of run records to return (newest first). Defaults to 10, max 100.')
});

const runRecordSchema = z.object({
  runId: z.string(),
  name: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  status: z.enum(['success', 'failed', 'skipped']),
  summary: z.string(),
  output: z.string(),
  error: z
    .object({ message: z.string() })
    .optional()
});

const outputSchema = z.object({
  name: z.string(),
  runs: z.array(runRecordSchema),
  total: z.number().int().nonnegative()
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

type RoutineHistoryInput = z.infer<typeof inputSchema>;

export function registerRoutineHistoryTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'routine-history',
    {
      title: 'Routine Execution History',
      description:
        'Show the execution history of a named routine, newest first. ' +
        'Each record includes run status, timing, and the output or error message.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async (input: RoutineHistoryInput): Promise<CallToolResult> => {
      const { store } = app.services.routines;

      let runs;
      try {
        runs = await store.listRuns(input.name, input.limit);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        app.logger.warn('routine-history: failed to list runs', {
          name: input.name,
          message
        });
        return {
          isError: true,
          content: [{ type: 'text', text: `routine-history failed: ${message}` }],
          structuredContent: { name: input.name, runs: [], total: 0 }
        };
      }

      const narrativeText =
        runs.length === 0
          ? `No run history for routine "${input.name}".`
          : `${runs.length} run record(s) for routine "${input.name}".`;

      return {
        content: [{ type: 'text', text: narrativeText }],
        structuredContent: {
          name: input.name,
          runs: runs.map((run) => ({
            runId: run.runId,
            name: run.name,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            status: run.status,
            summary: run.summary,
            output: run.output,
            ...(run.error ? { error: { message: run.error.message } } : {})
          })),
          total: runs.length
        }
      };
    }
  );
}
