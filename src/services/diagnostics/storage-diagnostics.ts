import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

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
  ScreenpipeRecentCaptureReuseDiagnostics,
  ScreenpipeRecentCaptureReuseSignal,
  ScreenpipeRecentElementDuplicationDiagnostics,
  ScreenpipeRecentHeavyGrowthDiagnostics,
  ScreenpipeRecentHeavyGrowthSample,
  ScreenpipeRecentHeavyGrowthTimeSlice,
  ScreenpipeRecentTextDuplicationDiagnostics,
  ScreenpipeRecentTextDuplicationSource,
  ScreenpipeRecentTextDuplicationSourceKey,
  ScreenpipeSqliteAttributionBucket,
  ScreenpipeStorageDiagnostics,
  ScreenpipeStorageHotspotAccessibilityRole,
  ScreenpipeStorageHotspotApp,
  ScreenpipeStorageHotspotField,
  ScreenpipeStorageHotspots,
  ScreenpipeStorageTableUsage,
  StorageArtifactClass,
  StorageArtifactUsage,
  StorageDiagnosticsPaths,
  StorageDiagnosticsReport
} from '../../types/app-config.js';

const execFileAsync = promisify(execFile);
const SQLITE3_BINARY = 'sqlite3';
const SCREENPIPE_STORAGE_BOOTSTRAP_TIMEOUT_MS = 250;
const SCREENPIPE_STORAGE_DIAGNOSTIC_TIMEOUT_MS = 30_000;
const SCREENPIPE_STORAGE_DOMINANT_TABLE_LIMIT = 3;
const SCREENPIPE_STORAGE_HOTSPOT_LIMIT = 5;
const SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES = 60;
const SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH = 24;
const SCREENPIPE_RECENT_TEXT_DUPLICATION_GROUP_LIMIT = 5;
const SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT = 1000;
const SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS = 5_000;
const SCREENPIPE_RECENT_HEAVY_GROWTH_TIME_SLICE_MINUTES = 10;
const SCREENPIPE_RECENT_HEAVY_GROWTH_SAMPLE_LIMIT = 5;
const SCREENPIPE_RECENT_HEAVY_GROWTH_TOP_SLICE_LIMIT = 5;
const SCREENPIPE_RECENT_HEAVY_GROWTH_TOP_SAMPLE_QUERY = [
  'WITH recent AS (',
  '  SELECT',
  '    id AS frame_id,',
  '    timestamp,',
  "    COALESCE(app_name, '') AS app_name,",
  "    COALESCE(window_name, '') AS window_name,",
  '    LENGTH(COALESCE(accessibility_tree_json, "")) + LENGTH(COALESCE(full_text, "")) + LENGTH(COALESCE(accessibility_text, "")) AS estimated_bytes,',
  '    COALESCE(full_text, accessibility_text, accessibility_tree_json, "") AS preview_source,',
  '    CASE',
  '      WHEN LENGTH(COALESCE(full_text, "")) > 0 THEN COALESCE(full_text, "")',
  '      WHEN LENGTH(COALESCE(accessibility_tree_json, "")) >= LENGTH(COALESCE(accessibility_text, "")) THEN COALESCE(accessibility_tree_json, "")',
  '      ELSE COALESCE(accessibility_text, "")',
  '    END AS dominant_payload',
  '  FROM frames',
  `  WHERE timestamp >= datetime('now', '-${SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES} minutes')`,
  '  ORDER BY timestamp DESC, id DESC',
  `  LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT}`,
  '), classified AS (',
  '  SELECT',
  '    frame_id,',
  '    timestamp,',
  '    app_name,',
  '    window_name,',
  '    estimated_bytes,',
  '    preview_source,',
  '    COUNT(*) OVER (PARTITION BY dominant_payload, app_name, window_name) AS duplicate_occurrences',
  '  FROM recent',
  ')',
  'SELECT',
  '  frame_id,',
  '  timestamp,',
  '  app_name,',
  '  window_name,',
  '  estimated_bytes,',
  '  CASE WHEN duplicate_occurrences > 1 THEN "duplicate-heavy" ELSE "unique-heavy" END AS duplicate_signal,',
  '  REPLACE(REPLACE(SUBSTR(preview_source, 1, 120), char(10), " "), char(13), " ") AS preview',
  'FROM classified',
  'WHERE estimated_bytes > 0',
  'ORDER BY CASE WHEN duplicate_occurrences = 1 THEN 0 ELSE 1 END ASC, estimated_bytes DESC, frame_id DESC',
  `LIMIT ${SCREENPIPE_RECENT_HEAVY_GROWTH_SAMPLE_LIMIT};`
].join(' ');
const SCREENPIPE_RECENT_HEAVY_GROWTH_SUMMARY_QUERY = [
  'WITH recent AS (',
  '  SELECT',
  '    id AS frame_id,',
  '    timestamp,',
  "    COALESCE(app_name, '') AS app_name,",
  "    COALESCE(window_name, '') AS window_name,",
  '    LENGTH(COALESCE(accessibility_tree_json, \"\")) + LENGTH(COALESCE(full_text, \"\")) + LENGTH(COALESCE(accessibility_text, \"\")) AS estimated_bytes',
  '  FROM frames',
  `  WHERE timestamp >= datetime('now', '-${SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES} minutes')`,
  '  ORDER BY timestamp DESC, id DESC',
  `  LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT}`,
  ')',
  'SELECT COUNT(*), COALESCE(SUM(estimated_bytes), 0) FROM recent WHERE estimated_bytes > 0;'
].join(' ');
const SCREENPIPE_RECENT_HEAVY_GROWTH_TIME_SLICES_QUERY = [
  'WITH recent AS (',
  '  SELECT',
  '    timestamp,',
  "    COALESCE(app_name, '') AS app_name,",
  "    COALESCE(window_name, '') AS window_name,",
  '    LENGTH(COALESCE(accessibility_tree_json, \"\")) + LENGTH(COALESCE(full_text, \"\")) + LENGTH(COALESCE(accessibility_text, \"\")) AS estimated_bytes',
  '  FROM frames',
  `  WHERE timestamp >= datetime('now', '-${SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES} minutes')`,
  '  ORDER BY timestamp DESC, id DESC',
  `  LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT}`,
  '), sliced AS (',
  '  SELECT',
  `    strftime('%Y-%m-%dT%H:', timestamp) || printf('%02d:00Z', (CAST(strftime('%M', timestamp) AS INTEGER) / ${SCREENPIPE_RECENT_HEAVY_GROWTH_TIME_SLICE_MINUTES}) * ${SCREENPIPE_RECENT_HEAVY_GROWTH_TIME_SLICE_MINUTES}) AS bucket_start,`,
  '    app_name,',
  '    window_name,',
  '    estimated_bytes',
  '  FROM recent',
  '  WHERE estimated_bytes > 0',
  ')',
  'SELECT bucket_start, app_name, window_name, SUM(estimated_bytes) AS estimated_bytes, COUNT(*) AS samples',
  'FROM sliced',
  'GROUP BY bucket_start, app_name, window_name',
  'ORDER BY estimated_bytes DESC, samples DESC, bucket_start DESC',
  `LIMIT ${SCREENPIPE_RECENT_HEAVY_GROWTH_TOP_SLICE_LIMIT};`
].join(' ');

