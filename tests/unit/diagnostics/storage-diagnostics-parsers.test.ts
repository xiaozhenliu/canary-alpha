import { describe, expect, it } from 'vitest';

import {
  parseDominantTableRows,
  parseTabSeparatedRow,
  parseHotspotFields,
  parseHotspotApps,
  parseHotspotAccessibilityRoles,
  classifyAttributionBucket,
  parseRecentHeavyGrowthSummary,
  parseRecentHeavyGrowthSamples,
  parseRecentHeavyGrowthTimeSlices,
  parseDuplicationSummary,
  parseElementDuplicationSummary,
  parseDuplicateGroups,
  parseElementDuplicateGroups,
  parseSchemaColumns,
  parseCaptureReuseRows
} from '../../../src/services/diagnostics/storage-diagnostics.js';

describe('parseTabSeparatedRow', () => {
  it('parses a single tab-separated line', () => {
    expect(parseTabSeparatedRow('foo\tbar\tbaz\n')).toEqual(['foo', 'bar', 'baz']);
  });

  it('returns null for empty input', () => {
    expect(parseTabSeparatedRow('')).toBeNull();
    expect(parseTabSeparatedRow('   \n  \n')).toBeNull();
  });

  it('picks the first non-empty line', () => {
    expect(parseTabSeparatedRow('\n  \nhello\tworld\n')).toEqual(['hello', 'world']);
  });
});

describe('parseDominantTableRows', () => {
  it('parses sqlite3 tab-separated table usage output', () => {
    const stdout = 'frames\t1048576\nelements\t524288\nocr_text\t262144\n';
    const result = parseDominantTableRows(stdout);
    expect(result).toEqual([
      { name: 'frames', estimatedBytes: 1048576 },
      { name: 'elements', estimatedBytes: 524288 },
      { name: 'ocr_text', estimatedBytes: 262144 }
    ]);
  });

  it('drops rows with invalid byte counts', () => {
    const stdout = 'frames\t1000\nbad_table\tnot_a_number\n';
    const result = parseDominantTableRows(stdout);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('frames');
  });

  it('returns empty array for empty input', () => {
    expect(parseDominantTableRows('')).toEqual([]);
  });
});

describe('parseHotspotFields', () => {
  it('parses field hotspot output', () => {
    const stdout = 'frames.accessibility_tree_json\t5000000\t1200\nframes.full_text\t3000000\t1200\n';
    const result = parseHotspotFields(stdout);
    expect(result).toEqual([
      { key: 'frames.accessibility_tree_json', estimatedBytes: 5000000, sampledRows: 1200 },
      { key: 'frames.full_text', estimatedBytes: 3000000, sampledRows: 1200 }
    ]);
  });

  it('filters out zero-byte fields', () => {
    const stdout = 'frames.full_text\t0\t100\n';
    expect(parseHotspotFields(stdout)).toEqual([]);
  });
});

describe('parseHotspotApps', () => {
  it('parses app hotspot output', () => {
    const stdout = 'Code\t2000000\nTerminal\t1000000\n';
    const result = parseHotspotApps(stdout);
    expect(result).toEqual([
      { appName: 'Code', estimatedBytes: 2000000 },
      { appName: 'Terminal', estimatedBytes: 1000000 }
    ]);
  });
});

describe('parseHotspotAccessibilityRoles', () => {
  it('parses accessibility role output', () => {
    const stdout = 'accessibility\tAXStaticText\t500000\t300\n';
    const result = parseHotspotAccessibilityRoles(stdout);
    expect(result).toEqual([
      { source: 'accessibility', role: 'AXStaticText', estimatedBytes: 500000, sampledRows: 300 }
    ]);
  });
});

describe('classifyAttributionBucket', () => {
  it('classifies frame tables', () => {
    expect(classifyAttributionBucket('frames')).toBe('frames');
    expect(classifyAttributionBucket('frames_content')).toBe('frames');
  });

  it('classifies element tables', () => {
    expect(classifyAttributionBucket('elements')).toBe('elements');
    expect(classifyAttributionBucket('elements_idx')).toBe('elements');
  });

  it('classifies FTS tables', () => {
    expect(classifyAttributionBucket('frames_fts_content')).toBe('fts');
    expect(classifyAttributionBucket('some_fts_index')).toBe('fts');
  });

  it('classifies everything else as other', () => {
    expect(classifyAttributionBucket('ocr_text')).toBe('other');
    expect(classifyAttributionBucket('sessions')).toBe('other');
  });
});

