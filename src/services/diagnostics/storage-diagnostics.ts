import { basename, join } from 'node:path';

import {
  LOG_DIRECTORY_NAME,
  MEMORY_DIRECTORY_NAME,
  PRIVACY_STATE_FILE_NAME,
  REBUILD_LOCK_FILE_NAME,
  RUNTIME_REGISTRY_DIRECTORY_NAME,
  resolveAppDirectory,
  resolveRetrievalArtifactsDirectory,
  resolveScreenpipeDirectory
} from '../../config/paths.js';
import type {
  AppConfig,
  StorageArtifactClass,
  StorageArtifactUsage,
  StorageDiagnosticsPaths,
  StorageDiagnosticsReport
} from '../../types/app-config.js';

import type { MeasuredPath } from './screenpipe/path-usage.js';
import { computeAggregateBytes, computePathBytes, computeScreenpipeLogBytes } from './screenpipe/path-usage.js';
import { inspectScreenpipeSqliteDeep } from './screenpipe/inspection.js';

// ---------------------------------------------------------------------------
// Re-exports — preserve the original public API so consumers need zero changes
// ---------------------------------------------------------------------------

export { inspectScreenpipeSqlite, inspectScreenpipeSqliteDeep } from './screenpipe/inspection.js';

// Parser re-exports (needed by future unit tests)
export { parseDominantTableRows, parseTabSeparatedRow } from './screenpipe/sqlite-cli.js';
export { parseHotspotFields, parseHotspotApps, parseHotspotAccessibilityRoles, classifyAttributionBucket } from './screenpipe/hotspots.js';
export { parseRecentHeavyGrowthSummary, parseRecentHeavyGrowthSamples, parseRecentHeavyGrowthTimeSlices } from './screenpipe/heavy-growth.js';
export { parseDuplicationSummary, parseElementDuplicationSummary, parseDuplicateGroups, parseElementDuplicateGroups } from './screenpipe/duplication.js';
export { parseSchemaColumns, parseCaptureReuseRows } from './screenpipe/capture-reuse.js';

// ---------------------------------------------------------------------------
// Artifact model + collection + formatting
// ---------------------------------------------------------------------------

type StorageDiagnosticsOptions = {
  appDirectory?: string;
  retrievalArtifactsDirectory?: string;
  screenpipeDirectory?: string;
  vectorStore?: AppConfig['vectorStore'];
};

interface StorageArtifactDefinition {
  key: StorageArtifactClass;
  label: string;
  resolveLocation(paths: StorageDiagnosticsPaths): string;
  measure(paths: StorageDiagnosticsPaths): Promise<MeasuredPath>;
}

function buildDiagnosticsPaths(options: StorageDiagnosticsOptions = {}): StorageDiagnosticsPaths {
  return {
    appDirectory: options.appDirectory ?? resolveAppDirectory(),
    retrievalArtifactsDirectory: options.retrievalArtifactsDirectory ?? resolveRetrievalArtifactsDirectory(options.vectorStore),
    screenpipeDirectory: options.screenpipeDirectory ?? resolveScreenpipeDirectory()
  };
}

function createFileArtifact(
  key: StorageArtifactClass,
  label: string,
  relativePath: (paths: StorageDiagnosticsPaths) => string
): StorageArtifactDefinition {
  return {
    key,
    label,
    resolveLocation: relativePath,
    async measure(paths) {
      return computePathBytes(relativePath(paths));
    }
  };
}

function createAggregateArtifact(
  key: StorageArtifactClass,
  label: string,
  location: (paths: StorageDiagnosticsPaths) => string,
  measure: (paths: StorageDiagnosticsPaths) => Promise<MeasuredPath>
): StorageArtifactDefinition {
  return {
    key,
    label,
    resolveLocation: location,
    measure
  };
}