const SQLITE_DBSTAT_QUERY = [
  'CREATE VIRTUAL TABLE temp.stat USING dbstat(main);',
  'SELECT name || char(9) || SUM(pgsize)',
  'FROM temp.stat',
  "WHERE aggregate = FALSE AND name NOT LIKE 'sqlite_%'",
  'GROUP BY name',
  'ORDER BY SUM(pgsize) DESC, name ASC;'
].join(' ');
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
  'GROUP BY COALESCE(source, \'\'), COALESCE(role, \'\')',
  'ORDER BY estimated_bytes DESC, sampled_rows DESC, role ASC',
  `LIMIT ${SCREENPIPE_STORAGE_HOTSPOT_LIMIT};`
].join(' ');
const FRAME_FULL_TEXT_DUPLICATION_QUERY = [
  'WITH recent AS (',
  '  SELECT',
  "    COALESCE(app_name, '') AS app_name,",
  "    COALESCE(window_name, '') AS window_name,",
  '    full_text AS text_value,',
  '    LENGTH(full_text) AS text_length',
  '  FROM frames',
  `  WHERE timestamp >= datetime('now', '-${SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES} minutes')`,
  `    AND full_text IS NOT NULL AND LENGTH(full_text) >= ${SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH}`,
  '  ORDER BY timestamp DESC',
  `  LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT}`,
  ')',
  'SELECT',
  '  COUNT(*) AS sampled_rows,',
  '  COUNT(DISTINCT text_value) AS distinct_texts,',
  '  COALESCE(SUM(text_length), 0) AS sampled_characters',
  'FROM recent;'
].join(' ');
const FRAME_FULL_TEXT_DUPLICATION_GROUPS_QUERY = [
  'WITH recent AS (',
  '  SELECT',
  "    COALESCE(app_name, '') AS app_name,",
  "    COALESCE(window_name, '') AS window_name,",
  '    full_text AS text_value,',
  '    LENGTH(full_text) AS text_length',
  '  FROM frames',
  `  WHERE timestamp >= datetime('now', '-${SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES} minutes')`,
  `    AND full_text IS NOT NULL AND LENGTH(full_text) >= ${SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH}`,
  '  ORDER BY timestamp DESC',
  `  LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT}`,
  ')',
  'SELECT',
  '  app_name,',
  '  window_name,',
  '  REPLACE(REPLACE(SUBSTR(text_value, 1, 120), char(10), " "), char(13), " ") AS text_preview,',
  '  COUNT(*) AS occurrences,',
  '  MAX(text_length) AS text_length',
  'FROM recent',
  'GROUP BY text_value, app_name, window_name',
  'HAVING COUNT(*) > 1',
  'ORDER BY occurrences DESC, text_length DESC, app_name ASC, window_name ASC',
  `LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_GROUP_LIMIT};`
].join(' ');
const FRAME_ACCESSIBILITY_DUPLICATION_QUERY = [
  'WITH recent AS (',
  '  SELECT',
  "    COALESCE(app_name, '') AS app_name,",
  "    COALESCE(window_name, '') AS window_name,",
  '    accessibility_text AS text_value,',
  '    LENGTH(accessibility_text) AS text_length',
  '  FROM frames',
  `  WHERE timestamp >= datetime('now', '-${SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES} minutes')`,
  `    AND accessibility_text IS NOT NULL AND LENGTH(accessibility_text) >= ${SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH}`,
  '  ORDER BY timestamp DESC',
  `  LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT}`,
  ')',
  'SELECT',
  '  COUNT(*) AS sampled_rows,',
  '  COUNT(DISTINCT text_value) AS distinct_texts,',
  '  COALESCE(SUM(text_length), 0) AS sampled_characters',
  'FROM recent;'
].join(' ');
const FRAME_ACCESSIBILITY_DUPLICATION_GROUPS_QUERY = [
  'WITH recent AS (',
  '  SELECT',
  "    COALESCE(app_name, '') AS app_name,",
  "    COALESCE(window_name, '') AS window_name,",
  '    accessibility_text AS text_value,',
  '    LENGTH(accessibility_text) AS text_length',
  '  FROM frames',
  `  WHERE timestamp >= datetime('now', '-${SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES} minutes')`,
  `    AND accessibility_text IS NOT NULL AND LENGTH(accessibility_text) >= ${SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH}`,
  '  ORDER BY timestamp DESC',
  `  LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT}`,
  ')',
  'SELECT',
  '  app_name,',
  '  window_name,',
  '  REPLACE(REPLACE(SUBSTR(text_value, 1, 120), char(10), " "), char(13), " ") AS text_preview,',
  '  COUNT(*) AS occurrences,',
  '  MAX(text_length) AS text_length',
  'FROM recent',
  'GROUP BY text_value, app_name, window_name',
  'HAVING COUNT(*) > 1',
  'ORDER BY occurrences DESC, text_length DESC, app_name ASC, window_name ASC',
  `LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_GROUP_LIMIT};`
].join(' ');
const OCR_TEXT_DUPLICATION_QUERY = [
  'WITH recent AS (',
  '  SELECT',
  "    COALESCE(app_name, '') AS app_name,",
  "    COALESCE(window_name, '') AS window_name,",
  '    text AS text_value,',
  '    LENGTH(text) AS text_length',
  '  FROM ocr_text',
  `  WHERE rowid IN (SELECT rowid FROM ocr_text ORDER BY frame_id DESC LIMIT 5000)`,
  `    AND text IS NOT NULL AND LENGTH(text) >= ${SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH}`,
  ')',
  'SELECT',
  '  COUNT(*) AS sampled_rows,',
  '  COUNT(DISTINCT text_value) AS distinct_texts,',
  '  COALESCE(SUM(text_length), 0) AS sampled_characters',
  'FROM recent;'
].join(' ');
const OCR_TEXT_DUPLICATION_GROUPS_QUERY = [
  'WITH recent AS (',
  '  SELECT',
  "    COALESCE(app_name, '') AS app_name,",
  "    COALESCE(window_name, '') AS window_name,",
  '    text AS text_value,',
  '    LENGTH(text) AS text_length',
  '  FROM ocr_text',
  `  WHERE rowid IN (SELECT rowid FROM ocr_text ORDER BY frame_id DESC LIMIT 5000)`,
  `    AND text IS NOT NULL AND LENGTH(text) >= ${SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH}`,
  ')',
  'SELECT',
  '  app_name,',
  '  window_name,',
  '  REPLACE(REPLACE(SUBSTR(text_value, 1, 120), char(10), " "), char(13), " ") AS text_preview,',
  '  COUNT(*) AS occurrences,',
  '  MAX(text_length) AS text_length',
  'FROM recent',
  'GROUP BY text_value, app_name, window_name',
  'HAVING COUNT(*) > 1',
  'ORDER BY occurrences DESC, text_length DESC, app_name ASC, window_name ASC',
  `LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_GROUP_LIMIT};`
].join(' ');
const SCREENPIPE_RECENT_ELEMENT_DUPLICATION_SUMMARY_QUERY = [
  'WITH recent AS (',
  '  SELECT',
  "    COALESCE(f.app_name, '') AS app_name,",
  "    COALESCE(f.window_name, '') AS window_name,",
  "    COALESCE(e.source, '') AS source,",
  "    COALESCE(e.role, '') AS role,",
  "    COALESCE(e.text, '') AS text_value,",
  '    LENGTH(COALESCE(e.text, \'\')) + LENGTH(COALESCE(e.properties, \'\')) AS estimated_bytes',
  '  FROM elements e',
  '  JOIN frames f ON f.id = e.frame_id',
  `  WHERE f.timestamp >= datetime('now', '-${SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES} minutes')`,
  "    AND COALESCE(e.source, '') = 'accessibility'",
  `    AND LENGTH(COALESCE(e.text, '')) >= ${SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH}`,
  '  ORDER BY f.timestamp DESC, e.id DESC',
  `  LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT}`,
  ')',
  'SELECT',
  '  COUNT(*) AS sampled_rows,',
  '  COUNT(DISTINCT app_name || char(31) || window_name || char(31) || source || char(31) || role) AS distinct_elements,',
  '  COALESCE(SUM(estimated_bytes), 0) AS sampled_bytes',
  'FROM recent;'
].join(' ');
const SCREENPIPE_RECENT_ELEMENT_DUPLICATION_GROUPS_QUERY = [
  'WITH recent AS (',
  '  SELECT',
  "    COALESCE(f.app_name, '') AS app_name,",
  "    COALESCE(f.window_name, '') AS window_name,",
  "    COALESCE(e.source, '') AS source,",
  "    COALESCE(e.role, '') AS role,",
  "    COALESCE(e.text, '') AS text_value,",
  '    LENGTH(COALESCE(e.text, \'\')) + LENGTH(COALESCE(e.properties, \'\')) AS estimated_bytes',
  '  FROM elements e',
  '  JOIN frames f ON f.id = e.frame_id',
  `  WHERE f.timestamp >= datetime('now', '-${SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES} minutes')`,
  "    AND COALESCE(e.source, '') = 'accessibility'",
  `    AND LENGTH(COALESCE(e.text, '')) >= ${SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH}`,
  '  ORDER BY f.timestamp DESC, e.id DESC',
  `  LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT}`,
  ')',
  'SELECT',
  '  app_name,',
  '  window_name,',
  '  source,',
  '  role,',
  '  MAX(REPLACE(REPLACE(SUBSTR(text_value, 1, 120), char(10), " "), char(13), " ")) AS text_preview,',
  '  COUNT(*) AS occurrences,',
  '  SUM(estimated_bytes) AS estimated_bytes',
  'FROM recent',
  'GROUP BY app_name, window_name, source, role',
  'HAVING COUNT(*) > 1',
  'ORDER BY estimated_bytes DESC, occurrences DESC, app_name ASC, window_name ASC, role ASC',
  `LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_GROUP_LIMIT};`
].join(' ');

