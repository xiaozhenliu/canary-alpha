import type {
  ScreenpipeSqliteAttributionBucket,
  ScreenpipeStorageDiagnostics,
  ScreenpipeStorageHotspotAccessibilityRole,
  ScreenpipeStorageHotspotApp,
  ScreenpipeStorageHotspotField,
  ScreenpipeStorageHotspots,
  ScreenpipeStorageTableUsage
} from '../../../types/app-config.js';

import {
  execFileAsync,
  SQLITE3_BINARY,
  SCREENPIPE_STORAGE_DIAGNOSTIC_TIMEOUT_MS,
  SCREENPIPE_STORAGE_HOTSPOT_LIMIT
} from './sqlite-cli.js';

const SCREENPIPE_HOTSPOT_FIELDS_QUERY = [
  "SELECT 'frames.accessibility_tree_json' AS key, COALESCE(SUM(LENGTH(COALESCE(accessibility_tree_json, ''))), 0) AS estimated_bytes, COUNT(*) AS sampled_rows FROM frames",
  'UNION ALL',
  "SELECT 'elements.properties' AS key, COALESCE(SUM(LENGTH(COALESCE(properties, ''))), 0) AS estimated_bytes, COUNT(*) AS sampled_rows FROM elements",
  'UNION ALL',
  "SELECT 'elements.text' AS key, COALESCE(SUM(LENGTH(COALESCE(text, ''))), 0) AS estimated_bytes, COUNT(*) AS sampled_rows FROM elements",
  'UNION ALL',
  "SELECT 'frames.accessibility_text' AS key, COALESCE(SUM(LENGTH(COALESCE(accessibility_text, ''))), 0) AS estimated_bytes, COUNT(*) AS sampled_rows FROM frames",
  'UNION ALL',
  "SELECT 'frames.full_text' AS key, COALESCE(SUM(LENGTH(COALESCE(full_text, ''))), 0) AS estimated_bytes, COUNT(*) AS sampled_rows FROM frames",
  'ORDER BY estimated_bytes DESC, key ASC',
  `LIMIT ${SCREENPIPE_STORAGE_HOTSPOT_LIMIT};`
].join(' ');
const SCREENPIPE_HOTSPOT_APPS_QUERY = [
  'WITH app_bytes AS (',
  "  SELECT COALESCE(app_name, '') AS app_name, COALESCE(SUM(LENGTH(COALESCE(accessibility_tree_json, ''))), 0) AS estimated_bytes FROM frames GROUP BY COALESCE(app_name, '')",
  '  UNION ALL',
  "  SELECT COALESCE(f.app_name, '') AS app_name, COALESCE(SUM(LENGTH(COALESCE(e.text, '')) + LENGTH(COALESCE(e.properties, ''))), 0) AS estimated_bytes FROM elements e JOIN frames f ON f.id = e.frame_id GROUP BY COALESCE(f.app_name, '')",
  ')',
  'SELECT app_name, SUM(estimated_bytes) AS estimated_bytes FROM app_bytes GROUP BY app_name ORDER BY estimated_bytes DESC, app_name ASC',
  `LIMIT ${SCREENPIPE_STORAGE_HOTSPOT_LIMIT};`
].join(' ');
const SCREENPIPE_HOTSPOT_ACCESSIBILITY_ROLES_QUERY = [
  'SELECT',
  "  COALESCE(source, '') AS source,",
  "  COALESCE(role, '') AS role,",
  "  COALESCE(SUM(LENGTH(COALESCE(text, '')) + LENGTH(COALESCE(properties, ''))), 0) AS estimated_bytes,",
  '  COUNT(*) AS sampled_rows',
  'FROM elements',
  "WHERE COALESCE(source, '') = 'accessibility'",
  "GROUP BY COALESCE(source, ''), COALESCE(role, '')",
  'ORDER BY estimated_bytes DESC, sampled_rows DESC, role ASC',
  `LIMIT ${SCREENPIPE_STORAGE_HOTSPOT_LIMIT};`
].join(' ');

export function parseHotspotFields(stdout: string): ScreenpipeStorageHotspotField[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string, string] => parts.length === 3)
    .map(([key, estimatedBytes, sampledRows]) => ({
      key,
      estimatedBytes: Number.parseInt(estimatedBytes, 10) || 0,
      sampledRows: Number.parseInt(sampledRows, 10) || 0
    }))
    .filter((field) => field.estimatedBytes > 0);
}

