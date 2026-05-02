import { describe, expect, it } from 'vitest';

import {
  formatFileAnalyzeToolResult,
  formatRecentActivityToolResult,
  formatSearchScreenToolResult,
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

  it('formats retrieval freshness into the search-screen text payload', () => {
    const result = formatSearchScreenToolResult({
      summary: 'Found 1 result for fixture.',
      evidence: [
        {
          id: 'fixture-1',
          text: 'fixture result',
          timestamp: '2026-04-13T11:59:00.000Z',
          appName: 'Claude',
          source: 'hybrid'
        }
      ],
      freshness: {
        status: 'fresh',
        lagMinutes: 2,
        windowMinutes: 15,
        checkpoint: {
          cursor: 'cursor-1',
          timestamp: '2026-04-13T11:58:00.000Z'
        }
      }
    });

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Found 1 result for fixture. Freshness: fresh (lag 2 minute(s), window 15).'
      }
    ]);
    expect(result.structuredContent).toMatchObject({
      summary: 'Found 1 result for fixture.',
      evidence: [
        {
          id: 'fixture-1',
          source: 'hybrid'
        }
      ],
      freshness: {
        status: 'fresh',
        lagMinutes: 2,
        windowMinutes: 15
      }
    });
  });

  it('composes actionable retrieval errors into the recent-activity text payload', () => {
    const result = formatRecentActivityToolResult({
      summary: 'Recent activity failed.',
      evidence: [],
      error: {
        code: 'SCREENPIPE_UNAVAILABLE',
        message: 'Screenpipe is unavailable.',
        action: 'Verify the local Screenpipe service and try again.'
      }
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Recent activity failed. Screenpipe is unavailable. Verify the local Screenpipe service and try again.'
      }
    ]);
    expect(result.structuredContent).toMatchObject({
      summary: 'Recent activity failed.',
      evidence: [],
      error: {
        code: 'SCREENPIPE_UNAVAILABLE',
        message: 'Screenpipe is unavailable.',
        action: 'Verify the local Screenpipe service and try again.'
      }
    });
  });
});