type MeasuredPath = {
  bytes: number;
  exists: boolean;
};

type RecentTextDuplicationQueryDefinition = {
  groupsQuery: string;
  key: ScreenpipeRecentTextDuplicationSourceKey;
  label: string;
  summaryQuery: string;
};

type RecentTextDuplicationSummaryRow = {
  distinctTexts: number;
  sampledCharacters: number;
  sampledRows: number;
};

type RecentElementDuplicationSummaryRow = {
  distinctElements: number;
  sampledBytes: number;
  sampledRows: number;
};

type RecentHeavyGrowthSummaryRow = {
  sampledBytes: number;
  sampledRows: number;
};

type RecentHeavyGrowthSampleRow = {
  appName: string;
  duplicateSignal: ScreenpipeRecentHeavyGrowthSample['duplicateSignal'];
  estimatedBytes: number;
  frameId: number;
  preview: string;
  timestamp: string;
  windowName: string;
};

type RecentHeavyGrowthTimeSliceRow = {
  appName: string;
  bucketStart: string;
  estimatedBytes: number;
  samples: number;
  windowName: string;
};

type ScreenpipeSchemaColumnMap = Record<string, Set<string>>;

type CaptureReuseSignalDefinition = {
  column: string;
  key: ScreenpipeRecentCaptureReuseSignal['key'];
  label: string;
  rowEstimatedBytesExpression: string;
  sampledRowsQuery: string;
  table: 'elements' | 'frames';
};

