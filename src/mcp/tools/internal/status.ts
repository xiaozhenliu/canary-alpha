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

const outputSchema = z.object({
  status: z.literal('ok'),
  mode: z.enum(['stdio', 'http']),
  host: z.string(),
  port: z.number().int().positive(),
  pid: z.number().int().positive(),
  configFile: z.string(),
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
  })
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
      const structuredStatus = {
        status: status.status,
        mode: status.mode,
        host: status.host,
        port: status.port,
        pid: status.pid,
        configFile: status.configFile,
        retrieval: status.retrieval,
        screenpipeStorage: status.screenpipeStorage
      };

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