describe('parseRecentHeavyGrowthSummary', () => {
  it('parses summary row', () => {
    const result = parseRecentHeavyGrowthSummary('42\t1048576\n');
    expect(result).toEqual({ sampledRows: 42, sampledBytes: 1048576 });
  });

  it('returns zeros for malformed input', () => {
    expect(parseRecentHeavyGrowthSummary('')).toEqual({ sampledRows: 0, sampledBytes: 0 });
  });
});

describe('parseRecentHeavyGrowthSamples', () => {
  it('parses sample rows', () => {
    const stdout = '100\t2026-04-13T11:00:00.000Z\tCode\tMain\t5000\tunique-heavy\thello world\n';
    const result = parseRecentHeavyGrowthSamples(stdout);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      frameId: 100,
      appName: 'Code',
      estimatedBytes: 5000,
      duplicateSignal: 'unique-heavy'
    });
  });

  it('filters out zero-byte samples', () => {
    const stdout = '100\t2026-04-13T11:00:00.000Z\tCode\tMain\t0\tunique-heavy\tpreview\n';
    expect(parseRecentHeavyGrowthSamples(stdout)).toEqual([]);
  });
});

describe('parseRecentHeavyGrowthTimeSlices', () => {
  it('parses time slice rows', () => {
    const stdout = '2026-04-13T11:00:00Z\tCode\tMain\t50000\t10\n';
    const result = parseRecentHeavyGrowthTimeSlices(stdout);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      bucketStart: '2026-04-13T11:00:00Z',
      estimatedBytes: 50000,
      samples: 10
    });
  });
});

describe('parseDuplicationSummary', () => {
  it('parses text duplication summary', () => {
    const result = parseDuplicationSummary('100\t80\t500000\n');
    expect(result).toEqual({ sampledRows: 100, distinctTexts: 80, sampledCharacters: 500000 });
  });

  it('returns zeros for empty input', () => {
    expect(parseDuplicationSummary('')).toEqual({ sampledRows: 0, distinctTexts: 0, sampledCharacters: 0 });
  });
});

describe('parseElementDuplicationSummary', () => {
  it('parses element duplication summary', () => {
    const result = parseElementDuplicationSummary('200\t150\t300000\n');
    expect(result).toEqual({ sampledRows: 200, distinctElements: 150, sampledBytes: 300000 });
  });
});

describe('parseDuplicateGroups', () => {
  it('parses duplicate group rows', () => {
    const stdout = 'Code\tMain Window\tsome repeated text here...\t5\t50\n';
    const result = parseDuplicateGroups(stdout);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      appName: 'Code',
      windowName: 'Main Window',
      occurrences: 5,
      textLength: 50
    });
  });

  it('filters groups below minimum text length', () => {
    const stdout = 'Code\tMain\thi\t3\t2\n';
    expect(parseDuplicateGroups(stdout)).toEqual([]);
  });
});

describe('parseElementDuplicateGroups', () => {
  it('parses element duplicate group rows', () => {
    const stdout = 'Code\tMain\taccessibility\tAXStaticText\tsome text...\t4\t2000\n';
    const result = parseElementDuplicateGroups(stdout);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      appName: 'Code',
      source: 'accessibility',
      role: 'AXStaticText',
      occurrences: 4,
      estimatedBytes: 2000
    });
  });
});

describe('parseSchemaColumns', () => {
  it('extracts column names from PRAGMA table_info output', () => {
    const stdout = '0\tid\tINTEGER\t0\t\t1\n1\ttimestamp\tTEXT\t0\t\t0\n2\tapp_name\tTEXT\t0\t\t0\n';
    const result = parseSchemaColumns(stdout);
    expect(result).toEqual(new Set(['id', 'timestamp', 'app_name']));
  });

  it('returns empty set for empty input', () => {
    expect(parseSchemaColumns('')).toEqual(new Set());
  });
});

describe('parseCaptureReuseRows', () => {
  it('parses capture reuse signal rows', () => {
    const stdout = 'manual\t50\t100000\nauto\t30\t60000\n';
    const result = parseCaptureReuseRows(stdout);
    expect(result).toEqual([
      { value: 'manual', rows: 50, estimatedBytes: 100000 },
      { value: 'auto', rows: 30, estimatedBytes: 60000 }
    ]);
  });

  it('filters out zero-row entries', () => {
    const stdout = 'none\t0\t0\n';
    expect(parseCaptureReuseRows(stdout)).toEqual([]);
  });
});
