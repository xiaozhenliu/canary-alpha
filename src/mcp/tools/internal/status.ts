import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

import type { AppContext } from '../../../types/app-config.js';

const inputSchema = z.object({});

const screenpipeStorageTableUsageSchema = z.object({
  name: z.string(),
  estimatedBytes: z.number().int().nonnegative()
});

const screenpipeSqliteAttributionBucketSchema = z.object({
  key: z.enum(['frames', 'elements', 'fts', 'other', 'unattributed']),
  label: z.string(),
  estimatedBytes: z.number().int().nonnegative(),
  tables: z.array(z.string())
});

const screenpipeSqliteByteAttributionSchema = z.object({
  buckets: z.array(screenpipeSqliteAttributionBucketSchema),
  attributedBytes: z.number().int().nonnegative(),
  unattributedBytes: z.number().int().nonnegative()
});

const screenpipeStorageHotspotFieldSchema = z.object({
  key: z.string(),
  estimatedBytes: z.number().int().nonnegative(),
  sampledRows: z.number().int().nonnegative()
});

const screenpipeStorageHotspotAppSchema = z.object({
  appName: z.string(),
  estimatedBytes: z.number().int().nonnegative()
});

const screenpipeStorageHotspotAccessibilityRoleSchema = z.object({
  source: z.string(),
  role: z.string(),
  estimatedBytes: z.number().int().nonnegative(),
  sampledRows: z.number().int().nonnegative()
});

const screenpipeStorageHotspotsSchema = z.object({
  inspectionStatus: z.enum(['ready', 'degraded', 'unavailable']),
  reason: z.string().optional(),
  dominantFields: z.array(screenpipeStorageHotspotFieldSchema),
  dominantApps: z.array(screenpipeStorageHotspotAppSchema),
  dominantAccessibilityRoles: z.array(screenpipeStorageHotspotAccessibilityRoleSchema)
});

const screenpipeRecentTextDuplicateGroupSchema = z.object({
  appName: z.string(),
  windowName: z.string(),
  textPreview: z.string(),
  occurrences: z.number().int().nonnegative(),
  textLength: z.number().int().nonnegative()
});

const screenpipeRecentTextDuplicationSourceSchema = z.object({
  key: z.enum(['frame-full-text', 'frame-accessibility-text', 'ocr-text']),
  label: z.string(),
  inspectionStatus: z.enum(['ready', 'degraded']),
  reason: z.string().optional(),
  sampledRows: z.number().int().nonnegative(),
  distinctTexts: z.number().int().nonnegative(),
  duplicateGroups: z.number().int().nonnegative(),
  duplicateRows: z.number().int().nonnegative(),
  sampledCharacters: z.number().int().nonnegative(),
  redundantCharacters: z.number().int().nonnegative(),
  topGroups: z.array(screenpipeRecentTextDuplicateGroupSchema)
});

const screenpipeRecentTextDuplicationSchema = z.object({
  inspectionStatus: z.enum(['ready', 'degraded', 'unavailable']),
  reason: z.string().optional(),
  windowMinutes: z.number().int().nonnegative(),
  minTextLength: z.number().int().nonnegative(),
  analyzedAt: z.string(),
  sources: z.array(screenpipeRecentTextDuplicationSourceSchema)
});

const screenpipeRecentElementDuplicateGroupSchema = z.object({
  appName: z.string(),
  windowName: z.string(),
  source: z.string(),
  role: z.string(),
  textPreview: z.string(),
  occurrences: z.number().int().nonnegative(),
  estimatedBytes: z.number().int().nonnegative()
});

const screenpipeRecentElementDuplicationSchema = z.object({
  inspectionStatus: z.enum(['ready', 'degraded', 'unavailable']),
  reason: z.string().optional(),
  windowMinutes: z.number().int().nonnegative(),
  minTextLength: z.number().int().nonnegative(),
  analyzedAt: z.string(),
  sampledRows: z.number().int().nonnegative(),
  distinctElements: z.number().int().nonnegative(),
  duplicateGroups: z.number().int().nonnegative(),
  duplicateRows: z.number().int().nonnegative(),
  sampledBytes: z.number().int().nonnegative(),
  redundantBytes: z.number().int().nonnegative(),
  topGroups: z.array(screenpipeRecentElementDuplicateGroupSchema)
});

const screenpipeRecentCaptureReuseValueSummarySchema = z.object({
  value: z.string(),
  rows: z.number().int().nonnegative(),
  estimatedBytes: z.number().int().nonnegative()
});

