/**
 * Coverage_Evaluation_Scenario fixtures
 *
 * In-process TypeScript literals — no real ScreenPipe or macOS Accessibility
 * permissions required. Covers:
 *   - 3 Substantive_Work_Window categories (IDE / Terminal / Browser), each
 *     with at least one segment ≥ 60 s
 *   - 1 Noise_Window segment (Control Center, 30 s)
 *
 * Requirements: 3.1, 7.3
 */

import type { ScreenpipeRecord } from '../../../../src/services/retrieval/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a sequence of records at 1-second intervals starting from `baseIso`. */
function buildSegment(opts: {
  baseIso: string;
  durationSeconds: number;
  appName: string;
  windowName: string;
  texts: string[];
  sourceTypes: string[];
  idPrefix: string;
  startFrameId?: number;
}): ScreenpipeRecord[] {
  const {
    baseIso,
    durationSeconds,
    appName,
    windowName,
    texts,
    sourceTypes,
    idPrefix,
    startFrameId = 1
  } = opts;

  const base = new Date(baseIso).getTime();
  const records: ScreenpipeRecord[] = [];

  for (let i = 0; i < durationSeconds; i++) {
    const ts = new Date(base + i * 1000).toISOString();
    const text = texts[i % texts.length];
    records.push({
      id: `${idPrefix}-${i}`,
      text,
      timestamp: ts,
      appName,
      windowName,
      frameId: startFrameId + i,
      sourceTypes
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Segment base timestamps (non-overlapping, sequential)
// ---------------------------------------------------------------------------

const BASE_ISO = '2024-01-15T09:00:00.000Z';

// IDE segment starts at T+0
const IDE_BASE = BASE_ISO;
const IDE_DURATION = 60; // ≥ 60 s (R3.1)

// Terminal segment starts at T+60
const TERMINAL_BASE = new Date(new Date(BASE_ISO).getTime() + 60_000).toISOString();
const TERMINAL_DURATION = 90; // ≥ 60 s (R3.1)

// Browser segment starts at T+150
const BROWSER_BASE = new Date(new Date(BASE_ISO).getTime() + 150_000).toISOString();
const BROWSER_DURATION = 75; // ≥ 60 s (R3.1)

// Noise segment starts at T+225
const NOISE_BASE = new Date(new Date(BASE_ISO).getTime() + 225_000).toISOString();
const NOISE_DURATION = 30;

// ---------------------------------------------------------------------------
// IDE segment — VS Code ("Code")
// AX texts: "function buildSearchUrl", "content_type=accessibility"
// ---------------------------------------------------------------------------

export const IDE_RECORDS: ScreenpipeRecord[] = buildSegment({
  baseIso: IDE_BASE,
  durationSeconds: IDE_DURATION,
  appName: 'Code',
  windowName: 'design.ts — computer-history-mcp',
  texts: [
    'function buildSearchUrl(baseUrl: string, request: ScreenpipeSearchRequest, contentType: ScreenpipeContentType): URL {',
    '  const url = buildScreenpipeUrl(baseUrl, "search");',
    '  url.searchParams.set("content_type", contentType); // content_type=accessibility',
    '  url.searchParams.set("limit", String(request.limit ?? DEFAULT_PAGE_SIZE));',
    '  url.searchParams.set("offset", String(request.offset ?? 0));',
    '  return url;',
    '}',
    'export type ScreenpipeContentType = "accessibility" | "ocr";',
    '// buildSearchUrl is the entry point for all Screenpipe search requests',
    'const result = buildSearchUrl(baseUrl, req, "accessibility");'
  ],
  sourceTypes: ['accessibility'],
  idPrefix: 'ide-ax',
  startFrameId: 1000
});

// ---------------------------------------------------------------------------
// Terminal segment — Terminal.app
// AX texts: "npm run eval:coverage", "[ok] coverage 0.85"
// ---------------------------------------------------------------------------

export const TERMINAL_RECORDS: ScreenpipeRecord[] = buildSegment({
  baseIso: TERMINAL_BASE,
  durationSeconds: TERMINAL_DURATION,
  appName: 'Terminal',
  windowName: 'xz@host: ~/Projects/computer-history-mcp',
  texts: [
    '$ npm run eval:coverage',
    '> computer-history-mcp@1.0.0 eval:coverage',
    '> tsx tests/evaluations/coverage-scenario/run.ts',
    'Starting Coverage_Evaluation_Scenario...',
    'Indexing fixture records...',
    'Running queries against RetrievalPipeline...',
    'Q1 buildSearchUrl: matched=true',
    'Q2 content_type=accessibility: matched=true',
    'Q3 eval:coverage: matched=true',
    'Q4 Acceptance Criteria: matched=true',
    'Q5 PRD 第 7.3: matched=true',
    '[ok] coverage 0.85',
    'effectiveCoverage: 1.0',
    'threshold: 0.80',
    'pass: true'
  ],
  sourceTypes: ['accessibility'],
  idPrefix: 'terminal-ax',
  startFrameId: 2000
});

// ---------------------------------------------------------------------------
// Browser segment — Google Chrome
// AX texts: "Acceptance Criteria 1", "PRD 第 7.3 节"
// ---------------------------------------------------------------------------

export const BROWSER_RECORDS: ScreenpipeRecord[] = buildSegment({
  baseIso: BROWSER_BASE,
  durationSeconds: BROWSER_DURATION,
  appName: 'Google Chrome',
  windowName: 'Linear — LIN-123 accessibility-capture',
  texts: [
    'Acceptance Criteria 1: THE Retrieval_Pipeline SHALL use content_type=accessibility',
    'Acceptance Criteria 2: WHEN RetrievalPipeline receives a time-window query',
    'PRD 第 7.3 节 混合检索路径 B: content_type=accessibility',
    'Acceptance Criteria 3: AX text substring keyword search',
    'PRD 第 7.3 节 specifies the primary retrieval path uses accessibility source',
    'Acceptance Criteria 4: cross-source deduplication by frame_id',
    'Acceptance Criteria 5: sourceTypes field on every evidence item',
    'PRD 第 7.3 节 requires AX data to reach the retrieval pipeline',
    'Issue LIN-123: accessibility-capture-ingestion spec implementation',
    'Acceptance Criteria 1 through 6 cover the full AX ingestion path'
  ],
  sourceTypes: ['accessibility'],
  idPrefix: 'browser-ax',
  startFrameId: 3000
});

// ---------------------------------------------------------------------------
// Noise segment — Control Center (should never appear in retrieval results)
// ---------------------------------------------------------------------------

export const NOISE_RECORDS: ScreenpipeRecord[] = buildSegment({
  baseIso: NOISE_BASE,
  durationSeconds: NOISE_DURATION,
  appName: 'Control Center',
  windowName: 'Control Center',
  texts: [
    'Wi-Fi',
    'Bluetooth',
    'AirDrop',
    'Focus',
    'Display',
    'Sound'
  ],
  sourceTypes: ['accessibility'],
  idPrefix: 'noise-ax',
  startFrameId: 4000
});

// ---------------------------------------------------------------------------
// Combined fixture export
// ---------------------------------------------------------------------------

/** All fixture records in chronological order. */
export const ALL_FIXTURE_RECORDS: ScreenpipeRecord[] = [
  ...IDE_RECORDS,
  ...TERMINAL_RECORDS,
  ...BROWSER_RECORDS,
  ...NOISE_RECORDS
];

/**
 * Substantive_Work_Window records only (excludes Noise_Window).
 * Used by Coverage_Evaluation_Scenario to verify Effective_Coverage.
 */
export const SUBSTANTIVE_RECORDS: ScreenpipeRecord[] = [
  ...IDE_RECORDS,
  ...TERMINAL_RECORDS,
  ...BROWSER_RECORDS
];

/**
 * Metadata about each fixture segment, used by smoke tests to verify
 * that each Substantive_Work_Window category has ≥ 1 segment ≥ 60 s.
 */
export interface FixtureSegmentMeta {
  category: 'IDE' | 'Terminal' | 'Browser' | 'Noise';
  appName: string;
  windowName: string;
  durationSeconds: number;
  records: ScreenpipeRecord[];
}

export const FIXTURE_SEGMENTS: FixtureSegmentMeta[] = [
  {
    category: 'IDE',
    appName: 'Code',
    windowName: 'design.ts — computer-history-mcp',
    durationSeconds: IDE_DURATION,
    records: IDE_RECORDS
  },
  {
    category: 'Terminal',
    appName: 'Terminal',
    windowName: 'xz@host: ~/Projects/computer-history-mcp',
    durationSeconds: TERMINAL_DURATION,
    records: TERMINAL_RECORDS
  },
  {
    category: 'Browser',
    appName: 'Google Chrome',
    windowName: 'Linear — LIN-123 accessibility-capture',
    durationSeconds: BROWSER_DURATION,
    records: BROWSER_RECORDS
  },
  {
    category: 'Noise',
    appName: 'Control Center',
    windowName: 'Control Center',
    durationSeconds: NOISE_DURATION,
    records: NOISE_RECORDS
  }
];
