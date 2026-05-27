import * as z from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../../types/app-config.js';
import type {
  RecallRequest,
  RecallResult,
  RecallSessionItem,
  RecallTimeBlock
} from '../../services/work-activity/recall/recall-service.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Input schema for the `recall` MCP tool. Mirrors design §8.3 verbatim
 * (R7.9): `from` / `to` are required ISO-8601 strings (validation kept
 * lenient — the service treats them as opaque strings and SQLite
 * compares ISO timestamps lexicographically). `granularity` defaults
 * to `'session'`; `appName` is an optional exact-match filter;
 * `includeSummary` defaults to `true` per R7.10.
 */
const inputSchema = z.object({
  from: z
    .string()
    .min(1)
    .describe('ISO-8601 lower bound of the time window (inclusive).'),
  to: z
    .string()
    .min(1)
    .describe('ISO-8601 upper bound of the time window (inclusive).'),
  granularity: z.enum(['session', 'hour', 'day']).default('session'),
  appName: z.string().optional(),
  includeSummary: z.boolean().default(true)
});

/**
 * Output schemas mirroring design §8.3 + R7.10 / R7.11 / R7.15. The
 * tool exposes a flat structure (rather than the design's
 * discriminated `z.union`) because the MCP SDK currently emits the
 * structured payload as a plain JSON object — keeping the schema flat
 * lets agents read either field by name without first branching on
 * a literal discriminator.
 *
 * Both `sessions` and `blocks` arrays are present in the schema; the
 * handler only populates the one matching the requested granularity
 * and leaves the other absent. `narrativeText` is always present
 * (W20 / R7.15).
 */
const sessionItemSchema = z.object({
  sessionId: z.string(),
  appName: z.string(),
  contextLabel: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  activeSeconds: z.number().int().nonnegative(),
  evidenceFrameIds: z.array(z.string()),
  sourceTypes: z.array(z.string()),
  summary: z
    .object({
      text: z.string(),
      status: z.enum([
        'pending',
        'ready',
        'failed',
        'degraded',
        'not_applicable'
      ]),
      providerKind: z.enum(['template', 'remote-llm'])
    })
    .optional()
});

const blockSchema = z.object({
  start: z.string(),
  end: z.string(),
  sessionCount: z.number().int().nonnegative(),
  totalActiveSeconds: z.number().int().nonnegative(),
  byApp: z.record(z.string(), z.number().int().nonnegative()),
  narrativeText: z.string()
});

const outputSchema = z
  .object({
    granularity: z.enum(['session', 'hour', 'day']),
    sessions: z.array(sessionItemSchema).optional(),
    blocks: z.array(blockSchema).optional(),
    narrativeText: z.string()
  })
  // R7.10 / R7.11: the response carries the array matching the
  // requested granularity. The MCP SDK currently flattens the
  // structured payload as a plain JSON object, so we cannot use
  // `z.discriminatedUnion` directly without breaking client tooling
  // — we instead enforce the shape via a refinement so an empty
  // `{ granularity, narrativeText }` payload (which would silently
  // satisfy the lax base schema) is rejected.
  .refine(
    (value) =>
      value.granularity === 'session'
        ? value.sessions !== undefined
        : value.blocks !== undefined,
    (value) => ({
      message:
        value.granularity === 'session'
          ? 'sessions array is required when granularity="session"'
          : 'blocks array is required when granularity="hour"|"day"',
      path: [value.granularity === 'session' ? 'sessions' : 'blocks']
    })
  );

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

type RecallToolInput = z.infer<typeof inputSchema>;

export function registerRecallTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'recall',
    {
      title: 'Recall Time Window',
      description:
        'Recall captured work-activity sessions or aggregated time blocks for a window. ' +
        'Use granularity="session" to list individual sessions, "hour" / "day" to bucket sessions ' +
        'by time. With includeSummary=true (default), each session item carries a summary block.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async (input: RecallToolInput): Promise<CallToolResult> => {
      const recallService = app.services.workActivity.recall;
      const request: RecallRequest = {
        from: input.from,
        to: input.to,
        granularity: input.granularity,
        appName: input.appName,
        includeSummary: input.includeSummary
      };

      let result: RecallResult;
      try {
        result = await recallService.recall(request);
      } catch (error) {
        // Defensive catch: any error (derived database unreadable,
        // malformed JSON in `evidence_frame_ids`, summary worker
        // failure that escaped the worker's own catch, etc.) returns
        // the documented degraded shape rather than letting the MCP
        // channel break. Mirrors the `find` tool's failure path so
        // both work-activity tools surface failures the same way.
        const message = error instanceof Error ? error.message : String(error);
        app.logger.warn('recall tool failed; returning degraded result', {
          message
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: '派生数据当前不可访问，请检查 ~/.canary-alpha-mcp/derived.sqlite。'
            }
          ],
          structuredContent: {
            granularity: input.granularity,
            sessions: input.granularity === 'session' ? [] : undefined,
            blocks: input.granularity !== 'session' ? [] : undefined,
            narrativeText: '派生数据当前不可访问，请检查 ~/.canary-alpha-mcp/derived.sqlite。'
          }
        };
      }

      return {
        content: [
          {
            type: 'text',
            text:
              result.narrativeText.length > 0
                ? result.narrativeText
                : 'recall: no narrative text generated.'
          }
        ],
        structuredContent: toStructuredContent(result)
      };
    }
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Re-shapes a `RecallResult` into the structured payload the MCP SDK
 * serialises. We drop the field that does not match the requested
 * granularity (rather than emitting `undefined`) so consumers do not
 * see explicit `"sessions": null` or `"blocks": null` in the JSON.
 */
function toStructuredContent(result: RecallResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    granularity: result.granularity,
    narrativeText: result.narrativeText
  };
  if (result.granularity === 'session') {
    out.sessions = result.sessions.map(sessionItemToStructured);
  } else {
    out.blocks = result.blocks.map(blockToStructured);
  }
  return out;
}

function sessionItemToStructured(
  item: RecallSessionItem
): Record<string, unknown> {
  // Mirror the optional-field handling of the schema: omit `summary`
  // when absent so the MCP payload does not surface an explicit
  // `"summary": null`.
  const out: Record<string, unknown> = {
    sessionId: item.sessionId,
    appName: item.appName,
    contextLabel: item.contextLabel,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    activeSeconds: item.activeSeconds,
    evidenceFrameIds: item.evidenceFrameIds,
    sourceTypes: item.sourceTypes
  };
  if (item.summary !== undefined) {
    out.summary = {
      text: item.summary.text,
      status: item.summary.status,
      providerKind: item.summary.providerKind
    };
  }
  return out;
}

function blockToStructured(block: RecallTimeBlock): Record<string, unknown> {
  return {
    start: block.start,
    end: block.end,
    sessionCount: block.sessionCount,
    totalActiveSeconds: block.totalActiveSeconds,
    byApp: block.byApp,
    narrativeText: block.narrativeText
  };
}