const ARTIFACT_DEFINITIONS: StorageArtifactDefinition[] = [
  createFileArtifact('screenpipe-sqlite-main', 'Screenpipe SQLite main database', (paths) => join(paths.screenpipeDirectory, 'db.sqlite')),
  createFileArtifact('screenpipe-sqlite-wal', 'Screenpipe SQLite WAL', (paths) => join(paths.screenpipeDirectory, 'db.sqlite-wal')),
  createFileArtifact('screenpipe-sqlite-shm', 'Screenpipe SQLite SHM', (paths) => join(paths.screenpipeDirectory, 'db.sqlite-shm')),
  createFileArtifact('screenpipe-data', 'Screenpipe data directory', (paths) => join(paths.screenpipeDirectory, 'data')),
  createFileArtifact('screenpipe-pi-agent', 'Screenpipe pi-agent directory', (paths) => join(paths.screenpipeDirectory, 'pi-agent')),
  createAggregateArtifact(
    'screenpipe-logs',
    'Screenpipe logs',
    (paths) => paths.screenpipeDirectory,
    async (paths) => computeScreenpipeLogBytes(paths.screenpipeDirectory)
  ),
  createFileArtifact('mcp-vector-store', 'MCP vector store', (paths) => join(paths.retrievalArtifactsDirectory, 'vector-store.json')),
  createFileArtifact('mcp-checkpoint', 'MCP retrieval checkpoint', (paths) => join(paths.retrievalArtifactsDirectory, 'retrieval-checkpoint.json')),
  createAggregateArtifact(
    'mcp-runtime-state',
    'MCP runtime state',
    (paths) => paths.appDirectory,
    async (paths) => computeAggregateBytes([
      join(paths.appDirectory, PRIVACY_STATE_FILE_NAME),
      join(paths.retrievalArtifactsDirectory, REBUILD_LOCK_FILE_NAME),
      join(paths.retrievalArtifactsDirectory, RUNTIME_REGISTRY_DIRECTORY_NAME)
    ])
  ),
  createFileArtifact('mcp-logs', 'MCP logs', (paths) => join(paths.appDirectory, LOG_DIRECTORY_NAME)),
  createFileArtifact('mcp-memory', 'MCP memory store', (paths) => join(paths.appDirectory, MEMORY_DIRECTORY_NAME))
];

function toArtifactUsage(definition: StorageArtifactDefinition, location: string, measurement: MeasuredPath): StorageArtifactUsage {
  return {
    key: definition.key,
    label: definition.label,
    location,
    bytes: measurement.bytes,
    exists: measurement.exists
  };
}

export async function collectStorageDiagnostics(options: StorageDiagnosticsOptions = {}): Promise<StorageDiagnosticsReport> {
  const paths = buildDiagnosticsPaths(options);
  const artifacts: StorageArtifactUsage[] = [];

  for (const definition of ARTIFACT_DEFINITIONS) {
    const location = definition.resolveLocation(paths);
    const measurement = await definition.measure(paths);
    artifacts.push(toArtifactUsage(definition, location, measurement));
  }

  const dominantArtifacts = [...artifacts]
    .sort((left, right) => right.bytes - left.bytes || left.key.localeCompare(right.key));
  const screenpipeSqlite = await inspectScreenpipeSqliteDeep(paths.screenpipeDirectory);

  return {
    generatedAt: new Date().toISOString(),
    totalBytes: artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
    artifacts,
    dominantArtifacts,
    paths,
    screenpipeSqlite
  };
}

