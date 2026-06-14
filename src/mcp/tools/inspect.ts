import * as z from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../../types/app-config.js';
import type {
  InspectResult,
  InspectFrameResult,
  InspectSessionResult,
  InspectTarget
} from '../../services/work-activity/inspect/inspect-service.js';

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

/**
 * Input schema mirrors design §8.4 verbatim. The discriminator is the
 * presence of `sessionId` vs `frameId` — `z.union` over two object
 * shapes makes the discriminator implicit (both fields are required
 * within their respective branch). Using `z.union` (rather than
 * `z.discriminatedUnion`) keeps the on-the-wire payload simple — the
 * caller does not have to send a literal `kind` field that mirrors
 * the field names.
 *
 * `frameId` accepts both `string` and `number` to match the upstream
 * MCP contract: ScreenPipe surfaces frame IDs as integers, but some
 * clients pass them through as strings (URL parameters, JSON without
 * `JSON.parse`).
 */
const inputSchema = z.object({
  target: z.union([
    z.object({ sessionId: z.string().min(1) }),
    z.object({ frameId: z.union([z.string().min(1), z.number()]) })
  ])
});

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const evidenceItemSchema = z.object({
  frameId: z.union([z.string(), z.number()]),
  sessionId: z.string().optional(),
  appName: z.string().optional(),
  contextLabel: z.string(),
  extractedText: z.string(),
  timestamp: z.string(),
  sourceTypes: z.array(z.string())
});

const sessionItemSchema = z.object({
  sessionId: z.string(),
  appName: z.string(),
  contextLabel: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  activeSeconds: z.number().int().nonnegative(),
  evidenceFrameIds: z.array(z.union([z.string(), z.number()])),
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

const outputSchema = z.union([
  z.object({
    kind: z.literal('session'),
    session: sessionItemSchema.nullable(),
    evidence: z.array(evidenceItemSchema),
    narrativeText: z.string()
  }),
  z.object({
    kind: z.literal('frame'),
    frame: z
      .object({
        frameId: z.union([z.string(), z.number()]),
        timestamp: z.string(),
        appName: z.string().optional(),
        windowName: z.string().optional(),
        accessibilityTreeJson: z.string().nullable()
      })
      .nullable(),
    extractedContent: evidenceItemSchema.partial().nullable(),
    narrativeText: z.string()
  })
]);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

type InspectToolInput = z.infer<typeof inputSchema>;

export function registerInspectTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'inspect',
    {
      title: 'Inspect Screen Session or Frame',
      description:
        'Deep-dive into one screen-activity session or one captured screen frame from local screen-capture ' +
        'memory, identified by an id you already obtained from `recall` or `find`. Returns the session row ' +
        'plus per-frame evidence (session), or the raw accessibility tree plus derived extraction (frame). ' +
        'This is a drill-down on already-captured screen data, not a search or an external lookup.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async (input: InspectToolInput): Promise<CallToolResult> => {
      const inspectService = app.services.workActivity.inspect;
      const target = toServiceTarget(input);

      let result: InspectResult;
      try {
        result = await inspectService.inspect(target);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        app.logger.warn('inspect tool failed; returning degraded result', {
          message
        });
        // Failure shape mirrors `find.ts` and design.md "派生数据当前
        // 不可访问". Keep the structured payload schema-valid for both
        // session and frame branches by returning the session shape
        // (the simpler of the two), with `narrativeText` carrying the
        // operator-friendly diagnosis. R7.15 / W20: narrativeText
        // MUST always be a string.
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: '派生数据当前不可访问，请检查 ~/.canary-alpha-mcp/derived.sqlite。'
            }
          ],
          structuredContent: {
            kind: 'session',
            session: null,
            evidence: [],
            narrativeText:
              '派生数据当前不可访问，请检查 ~/.canary-alpha-mcp/derived.sqlite。'
          }
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: result.narrativeText.length > 0
              ? result.narrativeText
              : 'inspect: no narrative text generated.'
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
 * Converts the wire-format input into the discriminated union the
 * service expects. Mutual exclusivity is enforced by the input
 * schema (the union branches are disjoint), so we just pick the
 * branch present in the parsed payload.
 */
function toServiceTarget(input: InspectToolInput): InspectTarget {
  if ('sessionId' in input.target) {
    return { kind: 'session', sessionId: input.target.sessionId };
  }
  return { kind: 'frame', frameId: input.target.frameId };
}

function toStructuredContent(
  result: InspectResult
): Record<string, unknown> {
  if (result.kind === 'session') return sessionResultToStructured(result);
  return frameResultToStructured(result);
}

function sessionResultToStructured(
  result: InspectSessionResult
): Record<string, unknown> {
  return {
    kind: 'session',
    session: result.session === null ? null : sessionItemToStructured(result.session),
    evidence: result.evidence.map((item) => evidenceItemToStructured(item)),
    narrativeText: result.narrativeText
  };
}

function frameResultToStructured(
  result: InspectFrameResult
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: 'frame',
    frame:
      result.frame === null
        ? null
        : {
            frameId: result.frame.frameId,
            timestamp: result.frame.timestamp,
            appName: result.frame.appName,
            windowName: result.frame.windowName,
            accessibilityTreeJson: result.frame.accessibilityTreeJson
          },
    extractedContent:
      result.extractedContent === null
        ? null
        : {
            frameId: result.extractedContent.frameId,
            appName: result.extractedContent.appName,
            contextLabel: result.extractedContent.contextLabel,
            extractedText: result.extractedContent.extractedText,
            timestamp: result.extractedContent.timestamp,
            sourceTypes: result.extractedContent.sourceTypes
          },
    narrativeText: result.narrativeText
  };
  // Strip undefined entries from the optional fields so the
  // serialised JSON does not carry explicit `undefined`s.
  if (out.frame !== null) {
    const frame = out.frame as Record<string, unknown>;
    if (frame.appName === undefined) delete frame.appName;
    if (frame.windowName === undefined) delete frame.windowName;
  }
  if (out.extractedContent !== null) {
    const ec = out.extractedContent as Record<string, unknown>;
    if (ec.appName === undefined) delete ec.appName;
  }
  return out;
}

function sessionItemToStructured(
  session: NonNullable<InspectSessionResult['session']>
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    sessionId: session.sessionId,
    appName: session.appName,
    contextLabel: session.contextLabel,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    activeSeconds: session.activeSeconds,
    evidenceFrameIds: session.evidenceFrameIds,
    sourceTypes: session.sourceTypes
  };
  if (session.summary !== undefined) {
    out.summary = session.summary;
  }
  return out;
}

function evidenceItemToStructured(
  item: InspectSessionResult['evidence'][number]
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    frameId: item.frameId,
    sessionId: item.sessionId,
    contextLabel: item.contextLabel,
    extractedText: item.extractedText,
    timestamp: item.timestamp,
    sourceTypes: item.sourceTypes
  };
  if (item.appName !== undefined) out.appName = item.appName;
  return out;
}
