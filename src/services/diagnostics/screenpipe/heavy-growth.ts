import type {
  ScreenpipeRecentHeavyGrowthDiagnostics,
  ScreenpipeRecentHeavyGrowthSample
} from '../../../types/app-config.js';

import {
  execFileAsync,
  parseTabSeparatedRow,
  SQLITE3_BINARY,
  SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT,
  SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS,
  SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES
} from './sqlite-cli.js';

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

type RecentHeavyGrowthSummaryRow = {
  sampledBytes: number;
  sampledRows: number;
};


export function parseRecentHeavyGrowthSummary(stdout: string): RecentHeavyGrowthSummaryRow {
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

export function parseRecentHeavyGrowthSamples(stdout: string): ScreenpipeRecentHeavyGrowthDiagnostics['topSamples'] {
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

export function parseRecentHeavyGrowthTimeSlices(stdout: string): ScreenpipeRecentHeavyGrowthDiagnostics['topTimeSlices'] {
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

export function buildRecentHeavyGrowthUnavailable(
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

export async function inspectRecentHeavyGrowth(databasePath: string): Promise<ScreenpipeRecentHeavyGrowthDiagnostics> {
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