export function parseHotspotApps(stdout: string): ScreenpipeStorageHotspotApp[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([appName, estimatedBytes]) => ({
      appName,
      estimatedBytes: Number.parseInt(estimatedBytes, 10) || 0
    }))
    .filter((app) => app.estimatedBytes > 0);
}

export function parseHotspotAccessibilityRoles(stdout: string): ScreenpipeStorageHotspotAccessibilityRole[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string, string, string] => parts.length === 4)
    .map(([source, role, estimatedBytes, sampledRows]) => ({
      source,
      role,
      estimatedBytes: Number.parseInt(estimatedBytes, 10) || 0,
      sampledRows: Number.parseInt(sampledRows, 10) || 0
    }))
    .filter((role) => role.estimatedBytes > 0);
}

export async function inspectScreenpipeHotspots(databasePath: string): Promise<ScreenpipeStorageHotspots> {
  try {
    const [{ stdout: fieldsStdout }, { stdout: appsStdout }, { stdout: rolesStdout }] = await Promise.all([
      execFileAsync(SQLITE3_BINARY, ['-separator', '\t', databasePath, SCREENPIPE_HOTSPOT_FIELDS_QUERY], {
        timeout: SCREENPIPE_STORAGE_DIAGNOSTIC_TIMEOUT_MS
      }),
      execFileAsync(SQLITE3_BINARY, ['-separator', '\t', databasePath, SCREENPIPE_HOTSPOT_APPS_QUERY], {
        timeout: SCREENPIPE_STORAGE_DIAGNOSTIC_TIMEOUT_MS
      }),
      execFileAsync(SQLITE3_BINARY, ['-separator', '\t', databasePath, SCREENPIPE_HOTSPOT_ACCESSIBILITY_ROLES_QUERY], {
        timeout: SCREENPIPE_STORAGE_DIAGNOSTIC_TIMEOUT_MS
      })
    ]);

    return {
      inspectionStatus: 'ready',
      dominantFields: parseHotspotFields(fieldsStdout),
      dominantApps: parseHotspotApps(appsStdout),
      dominantAccessibilityRoles: parseHotspotAccessibilityRoles(rolesStdout)
    };
  } catch {
    return {
      inspectionStatus: 'degraded',
      reason: 'Screenpipe storage hotspot inspection timed out or failed.',
      dominantFields: [],
      dominantApps: [],
      dominantAccessibilityRoles: []
    };
  }
}

export function classifyAttributionBucket(tableName: string): ScreenpipeSqliteAttributionBucket['key'] {
  if (tableName === 'frames' || tableName.startsWith('frames_')) {
    return tableName.includes('_fts') ? 'fts' : 'frames';
  }

  if (tableName === 'elements' || tableName.startsWith('elements_')) {
    return tableName.includes('_fts') ? 'fts' : 'elements';
  }

  if (tableName.includes('_fts')) {
    return 'fts';
  }

  return 'other';
}

export function buildSqliteByteAttribution(
  totalBytes: number,
  tables: ScreenpipeStorageTableUsage[]
): ScreenpipeStorageDiagnostics['byteAttribution'] {
  const bucketLabels: Record<ScreenpipeSqliteAttributionBucket['key'], string> = {
    frames: 'Frame tables',
    elements: 'Element tables',
    fts: 'FTS tables',
    other: 'Other tables',
    unattributed: 'Unattributed bytes'
  };
  const bucketMap = new Map<ScreenpipeSqliteAttributionBucket['key'], ScreenpipeSqliteAttributionBucket>();

  for (const table of tables) {
    const key = classifyAttributionBucket(table.name);
    const bucket = bucketMap.get(key) ?? {
      key,
      label: bucketLabels[key],
      estimatedBytes: 0,
      tables: []
    };
    bucket.estimatedBytes += table.estimatedBytes;
    bucket.tables.push(table.name);
    bucketMap.set(key, bucket);
  }

  const attributedBytes = [...bucketMap.values()].reduce((total, bucket) => total + bucket.estimatedBytes, 0);
  const unattributedBytes = Math.max(totalBytes - attributedBytes, 0);

  const orderedKeys: ScreenpipeSqliteAttributionBucket['key'][] = ['frames', 'elements', 'fts', 'other'];
  const buckets = orderedKeys
    .map((key) => bucketMap.get(key))
    .filter((bucket): bucket is ScreenpipeSqliteAttributionBucket => bucket !== undefined);

  if (unattributedBytes > 0) {
    buckets.push({
      key: 'unattributed',
      label: bucketLabels.unattributed,
      estimatedBytes: unattributedBytes,
      tables: []
    });
  }

  return {
    buckets,
    attributedBytes,
    unattributedBytes
  };
}
