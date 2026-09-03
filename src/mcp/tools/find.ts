import * as z from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../../types/app-config.js';
import type {
  EvidenceItem,
  FindRequest,
  FindResult
} from '../../services/work-activity/find/find-service.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Input schema for the `find` MCP tool. Mirrors design §8.2 verbatim:
 *
 *   - `query` is required, 1-512 chars after trimming whitespace.
 *   - `from` / `to` are optional ISO-8601 strings (validation kept
 *     lenient — the service treats them as opaque strings, leaning on
 *     SQLite's lexicographic comparison of ISO timestamps).
 *   - `mode` defaults to `'keyword'` (R7.2). Task 8.3 will plug in
 *     `semantic` / `hybrid`; the schema already accepts them so the
 *     contract stays stable.
 *   - `limit` defaults to 20, capped at 100 (R7.2 + design §8.2).
 *   - `groupBy` is optional `'session'`; the literal-only enum keeps
 *     room for future grouping options without a breaking schema
 *     change.
 */
const inputSchema = z.object({
  query: z.string().min(1).max(512).describe('Search query, NFC-normalized, ≤ 512 chars.'),
  from: z.string().optional(),
  to: z.string().optional(),
  mode: z.enum(['keyword', 'semantic', 'hybrid']).default('keyword'),
  appName: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20),
  groupBy: z.enum(['session']).optional()
});

/**
 * Output schema mirroring design §8.2 + R7.3 / R7.15. The
 * `evidenceItemSchema` is shared with the `inspect` tool (when task
 * 8.5 lands) and intentionally allows `frameId: string | number` for
 * forward compatibility with backends that might surface UUIDs; this
 * service always emits numeric IDs.
 */
const evidenceItemSchema = z.object({
  frameId: z.union([z.string(), z.number()]),
  sessionId: z.string().optional(),
  appName: z.string().optional(),
  contextLabel: z.string(),
  extractedText: z.string(),
  timestamp: z.string(),
  matchSource: z.enum(['keyword', 'semantic']),
  score: z.number().optional(),
  sourceTypes: z.array(z.string())
});

const outputSchema = z.object({
  data: z.array(evidenceItemSchema),
  groupedBySession: z
    .array(
      z.object({
        sessionId: z.string(),
        items: z.array(evidenceItemSchema)
      })
    )
    .optional(),
  // R7.15 / W20: narrativeText MUST be present even when empty.
  narrativeText: z.string(),
  // Optional degraded marker. Today this carries two distinct
  // signals on a single field: the task 8.3 semantic→keyword
  // fallback (R7.6), and a keyword-scan truncation when the
  // service hits its hard scan ceiling on a very large window.
  // Either way, callers SHOULD treat the result as approximate.
  degraded: z
    .object({
      requestedMode: z.enum(['keyword', 'semantic', 'hybrid']),
      actualMode: z.enum(['keyword', 'semantic']),
      reason: z.string()
    })
    .optional()
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

type FindToolInput = z.infer<typeof inputSchema>;

export function registerFindTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'find',
    {
      title: 'Find in Screen Memory',
      description:
        "Search THIS MACHINE'S local screen-capture memory — text that was actually on the user's screen (captured windows, apps, documents, terminals, web pages) — for fragments matching a keyword. " +
        'Use this only to recall what the user previously saw or did on screen; it does NOT search the web, the local filesystem, or any external source. ' +
        'Returns per-fragment hits ordered by recency, optionally grouped by work session.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async (input: FindToolInput): Promise<CallToolResult> => {
      const findService = app.services.workActivity.find;
      const request: FindRequest = {
        query: input.query,
        from: input.from,
        to: input.to,
        mode: input.mode,
        appName: input.appName,
        limit: input.limit,
        groupBy: input.groupBy
      };

      let result: FindResult;
      try {
        result = await findService.find(request);
      } catch (error) {
        // Defensive catch: any error (derived database unreadable,
        // malformed JSON in `evidence_frame_ids`, etc.) returns the
        // documented degraded shape rather than letting the MCP
        // channel break. This preserves the R7.15 / W20 invariant
        // that `narrativeText` is always a string in the structured
        // payload.
        const message = error instanceof Error ? error.message : String(error);
        app.logger.warn('find tool failed; returning degraded result', {
          message
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: '派生数据当前不可访问，请检查 ~/.computer-history-mcp/derived.sqlite。'
            }
          ],
          structuredContent: emptyStructuredContent(
            '派生数据当前不可访问，请检查 ~/.computer-history-mcp/derived.sqlite。'
          )
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: result.narrativeText.length > 0
              ? result.narrativeText
              : 'find: no narrative text generated.'
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
 * Re-shapes a `FindResult` into the structured payload the MCP SDK
 * serialises. Mostly identity, but we drop `groupedBySession` /
 * `degraded` when absent to avoid emitting `undefined` keys (the SDK
 * preserves them in the JSON otherwise, and consumers shouldn't need
 * to treat `null`-like sentinels).
 */
function toStructuredContent(result: FindResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    data: result.data.map((item) => evidenceItemToStructured(item)),
    narrativeText: result.narrativeText
  };
  if (result.groupedBySession !== undefined) {
    out.groupedBySession = result.groupedBySession.map((group) => ({
      sessionId: group.sessionId,
      items: group.items.map((item) => evidenceItemToStructured(item))
    }));
  }
  if (result.degraded !== undefined) {
    out.degraded = result.degraded;
  }
  return out;
}

function evidenceItemToStructured(item: EvidenceItem): Record<string, unknown> {
  // Mirror the optional-field handling of the schema: omit keys when
  // the source value is `undefined`. The MCP SDK serialises objects
  // verbatim, so leaving `appName: undefined` in place would surface
  // an explicit `"appName": null` (not what the schema declares).
  const out: Record<string, unknown> = {
    frameId: item.frameId,
    contextLabel: item.contextLabel,
    extractedText: item.extractedText,
    timestamp: item.timestamp,
    matchSource: item.matchSource,
    sourceTypes: item.sourceTypes
  };
  if (item.sessionId !== undefined) out.sessionId = item.sessionId;
  if (item.appName !== undefined) out.appName = item.appName;
  if (item.score !== undefined) out.score = item.score;
  return out;
}

function emptyStructuredContent(narrativeText: string): Record<string, unknown> {
  return {
    data: [],
    narrativeText
  };
}