type CaptureReuseSignalRow = {
  estimatedBytes: number;
  rows: number;
  value: string;
};

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

async function computePathBytes(targetPath: string): Promise<MeasuredPath> {
  try {
    const targetStats = await stat(targetPath);
    if (targetStats.isFile()) {
      return {
        bytes: targetStats.size,
        exists: true
      };
    }

    if (!targetStats.isDirectory()) {
      return {
        bytes: 0,
        exists: true
      };
    }

    const entries = await readdir(targetPath, { withFileTypes: true });
    let totalBytes = 0;

    for (const entry of entries) {
      const childPath = join(targetPath, entry.name);
      const childMeasurement = await computePathBytes(childPath);
      totalBytes += childMeasurement.bytes;
    }

    return {
      bytes: totalBytes,
      exists: true
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return {
        bytes: 0,
        exists: false
      };
    }

    throw error;
  }
}

async function computeAggregateBytes(paths: string[]): Promise<MeasuredPath> {
  let totalBytes = 0;
  let exists = false;

  for (const targetPath of paths) {
    const measurement = await computePathBytes(targetPath);
    totalBytes += measurement.bytes;
    exists ||= measurement.exists;
  }

  return {
    bytes: totalBytes,
    exists
  };
}

async function computeScreenpipeLogBytes(screenpipeDirectory: string): Promise<MeasuredPath> {
  try {
    const entries = await readdir(screenpipeDirectory, { withFileTypes: true });
    const logPaths = entries
      .filter((entry) => entry.isFile() && /^screenpipe\..+\.log$/u.test(entry.name))
      .map((entry) => join(screenpipeDirectory, entry.name));

    return computeAggregateBytes(logPaths);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return {
        bytes: 0,
        exists: false
      };
    }

    throw error;
  }
}

function parseDominantTableRows(stdout: string): ScreenpipeStorageTableUsage[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([name, estimatedBytes]) => ({
      name,
      estimatedBytes: Number.parseInt(estimatedBytes, 10)
    }))
    .filter((table) => Number.isInteger(table.estimatedBytes) && table.estimatedBytes >= 0);
}

function parseTabSeparatedRow(stdout: string): string[] | null {
  const line = stdout
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);

  if (!line) {
    return null;
  }

  return line.split('\t');
}

function parseDuplicationSummary(stdout: string): RecentTextDuplicationSummaryRow {
  const row = parseTabSeparatedRow(stdout);
  if (!row || row.length !== 3) {
    return {
      sampledRows: 0,
      distinctTexts: 0,
      sampledCharacters: 0
    };
  }

  const [sampledRows, distinctTexts, sampledCharacters] = row;
  return {
    sampledRows: Number.parseInt(sampledRows, 10) || 0,
    distinctTexts: Number.parseInt(distinctTexts, 10) || 0,
    sampledCharacters: Number.parseInt(sampledCharacters, 10) || 0
  };
}

function parseElementDuplicationSummary(stdout: string): RecentElementDuplicationSummaryRow {
  const row = parseTabSeparatedRow(stdout);
  if (!row || row.length !== 3) {
    return {
      sampledRows: 0,
      distinctElements: 0,
      sampledBytes: 0
    };
  }

  const [sampledRows, distinctElements, sampledBytes] = row;
  return {
    sampledRows: Number.parseInt(sampledRows, 10) || 0,
    distinctElements: Number.parseInt(distinctElements, 10) || 0,
    sampledBytes: Number.parseInt(sampledBytes, 10) || 0
  };
}

function parseDuplicateGroups(stdout: string): ScreenpipeRecentTextDuplicationSource['topGroups'] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string, string, string, string] => parts.length === 5)
    .map(([appName, windowName, textPreview, occurrences, textLength]) => ({
      appName,
      windowName,
      textPreview,
      occurrences: Number.parseInt(occurrences, 10) || 0,
      textLength: Number.parseInt(textLength, 10) || 0
    }))
    .filter((group) => group.occurrences > 1 && group.textLength >= SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH);
}

function parseElementDuplicateGroups(stdout: string): ScreenpipeRecentElementDuplicationDiagnostics['topGroups'] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string, string, string, string, string, string] => parts.length === 7)
    .map(([appName, windowName, source, role, textPreview, occurrences, estimatedBytes]) => ({
      appName,
      windowName,
      source,
      role,
      textPreview,
      occurrences: Number.parseInt(occurrences, 10) || 0,
      estimatedBytes: Number.parseInt(estimatedBytes, 10) || 0
    }))
    .filter((group) => group.occurrences > 1 && group.estimatedBytes > 0);
}