const screenpipeRecentCaptureReuseSignalSchema = z.object({
  key: z.enum(['capture-trigger', 'element-reuse']),
  label: z.string(),
  sampledRows: z.number().int().nonnegative(),
  matchedRows: z.number().int().nonnegative(),
  estimatedBytes: z.number().int().nonnegative(),
  topValues: z.array(screenpipeRecentCaptureReuseValueSummarySchema)
});

const screenpipeRecentCaptureReuseSchema = z.object({
  inspectionStatus: z.enum(['ready', 'degraded', 'unavailable']),
  reason: z.string().optional(),
  windowMinutes: z.number().int().nonnegative(),
  analyzedAt: z.string(),
  coverage: z.enum(['supported', 'partial', 'unsupported']),
  signals: z.array(screenpipeRecentCaptureReuseSignalSchema)
});

const captureStatusSchema = z.object({
  state: z.enum(['ok', 'idle', 'process-down', 'permissions-missing', 'unknown']),
  lastFrameTimestamp: z.string().optional(),
  livenessThresholdSeconds: z.number().int().positive(),
  reason: z.string().optional()
});

const ingestionMixSchema = z.object({
  windowSeconds: z.number().int().positive(),
  accessibilityCount: z.number().int().nonnegative(),
  ocrCount: z.number().int().nonnegative(),
  ratio: z.number().min(0).max(1)
});

const diskBudgetSchema = z.object({
  budgetBytes: z.number().int().nonnegative().nullable(),
  currentSizeBytes: z.number().int().nonnegative(),
  headroomBytes: z.number().int().nonnegative().nullable(),
  warning: z.string().optional()
});

// ---------------------------------------------------------------------------
// Work-activity-analysis blocks (design §9.1, task 9.2)
// ---------------------------------------------------------------------------

/**
 * `extraction` — most recent successful extraction timestamp plus the
 * ratio of `Empty_Extraction` rows in the trailing 24h window
 * (R2.1 / R2.2). `lastExtractedAt` is `null` until the first non-empty
 * extraction lands. `unextractedFrameRatio` is `0` on an empty sample
 * (the contract is "empty input ⇒ 0", not `NaN`). `totalFramesLast24h`
 * is the denominator the ratio was computed against — surfaced
 * verbatim per design §9.1 so callers can interpret the ratio
 * without re-querying the store.
 */
const extractionStatusSchema = z.object({
  lastExtractedAt: z.string().nullable(),
  unextractedFrameRatio: z.number().min(0).max(1),
  totalFramesLast24h: z.number().int().nonnegative()
});

/**
 * `sessions` — open / recently closed / 24h totals (R4.1 / R4.2).
 */
const sessionsStatusSchema = z.object({
  openSessionCount: z.number().int().nonnegative(),
  lastClosedAt: z.string().nullable(),
  totalSessionsLast24h: z.number().int().nonnegative()
});

/**
 * `summary` — aggregate counts of pending and failed/degraded session
 * summaries (R8.1). `failedCount` aggregates `'failed'` and
 * `'degraded'` per design §9.2.
 */
const summaryStatusSchema = z.object({
  pendingCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative()
});

/**
 * `providers.embedding` — wire identifier of the configured embedding
 * provider plus its most recent call outcome (R8.2). `kind` is
 * open-ended (`'openai-compatible'` / `'ollama'` / `'none'`); `status`
 * is `'unknown'` on a fresh bootstrap (W24).
 *
 * `lastErrorAt` is declared `nullable().optional()` per design §9.1
 * so a future caller that wants to emit an explicit `null` (rather
 * than omit the field) does not violate the schema. Today's
 * implementation only ever omits the field — both shapes are
 * accepted on the wire.
 */
const providersEmbeddingSchema = z.object({
  kind: z.string(),
  status: z.enum(['ok', 'unavailable', 'unknown']),
  lastErrorAt: z.string().nullable().optional(),
  lastLatencyMs: z.number().int().nonnegative().optional()
});

/**
 * `providers.summary` — user-configured summary provider plus its
 * most recent call outcome (R8.3 / W23). `kind` reflects the
 * configured provider, NOT any runtime fallback the worker is doing.
 *
 * `lastErrorAt` follows the same `nullable().optional()` shape as
 * `providers.embedding` for parity with design §9.1.
 */
const providersSummarySchema = z.object({
  kind: z.enum(['template', 'remote-llm']),
  status: z.enum(['ok', 'unavailable', 'unknown']),
  lastErrorAt: z.string().nullable().optional(),
  lastLatencyMs: z.number().int().nonnegative().optional()
});