export function formatStorageDiagnosticsReport(report: StorageDiagnosticsReport): string {
  const lines = [
    'Screenpipe storage diagnostics',
    '==============================',
    `Generated: ${report.generatedAt}`,
    `Total bytes: ${report.totalBytes}`,
    '',
    'Dominant artifact classes:'
  ];

  for (const artifact of report.dominantArtifacts) {
    const suffix = artifact.exists ? '' : ' [missing]';
    lines.push(`- ${artifact.label}: ${artifact.bytes} bytes (${artifact.location})${suffix}`);
  }

  lines.push('', 'Screenpipe SQLite tables:');
  lines.push(`- Inspection: ${report.screenpipeSqlite.inspectionStatus}`);
  lines.push(`- Database: ${report.screenpipeSqlite.databasePath}`);
  lines.push(`- Total bytes: ${report.screenpipeSqlite.totalBytes}`);

  if (report.screenpipeSqlite.reason) {
    lines.push(`- Reason: ${report.screenpipeSqlite.reason}`);
  }

  if (report.screenpipeSqlite.byteAttribution && report.screenpipeSqlite.byteAttribution.buckets.length > 0) {
    lines.push('- Byte attribution:');
    for (const bucket of report.screenpipeSqlite.byteAttribution.buckets) {
      const tableSuffix = bucket.tables.length > 0 ? ` [${bucket.tables.join(', ')}]` : '';
      lines.push(`  - ${bucket.label}: ${bucket.estimatedBytes} bytes${tableSuffix}`);
    }
  }

  if (report.screenpipeSqlite.dominantTables.length === 0) {
    lines.push('- Dominant tables: unavailable');
  } else {
    lines.push('- Dominant tables:');
    for (const table of report.screenpipeSqlite.dominantTables) {
      lines.push(`  - ${table.name}: ${table.estimatedBytes} bytes`);
    }
  }

  if (report.screenpipeSqlite.hotspots) {
    lines.push('', 'Screenpipe storage hotspots:');
    lines.push(`- Inspection: ${report.screenpipeSqlite.hotspots.inspectionStatus}`);
    if (report.screenpipeSqlite.hotspots.reason) {
      lines.push(`- Reason: ${report.screenpipeSqlite.hotspots.reason}`);
    }

    if (report.screenpipeSqlite.hotspots.dominantFields.length === 0) {
      lines.push('- Dominant fields: unavailable');
    } else {
      lines.push('- Dominant fields:');
      for (const field of report.screenpipeSqlite.hotspots.dominantFields) {
        lines.push(`  - ${field.key}: ${field.estimatedBytes} bytes across ${field.sampledRows} rows`);
      }
    }

    if (report.screenpipeSqlite.hotspots.dominantApps.length === 0) {
      lines.push('- Dominant apps: unavailable');
    } else {
      lines.push('- Dominant apps:');
      for (const app of report.screenpipeSqlite.hotspots.dominantApps) {
        lines.push(`  - ${app.appName || '[unknown app]'}: ${app.estimatedBytes} bytes`);
      }
    }

    if (report.screenpipeSqlite.hotspots.dominantAccessibilityRoles.length === 0) {
      lines.push('- Dominant accessibility roles: unavailable');
    } else {
      lines.push('- Dominant accessibility roles:');
      for (const role of report.screenpipeSqlite.hotspots.dominantAccessibilityRoles) {
        lines.push(`  - ${role.source}/${role.role || '[unknown role]'}: ${role.estimatedBytes} bytes across ${role.sampledRows} rows`);
      }
    }
  }

  const recentTextDuplication = report.screenpipeSqlite.recentTextDuplication;
  if (recentTextDuplication) {
    lines.push('', 'Recent text duplication sample:');
    lines.push(`- Inspection: ${recentTextDuplication.inspectionStatus}`);
    lines.push(`- Window minutes: ${recentTextDuplication.windowMinutes}`);
    lines.push(`- Minimum text length: ${recentTextDuplication.minTextLength}`);
    if (recentTextDuplication.reason) {
      lines.push(`- Reason: ${recentTextDuplication.reason}`);
    }

    if (recentTextDuplication.sources.length === 0) {
      lines.push('- Sources: unavailable');
    } else {
      for (const source of recentTextDuplication.sources) {
        lines.push(`- ${source.label}: ${source.duplicateRows}/${source.sampledRows} sampled rows across ${source.duplicateGroups} duplicate groups; redundant chars ${source.redundantCharacters}`);
        if (source.reason) {
          lines.push(`  - Reason: ${source.reason}`);
        }
        for (const group of source.topGroups) {
          const appLabel = group.appName || '[unknown app]';
          const windowLabel = group.windowName || '[unknown window]';
          lines.push(`  - ${appLabel} / ${windowLabel}: ${group.occurrences}x (${group.textLength} chars) "${group.textPreview}"`);
        }
      }
    }
  }

  const recentElementDuplication = report.screenpipeSqlite.recentElementDuplication;
  if (recentElementDuplication) {
    lines.push('', 'Recent accessibility element duplication:');
    lines.push(`- Inspection: ${recentElementDuplication.inspectionStatus}`);
    lines.push(`- Window minutes: ${recentElementDuplication.windowMinutes}`);
    lines.push(`- Minimum text length: ${recentElementDuplication.minTextLength}`);
    lines.push(`- Sampled rows: ${recentElementDuplication.sampledRows}`);
    lines.push(`- Distinct elements: ${recentElementDuplication.distinctElements}`);
    lines.push(`- Duplicate groups: ${recentElementDuplication.duplicateGroups}`);
    lines.push(`- Duplicate rows: ${recentElementDuplication.duplicateRows}`);
    lines.push(`- Sampled bytes: ${recentElementDuplication.sampledBytes}`);
    lines.push(`- Redundant bytes: ${recentElementDuplication.redundantBytes}`);
    if (recentElementDuplication.reason) {
      lines.push(`- Reason: ${recentElementDuplication.reason}`);
    }

    if (recentElementDuplication.topGroups.length === 0) {
      lines.push('- Top groups: unavailable');
    } else {
      lines.push('- Top groups:');
      for (const group of recentElementDuplication.topGroups) {
        const appLabel = group.appName || '[unknown app]';
        const windowLabel = group.windowName || '[unknown window]';
        lines.push(`  - ${appLabel} / ${windowLabel} / ${group.source || '[unknown source]'} / ${group.role || '[unknown role]'}: ${group.occurrences}x, ${group.estimatedBytes} bytes "${group.textPreview}"`);
      }
    }
  }

  const recentCaptureReuse = report.screenpipeSqlite.recentCaptureReuse;
  if (recentCaptureReuse) {
    lines.push('', 'Recent capture/reuse signals:');
    lines.push(`- Inspection: ${recentCaptureReuse.inspectionStatus}`);
    lines.push(`- Window minutes: ${recentCaptureReuse.windowMinutes}`);
    lines.push(`- Coverage: ${recentCaptureReuse.coverage}`);
    if (recentCaptureReuse.reason) {
      lines.push(`- Reason: ${recentCaptureReuse.reason}`);
    }

    if (recentCaptureReuse.signals.length === 0) {
      lines.push('- Signals: unavailable');
    } else {
      lines.push('- Signals:');
      for (const signal of recentCaptureReuse.signals) {
        lines.push(`  - ${signal.label}: ${signal.matchedRows}/${signal.sampledRows} matched rows, ${signal.estimatedBytes} bytes`);
        if (signal.topValues.length === 0) {
          lines.push('    - Top values: unavailable');
        } else {
          for (const value of signal.topValues) {
            lines.push(`    - ${value.value || '[empty]'}: ${value.rows} rows, ${value.estimatedBytes} bytes`);
          }
        }
      }
    }
  }

  const recentHeavyGrowth = report.screenpipeSqlite.recentHeavyGrowth;
  if (recentHeavyGrowth) {
    lines.push('', 'Recent heavy growth sample:');
    lines.push(`- Inspection: ${recentHeavyGrowth.inspectionStatus}`);
    lines.push(`- Window minutes: ${recentHeavyGrowth.windowMinutes}`);
    lines.push(`- Sample limit: ${recentHeavyGrowth.sampleLimit}`);
    lines.push(`- Time slice minutes: ${recentHeavyGrowth.timeSliceMinutes}`);
    lines.push(`- Sampled rows: ${recentHeavyGrowth.sampledRows}`);
    lines.push(`- Sampled bytes: ${recentHeavyGrowth.sampledBytes}`);
    if (recentHeavyGrowth.reason) {
      lines.push(`- Reason: ${recentHeavyGrowth.reason}`);
    }

    if (recentHeavyGrowth.topSamples.length === 0) {
      lines.push('- Top samples: unavailable');
    } else {
      lines.push('- Top samples:');
      for (const sample of recentHeavyGrowth.topSamples) {
        const appLabel = sample.appName || '[unknown app]';
        const windowLabel = sample.windowName || '[unknown window]';
        lines.push(`  - ${appLabel} / ${windowLabel}: ${sample.estimatedBytes} bytes, ${sample.duplicateSignal}, "${sample.preview}"`);
      }
    }

    if (recentHeavyGrowth.topTimeSlices.length === 0) {
      lines.push('- Top time slices: unavailable');
    } else {
      lines.push('- Top time slices:');
      for (const slice of recentHeavyGrowth.topTimeSlices) {
        const appLabel = slice.appName || '[unknown app]';
        const windowLabel = slice.windowName || '[unknown window]';
        lines.push(`  - ${slice.bucketStart} / ${appLabel} / ${windowLabel}: ${slice.estimatedBytes} bytes across ${slice.samples} samples`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

export function summarizeDominantArtifacts(report: StorageDiagnosticsReport, limit = 3): string[] {
  return report.dominantArtifacts
    .slice(0, limit)
    .map((artifact) => `${artifact.label}: ${artifact.bytes} bytes at ${artifact.location}`);
}

export function inferArtifactClassFromPath(filePath: string): StorageArtifactClass | null {
  const fileName = basename(filePath);
  switch (fileName) {
    case 'db.sqlite':
      return 'screenpipe-sqlite-main';
    case 'db.sqlite-wal':
      return 'screenpipe-sqlite-wal';
    case 'db.sqlite-shm':
      return 'screenpipe-sqlite-shm';
    case 'vector-store.json':
      return 'mcp-vector-store';
    case 'retrieval-checkpoint.json':
      return 'mcp-checkpoint';
    case PRIVACY_STATE_FILE_NAME:
      return 'mcp-runtime-state';
    default:
      return null;
  }
}