function parseHotspotFields(stdout: string): ScreenpipeStorageHotspotField[] {
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

function parseRecentHeavyGrowthSummary(stdout: string): RecentHeavyGrowthSummaryRow {
  const row = parseTabSeparatedRow(stdout);
  if (!row || row.length !== 2) {
    return {
      sampledRows: 0,
      sampledBytes: 0
    };
  }

  const [sampledRows, sampledBytes] = row;
  return {
    sampledRows: Number.parseInt(sampledRows, 10) || 0,
    sampledBytes: Number.parseInt(sampledBytes, 10) || 0
  };
}

function parseRecentHeavyGrowthSamples(stdout: string): ScreenpipeRecentHeavyGrowthDiagnostics['topSamples'] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string, string, string, string, string, string] => parts.length === 7)
    .map(([frameId, timestamp, appName, windowName, estimatedBytes, duplicateSignal, preview]) => ({
      frameId: Number.parseInt(frameId, 10) || 0,
      timestamp,
      appName,
      windowName,
      estimatedBytes: Number.parseInt(estimatedBytes, 10) || 0,
      duplicateSignal: (duplicateSignal === 'duplicate-heavy' ? 'duplicate-heavy' : 'unique-heavy') as ScreenpipeRecentHeavyGrowthSample['duplicateSignal'],
      preview
    }))
    .filter((sample) => sample.frameId > 0 && sample.estimatedBytes > 0);
}

function parseRecentHeavyGrowthTimeSlices(stdout: string): ScreenpipeRecentHeavyGrowthDiagnostics['topTimeSlices'] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string, string, string, string] => parts.length === 5)
    .map(([bucketStart, appName, windowName, estimatedBytes, samples]) => ({
      bucketStart,
      bucketMinutes: SCREENPIPE_RECENT_HEAVY_GROWTH_TIME_SLICE_MINUTES,
      estimatedBytes: Number.parseInt(estimatedBytes, 10) || 0,
      samples: Number.parseInt(samples, 10) || 0,
      appName,
      windowName
    }))
    .filter((slice) => slice.estimatedBytes > 0 && slice.samples > 0);
}

function buildRecentHeavyGrowthUnavailable(
  status: ScreenpipeRecentHeavyGrowthDiagnostics['inspectionStatus'],
  reason: string
): ScreenpipeRecentHeavyGrowthDiagnostics {
  return {
    inspectionStatus: status,
    reason,
    windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
    sampleLimit: SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT,
    timeSliceMinutes: SCREENPIPE_RECENT_HEAVY_GROWTH_TIME_SLICE_MINUTES,
    analyzedAt: new Date().toISOString(),
    sampledRows: 0,
    sampledBytes: 0,
    topTimeSlices: [],
    topSamples: []
  };
}

async function inspectRecentHeavyGrowth(databasePath: string): Promise<ScreenpipeRecentHeavyGrowthDiagnostics> {
  try {
    const [{ stdout: summaryStdout }, { stdout: samplesStdout }, { stdout: timeSlicesStdout }] = await Promise.all([
      execFileAsync(SQLITE3_BINARY, ['-separator', '\t', databasePath, SCREENPIPE_RECENT_HEAVY_GROWTH_SUMMARY_QUERY], {
        timeout: SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS
      }),
      execFileAsync(SQLITE3_BINARY, ['-separator', '\t', databasePath, SCREENPIPE_RECENT_HEAVY_GROWTH_TOP_SAMPLE_QUERY], {
        timeout: SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS
      }),
      execFileAsync(SQLITE3_BINARY, ['-separator', '\t', databasePath, SCREENPIPE_RECENT_HEAVY_GROWTH_TIME_SLICES_QUERY], {
        timeout: SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS
      })
    ]);

    const summary = parseRecentHeavyGrowthSummary(summaryStdout);
    const topSamples = parseRecentHeavyGrowthSamples(samplesStdout);
    const topTimeSlices = parseRecentHeavyGrowthTimeSlices(timeSlicesStdout);

    return {
      inspectionStatus: 'ready',
      windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
      sampleLimit: SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT,
      timeSliceMinutes: SCREENPIPE_RECENT_HEAVY_GROWTH_TIME_SLICE_MINUTES,
      analyzedAt: new Date().toISOString(),
      sampledRows: summary.sampledRows,
      sampledBytes: summary.sampledBytes,
      topTimeSlices,
      topSamples
    };
  } catch {
    return buildRecentHeavyGrowthUnavailable('degraded', 'Recent heavy-growth inspection is unavailable.');
  }
}

function parseHotspotApps(stdout: string): ScreenpipeStorageHotspotApp[] {
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

function parseHotspotAccessibilityRoles(stdout: string): ScreenpipeStorageHotspotAccessibilityRole[] {
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

function parseSchemaColumns(stdout: string): Set<string> {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string] | [string, string] => parts.length >= 1)
    .map((parts) => parts[1] ?? parts[0])
    .filter((name) => name.length > 0)
    .reduce((columns, name) => columns.add(name), new Set<string>());
}

function parseCaptureReuseRows(stdout: string): CaptureReuseSignalRow[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string, string] => parts.length === 3)
    .map(([value, rows, estimatedBytes]) => ({
      value,
      rows: Number.parseInt(rows, 10) || 0,
      estimatedBytes: Number.parseInt(estimatedBytes, 10) || 0
    }))
    .filter((row) => row.rows > 0);
}

function buildRecentCaptureReuseUnavailable(
  status: ScreenpipeRecentCaptureReuseDiagnostics['inspectionStatus'],
  coverage: ScreenpipeRecentCaptureReuseDiagnostics['coverage'],
  reason: string
): ScreenpipeRecentCaptureReuseDiagnostics {
  return {
    inspectionStatus: status,
    reason,
    windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
    analyzedAt: new Date().toISOString(),
    coverage,
    signals: []
  };
}