const providersStatusSchema = z.object({
  embedding: providersEmbeddingSchema,
  summary: providersSummarySchema
});

/**
 * `degraded` — per-section degradation envelope (design §9 Error
 * Handling). Each key carries the error message captured at the
 * section boundary. The map is omitted entirely when every section
 * is healthy.
 */
const observabilityDegradedSchema = z.object({
  extraction: z.string().optional(),
  sessions: z.string().optional(),
  summary: z.string().optional(),
  providers: z.string().optional()
});

const outputSchema = z.object({
  status: z.literal('ok'),
  mode: z.enum(['stdio', 'http']),
  host: z.string(),
  port: z.number().int().positive(),
  pid: z.number().int().positive(),
  configFile: z.string(),
  capture: captureStatusSchema.optional(),
  ingestionMix: ingestionMixSchema.optional(),
  diskBudget: diskBudgetSchema.optional(),
  retrieval: z.object({
    checkpointExists: z.boolean(),
    checkpointTimestamp: z.string().optional(),
    vectorStoreKind: z.string(),
    recoveryStatus: z.enum(['ready', 'needs-rebuild', 'degraded'])
  }),
  screenpipeStorage: z.object({
    inspectionStatus: z.enum(['ready', 'degraded', 'unavailable']),
    reason: z.string().optional(),
    databasePath: z.string(),
    totalBytes: z.number().int().nonnegative(),
    dominantTables: z.array(screenpipeStorageTableUsageSchema),
    byteAttribution: screenpipeSqliteByteAttributionSchema.optional(),
    hotspots: screenpipeStorageHotspotsSchema.optional(),
    recentTextDuplication: screenpipeRecentTextDuplicationSchema.optional(),
    recentElementDuplication: screenpipeRecentElementDuplicationSchema.optional(),
    recentCaptureReuse: screenpipeRecentCaptureReuseSchema.optional()
  }),
  // Work-activity-analysis additions (design §9.1). All optional so a
  // partial bootstrap or a `WorkActivityObservabilityService` outage
  // collapses the four blocks rather than failing the whole tool.
  extraction: extractionStatusSchema.optional(),
  sessions: sessionsStatusSchema.optional(),
  summary: summaryStatusSchema.optional(),
  providers: providersStatusSchema.optional(),
  degraded: observabilityDegradedSchema.optional()
});

export function registerInternalStatusTool(server: McpServer, app: AppContext): void {
  server.registerTool(
    'internal-status',
    {
      title: 'Internal Status',
      description: 'Return bootstrap-safe runtime status for Phase 1 verification.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true
      }
    },
    async (): Promise<CallToolResult> => {
      const status = await app.services.bootstrapStatus.getStatus();
      const structuredStatus: Record<string, unknown> = {
        status: status.status,
        mode: status.mode,
        host: status.host,
        port: status.port,
        pid: status.pid,
        configFile: status.configFile,
        retrieval: status.retrieval,
        screenpipeStorage: status.screenpipeStorage
      };

      // Include the three new observability blocks when available.
      if (status.capture !== undefined) {
        structuredStatus['capture'] = status.capture;
      }
      if (status.ingestionMix !== undefined) {
        structuredStatus['ingestionMix'] = status.ingestionMix;
      }
      if (status.diskBudget !== undefined) {
        structuredStatus['diskBudget'] = status.diskBudget;
      }

      // Work-activity-analysis blocks (design §9.1, task 9.2). Each
      // is independently optional so a missing observability service
      // (partial bootstrap, test wiring, or service-level failure)
      // simply collapses the field — the upstream `screenpipeStorage`
      // / `retrieval` / `capture` / `ingestionMix` / `diskBudget`
      // contract stays intact (R2.3 / R4.3 / R8.6).
      if (status.extraction !== undefined) {
        structuredStatus['extraction'] = status.extraction;
      }
      if (status.sessions !== undefined) {
        structuredStatus['sessions'] = status.sessions;
      }
      if (status.summary !== undefined) {
        structuredStatus['summary'] = status.summary;
      }
      if (status.providers !== undefined) {
        structuredStatus['providers'] = status.providers;
      }
      if (status.degraded !== undefined) {
        structuredStatus['degraded'] = status.degraded;
      }

      return {
        content: [
          {
            type: 'text',
            text: `Server status is ${status.status} in ${status.mode} mode.`
          }
        ],
        structuredContent: structuredStatus
      };
    }
  );
}
