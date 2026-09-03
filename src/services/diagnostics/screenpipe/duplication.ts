import type {
  ScreenpipeRecentElementDuplicationDiagnostics,
  ScreenpipeRecentTextDuplicationDiagnostics,
  ScreenpipeRecentTextDuplicationSource,
  ScreenpipeRecentTextDuplicationSourceKey
} from '../../../types/app-config.js';

import {
  execFileAsync,
  parseTabSeparatedRow,
  SQLITE3_BINARY,
  SCREENPIPE_RECENT_TEXT_DUPLICATION_GROUP_LIMIT,
  SCREENPIPE_RECENT_TEXT_DUPLICATION_MIN_TEXT_LENGTH,
  SCREENPIPE_RECENT_TEXT_DUPLICATION_SAMPLE_LIMIT,
  SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS,
  SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES
} from './sqlite-cli.js';

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
  "    LENGTH(COALESCE(e.text, '')) + LENGTH(COALESCE(e.properties, '')) AS estimated_bytes",
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
  "  COUNT(DISTINCT app_name || char(31) || window_name || char(31) || source || char(31) || role) AS distinct_elements,",
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
  "    LENGTH(COALESCE(e.text, '')) + LENGTH(COALESCE(e.properties, '')) AS estimated_bytes",
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

export function parseDuplicationSummary(stdout: string): RecentTextDuplicationSummaryRow {
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

export function parseElementDuplicationSummary(stdout: string): RecentElementDuplicationSummaryRow {
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

export function parseDuplicateGroups(stdout: string): ScreenpipeRecentTextDuplicationSource['topGroups'] {
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

export function parseElementDuplicateGroups(stdout: string): ScreenpipeRecentElementDuplicationDiagnostics['topGroups'] {
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

export function buildRecentTextDuplicationUnavailable(
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

export function buildRecentElementDuplicationUnavailable(
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

export async function inspectRecentTextDuplication(databasePath: string): Promise<ScreenpipeRecentTextDuplicationDiagnostics> {
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

export async function inspectRecentElementDuplication(databasePath: string): Promise<ScreenpipeRecentElementDuplicationDiagnostics> {
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