async function inspectSchemaColumns(databasePath: string, table: 'frames' | 'elements'): Promise<Set<string>> {
  const { stdout } = await execFileAsync(SQLITE3_BINARY, ['-separator', '\t', databasePath, `PRAGMA table_info(${table});`], {
    timeout: SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS
  });

  return parseSchemaColumns(stdout);
}

async function inspectScreenpipeSchema(databasePath: string): Promise<ScreenpipeSchemaColumnMap> {
  const [frames, elements] = await Promise.all([
    inspectSchemaColumns(databasePath, 'frames'),
    inspectSchemaColumns(databasePath, 'elements')
  ]);

  return {
    frames,
    elements
  };
}

function buildCaptureReuseSignalQuery(definition: CaptureReuseSignalDefinition): string {
  if (definition.table === 'frames') {
    return [
      'WITH recent AS (',
      '  SELECT',
      `    COALESCE(${definition.column}, '') AS signal_value,`,
      `    ${definition.rowEstimatedBytesExpression} AS estimated_bytes`,
      '  FROM frames',
      `  WHERE timestamp >= datetime('now', '-${SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES} minutes')`,
      `    AND COALESCE(${definition.column}, '') <> ''`,
      ')',
      'SELECT signal_value, COUNT(*) AS rows, COALESCE(SUM(estimated_bytes), 0) AS estimated_bytes',
      'FROM recent',
      'GROUP BY signal_value',
      'ORDER BY estimated_bytes DESC, rows DESC, signal_value ASC',
      `LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_GROUP_LIMIT};`
    ].join(' ');
  }

  return [
    'WITH recent AS (',
    '  SELECT',
    `    COALESCE(e.${definition.column}, '') AS signal_value,`,
    `    ${definition.rowEstimatedBytesExpression} AS estimated_bytes`,
    '  FROM elements e',
    '  JOIN frames f ON f.id = e.frame_id',
    `  WHERE f.timestamp >= datetime('now', '-${SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES} minutes')`,
    `    AND COALESCE(e.${definition.column}, '') <> ''`,
    ')',
    'SELECT signal_value, COUNT(*) AS rows, COALESCE(SUM(estimated_bytes), 0) AS estimated_bytes',
    'FROM recent',
    'GROUP BY signal_value',
    'ORDER BY estimated_bytes DESC, rows DESC, signal_value ASC',
    `LIMIT ${SCREENPIPE_RECENT_TEXT_DUPLICATION_GROUP_LIMIT};`
  ].join(' ');
}

async function inspectRecentCaptureReuse(databasePath: string): Promise<ScreenpipeRecentCaptureReuseDiagnostics> {
  try {
    const schema = await inspectScreenpipeSchema(databasePath);
    const definitions: CaptureReuseSignalDefinition[] = [
      {
        key: 'capture-trigger',
        label: 'Capture trigger',
        table: 'frames',
        column: 'capture_trigger',
        sampledRowsQuery: [
          'SELECT COUNT(*) FROM frames',
          `WHERE timestamp >= datetime('now', '-${SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES} minutes');`
        ].join(' '),
        rowEstimatedBytesExpression: "LENGTH(COALESCE(full_text, ''))"
      },
      {
        key: 'element-reuse',
        label: 'Element reuse',
        table: 'elements',
        column: 'element_reuse_kind',
        sampledRowsQuery: [
          'SELECT COUNT(*) FROM elements e',
          'JOIN frames f ON f.id = e.frame_id',
          `WHERE f.timestamp >= datetime('now', '-${SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES} minutes');`
        ].join(' '),
        rowEstimatedBytesExpression: "LENGTH(COALESCE(e.text, '')) + LENGTH(COALESCE(e.properties, ''))"
      }
    ];

    const supportedDefinitions = definitions.filter((definition) => schema[definition.table].has(definition.column));
    if (supportedDefinitions.length === 0) {
      return buildRecentCaptureReuseUnavailable('unavailable', 'unsupported', 'Capture/reuse metadata columns are not available in this Screenpipe schema.');
    }

    const signals = await Promise.all(supportedDefinitions.map(async (definition) => {
      const [{ stdout: sampledRowsStdout }, { stdout: rowsStdout }] = await Promise.all([
        execFileAsync(SQLITE3_BINARY, ['-separator', '\t', databasePath, definition.sampledRowsQuery], {
          timeout: SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS
        }),
        execFileAsync(SQLITE3_BINARY, ['-separator', '\t', databasePath, buildCaptureReuseSignalQuery(definition)], {
          timeout: SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS
        })
      ]);

      const sampledRows = Number.parseInt(parseTabSeparatedRow(sampledRowsStdout)?.[0] ?? '0', 10) || 0;
      const topValues = parseCaptureReuseRows(rowsStdout);
      const matchedRows = topValues.reduce((total, row) => total + row.rows, 0);
      const estimatedBytes = topValues.reduce((total, row) => total + row.estimatedBytes, 0);

      return {
        key: definition.key,
        label: definition.label,
        sampledRows,
        matchedRows,
        estimatedBytes,
        topValues
      } satisfies ScreenpipeRecentCaptureReuseSignal;
    }));

    return {
      inspectionStatus: 'ready',
      windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
      analyzedAt: new Date().toISOString(),
      coverage: supportedDefinitions.length === definitions.length ? 'supported' : 'partial',
      signals
    };
  } catch {
    return buildRecentCaptureReuseUnavailable('degraded', 'unsupported', 'Recent capture/reuse inspection is unavailable.');
  }
}

