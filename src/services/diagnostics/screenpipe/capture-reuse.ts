import type {
  ScreenpipeRecentCaptureReuseDiagnostics,
  ScreenpipeRecentCaptureReuseSignal
} from '../../../types/app-config.js';

import {
  execFileAsync,
  parseTabSeparatedRow,
  SQLITE3_BINARY,
  SCREENPIPE_RECENT_TEXT_DUPLICATION_GROUP_LIMIT,
  SCREENPIPE_RECENT_TEXT_DUPLICATION_TIMEOUT_MS,
  SCREENPIPE_RECENT_TEXT_DUPLICATION_WINDOW_MINUTES
} from './sqlite-cli.js';

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

export function parseSchemaColumns(stdout: string): Set<string> {
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

export function parseCaptureReuseRows(stdout: string): CaptureReuseSignalRow[] {
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

export function buildRecentCaptureReuseUnavailable(
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

export async function inspectRecentCaptureReuse(databasePath: string): Promise<ScreenpipeRecentCaptureReuseDiagnostics> {
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
