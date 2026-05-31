import { describe, expect, it } from 'vitest';

import {
  formatFileAnalyzeToolResult,
  unavailableToolResult
} from '../../../src/mcp/tools/shared.js';

describe('shared MCP tool result helpers', () => {
  it('marks unavailable tool results as errors with the declared phase message', () => {
    const result = unavailableToolResult('search-screen', 'Phase 3');

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'search-screen is registered in Phase 1, but its full capability is intentionally unavailable until Phase 3.'
        }
      ]
    });
  });

  it('prefers file analysis answers for the text payload while preserving structured content', () => {
    const result = formatFileAnalyzeToolResult({
      summary: 'Found relevant lines.',
      answer: 'The focused v1 line is in the second paragraph.',
      highlights: ['focused v1 line'],
      evidence: [
        {
          lineNumber: 2,
          text: 'focused v1 line',
          score: 0.9
        }
      ],
      file: {
        path: '/tmp/fixture.md',
        name: 'fixture.md',
        extension: '.md',
        lineCount: 3
      }
    });

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'The focused v1 line is in the second paragraph.'
      }
    ]);
    expect(result.structuredContent).toMatchObject({
      summary: 'Found relevant lines.',
      answer: 'The focused v1 line is in the second paragraph.',
      highlights: ['focused v1 line'],
      evidence: [
        {
          lineNumber: 2,
          text: 'focused v1 line',
          score: 0.9
        }
      ]
    });
  });

  // The previous `formatSearchScreenToolResult` / `formatRecentActivityToolResult`
  // helper tests were removed alongside the legacy `search-screen` /
  // `recent-activity` tools (work-activity-analysis spec, task 8.1). The
  // replacement `find` / `recall` / `inspect` tools build their text content
  // inline from a `narrativeText` field (see R7.15) and therefore do not need
  // dedicated `format*` helpers in `shared.ts`.
});