async function inspectScreenpipeHotspots(databasePath: string): Promise<ScreenpipeStorageHotspots> {
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

function classifyAttributionBucket(tableName: string): ScreenpipeSqliteAttributionBucket['key'] {
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

function buildSqliteByteAttribution(
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

async function inspectScreenpipeSqliteWithTimeout(
  screenpipeDirectory: string,
  timeout: number,
  includeByteAttribution: boolean
): Promise<ScreenpipeStorageDiagnostics> {
  const databasePath = join(screenpipeDirectory, 'db.sqlite');

  let totalBytes = 0;
  try {
    totalBytes = (await stat(databasePath)).size;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return {
        inspectionStatus: 'unavailable',
        reason: 'Screenpipe db.sqlite is missing.',
        databasePath,
        totalBytes: 0,
        dominantTables: [],
        hotspots: {
          inspectionStatus: 'unavailable',
          reason: 'Screenpipe db.sqlite is missing.',
          dominantFields: [],
          dominantApps: [],
          dominantAccessibilityRoles: []
        },
        recentTextDuplication: {
          inspectionStatus: 'unavailable',
          reason: 'Screenpipe db.sqlite is missing.',
          windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
          minTextLength: SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH,
          analyzedAt: new Date().toISOString(),
          sources: []
        },
        recentElementDuplication: buildRecentElementDuplicationUnavailable('unavailable', 'Screenpipe db.sqlite is missing.'),
        recentCaptureReuse: buildRecentCaptureReuseUnavailable('unavailable', 'unsupported', 'Screenpipe db.sqlite is missing.'),
        recentHeavyGrowth: buildRecentHeavyGrowthUnavailable('unavailable', 'Screenpipe db.sqlite is missing.')
      };
    }

    return {
      inspectionStatus: 'degraded',
      reason: 'Screenpipe db.sqlite size could not be read.',
      databasePath,
      totalBytes: 0,
      dominantTables: [],
      hotspots: {
        inspectionStatus: 'degraded',
        reason: 'Screenpipe db.sqlite size could not be read.',
        dominantFields: [],
        dominantApps: [],
        dominantAccessibilityRoles: []
      },
      recentTextDuplication: {
        inspectionStatus: 'degraded',
        reason: 'Screenpipe db.sqlite size could not be read.',
        windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
        minTextLength: SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH,
        analyzedAt: new Date().toISOString(),
        sources: []
      },
      recentElementDuplication: buildRecentElementDuplicationUnavailable('degraded', 'Screenpipe db.sqlite size could not be read.'),
      recentCaptureReuse: buildRecentCaptureReuseUnavailable('degraded', 'unsupported', 'Screenpipe db.sqlite size could not be read.'),
      recentHeavyGrowth: buildRecentHeavyGrowthUnavailable('degraded', 'Screenpipe db.sqlite size could not be read.')
    };
  }

  try {
    const { stdout } = await execFileAsync(SQLITE3_BINARY, [databasePath, SQLITE_DBSTAT_QUERY], {
      timeout
    });
    const tables = parseDominantTableRows(stdout);
    const hotspots = await inspectScreenpipeHotspots(databasePath);
    const recentTextDuplication = await inspectRecentTextDuplication(databasePath);
    const recentElementDuplication = await inspectRecentElementDuplication(databasePath);
    const recentCaptureReuse = await inspectRecentCaptureReuse(databasePath);
    const recentHeavyGrowth = await inspectRecentHeavyGrowth(databasePath);

    return {
      inspectionStatus: 'ready',
      databasePath,
      totalBytes,
      dominantTables: tables.slice(0, SCREENPIPE_STORAGE_DOMINANT_TABLE_LIMIT),
      byteAttribution: includeByteAttribution ? buildSqliteByteAttribution(totalBytes, tables) : undefined,
      hotspots: includeByteAttribution ? hotspots : undefined,
      recentTextDuplication,
      recentElementDuplication,
      recentCaptureReuse,
      recentHeavyGrowth
    };
  } catch {
    return {
      inspectionStatus: 'degraded',
      reason: includeByteAttribution
        ? 'Screenpipe SQLite table inspection is unavailable.'
        : 'Screenpipe SQLite table inspection exceeded the bootstrap probe budget.',
      databasePath,
      totalBytes,
      dominantTables: [],
      hotspots: includeByteAttribution
        ? {
            inspectionStatus: 'degraded',
            reason: 'Screenpipe storage hotspot inspection is unavailable.',
            dominantFields: [],
            dominantApps: [],
            dominantAccessibilityRoles: []
          }
        : undefined,
      recentTextDuplication: {
        inspectionStatus: 'degraded',
        reason: 'Recent-window text duplication inspection is unavailable.',
        windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
        minTextLength: SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH,
        analyzedAt: new Date().toISOString(),
        sources: []
      },
      recentElementDuplication: buildRecentElementDuplicationUnavailable('degraded', 'Recent accessibility element duplication inspection is unavailable.'),
      recentCaptureReuse: buildRecentCaptureReuseUnavailable('degraded', 'unsupported', 'Recent capture/reuse inspection is unavailable.'),
      recentHeavyGrowth: buildRecentHeavyGrowthUnavailable('degraded', 'Recent heavy-growth inspection is unavailable.')
    };
  }
}

export async function inspectScreenpipeSqlite(screenpipeDirectory: string): Promise<ScreenpipeStorageDiagnostics> {
  return inspectScreenpipeSqliteWithTimeout(screenpipeDirectory, SCREENPIPE_STORAGE_BOOTSTRAP_TIMEOUT_MS, false);
}

export async function inspectScreenpipeSqliteDeep(screenpipeDirectory: string): Promise<ScreenpipeStorageDiagnostics> {
  return inspectScreenpipeSqliteWithTimeout(screenpipeDirectory, SCREENPIPE_STORAGE_DIAGNOSTIC_TIMEOUT_MS, true);
}

function buildRecentTextDuplicationUnavailable(
  status: ScreenpipeRecentTextDuplicationDiagnostics['inspectionStatus'],
  reason: string
): ScreenpipeRecentTextDuplicationDiagnostics {
  return {
    inspectionStatus: status,
    reason,
    windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
    minTextLength: SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH,
    analyzedAt: new Date().toISOString(),
    sources: []
  };
}

function buildRecentElementDuplicationUnavailable(
  status: ScreenpipeRecentElementDuplicationDiagnostics['inspectionStatus'],
  reason: string
): ScreenpipeRecentElementDuplicationDiagnostics {
  return {
    inspectionStatus: status,
    reason,
    windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
    minTextLength: SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH,
    analyzedAt: new Date().toISOString(),
    sampledRows: 0,
    distinctElements: 0,
    duplicateGroups: 0,
    duplicateRows: 0,
    sampledBytes: 0,
    redundantBytes: 0,
    topGroups: []
  };
}

async function inspectRecentTextDuplicationSource(
  databasePath: string,
  definition: RecentTextDuplicationQueryDefinition
): Promise<ScreenpipeRecentTextDuplicationSource> {
  try {
    const [{ stdout: summaryStdout }, { stdout: groupsStdout }] = await Promise.all([
      execFileAsync(SQLITE3_BINARY, ['-separator', '\t', databasePath, definition.summaryQuery], {
        timeout: SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS
      }),
      execFileAsync(SQLITE3_BINARY, ['-separator', '\t', databasePath, definition.groupsQuery], {
        timeout: SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS
      })
    ]);

    const summary = parseDuplicationSummary(summaryStdout);
    const topGroups = parseDuplicateGroups(groupsStdout);
    const duplicateRows = topGroups.reduce((total, group) => total + group.occurrences, 0);
    const redundantCharacters = topGroups.reduce((total, group) => total + ((group.occurrences - 1) * group.textLength), 0);

    return {
      key: definition.key,
      label: definition.label,
      inspectionStatus: 'ready',
      sampledRows: summary.sampledRows,
      distinctTexts: summary.distinctTexts,
      duplicateGroups: topGroups.length,
      duplicateRows,
      sampledCharacters: summary.sampledCharacters,
      redundantCharacters,
      topGroups
    };
  } catch {
    return {
      key: definition.key,
      label: definition.label,
      inspectionStatus: 'degraded',
      reason: `${definition.label} duplication inspection timed out or failed.`,
      sampledRows: 0,
      distinctTexts: 0,
      duplicateGroups: 0,
      duplicateRows: 0,
      sampledCharacters: 0,
      redundantCharacters: 0,
      topGroups: []
    };
  }
}

async function inspectRecentTextDuplication(databasePath: string): Promise<ScreenpipeRecentTextDuplicationDiagnostics> {
  const definitions: RecentTextDuplicationQueryDefinition[] = [
    {
      key: 'frame-full-text',
      label: 'Frame full_text',
      summaryQuery: FRAME_FULL_TEXT_DUPLICATION_QUERY,
      groupsQuery: FRAME_FULL_TEXT_DUPLICATION_GROUPS_QUERY
    },
    {
      key: 'frame-accessibility-text',
      label: 'Frame accessibility_text',
      summaryQuery: FRAME_ACCESSIBILITY_DUPLICATION_QUERY,
      groupsQuery: FRAME_ACCESSIBILITY_DUPLICATION_GROUPS_QUERY
    },
    {
      key: 'ocr-text',
      label: 'OCR text',
      summaryQuery: OCR_TEXT_DUPLICATION_QUERY,
      groupsQuery: OCR_TEXT_DUPLICATION_GROUPS_QUERY
    }
  ];

  const sources = await Promise.all(definitions.map((definition) => inspectRecentTextDuplicationSource(databasePath, definition)));
  const inspectionStatus = sources.some((source) => source.inspectionStatus === 'ready') ? 'ready' : 'degraded';

  return {
    inspectionStatus,
    reason: inspectionStatus === 'ready' ? undefined : 'Recent-window text duplication inspection is unavailable.',
    windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
    minTextLength: SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH,
    analyzedAt: new Date().toISOString(),
    sources
  };
}

async function inspectRecentElementDuplication(databasePath: string): Promise<ScreenpipeRecentElementDuplicationDiagnostics> {
  try {
    const [{ stdout: summaryStdout }, { stdout: groupsStdout }] = await Promise.all([
      execFileAsync(SQLITE3_BINARY, ['-separator', '\t', databasePath, SCREENPIPE_RECENT_ELEMENT_DUPLICATION_SUMMARY_QUERY], {
        timeout: SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS
      }),
      execFileAsync(SQLITE3_BINARY, ['-separator', '\t', databasePath, SCREENPIPE_RECENT_ELEMENT_DUPLICATION_GROUPS_QUERY], {
        timeout: SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS
      })
    ]);

    const summary = parseElementDuplicationSummary(summaryStdout);
    const topGroups = parseElementDuplicateGroups(groupsStdout);
    const duplicateRows = topGroups.reduce((total, group) => total + group.occurrences, 0);
    const redundantBytes = topGroups.reduce((total, group) => total + Math.round(group.estimatedBytes * ((group.occurrences - 1) / group.occurrences)), 0);

    return {
      inspectionStatus: 'ready',
      windowMinutes: SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES,
      minTextLength: SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH,
      analyzedAt: new Date().toISOString(),
      sampledRows: summary.sampledRows,
      distinctElements: summary.distinctElements,
      duplicateGroups: topGroups.length,
      duplicateRows,
      sampledBytes: summary.sampledBytes,
      redundantBytes,
      topGroups
    };
  } catch {
    return buildRecentElementDuplicationUnavailable('degraded', 'Recent accessibility element duplication inspection is unavailable.');
  }
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
