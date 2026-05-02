import { describe, expect, it } from 'vitest';

import { fuseHybridResults } from '../../../src/services/retrieval/hybrid-ranker.js';
import type { RetrievalEvidenceItem } from '../../../src/services/retrieval/types.js';

function evidence(id: string, source: RetrievalEvidenceItem['source'], text = id): RetrievalEvidenceItem {
  return {
    id,
    text,
    timestamp: '2026-04-13T12:00:00.000Z',
    appName: 'Claude',
    source
  };
}

describe('hybrid ranker', () => {
  it('keeps single-source ranking order and source labels', () => {
    const results = fuseHybridResults(
      [
        evidence('keyword-1', 'keyword'),
        evidence('keyword-2', 'keyword'),
        evidence('keyword-3', 'keyword')
      ],
      [],
      2
    );

    expect(results).toHaveLength(2);
    expect(results.map((item) => item.id)).toEqual(['keyword-1', 'keyword-2']);
    expect(results.map((item) => item.source)).toEqual(['keyword', 'keyword']);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it('merges duplicate ids into a hybrid result and ranks by fused score', () => {
    const results = fuseHybridResults(
      [
        evidence('only-keyword', 'keyword'),
        evidence('shared', 'keyword')
      ],
      [
        evidence('shared', 'semantic'),
        evidence('only-semantic', 'semantic')
      ]
    );

    expect(results.map((item) => item.id)).toEqual([
      'shared',
      'only-keyword',
      'only-semantic'
    ]);
    expect(results[0]).toMatchObject({
      id: 'shared',
      source: 'hybrid'
    });
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[1]?.score).toBeGreaterThan(results[2]?.score ?? 0);
  });

  it('normalizes every multi-signal result source to hybrid', () => {
    const results = fuseHybridResults(
      [evidence('shared-1', 'keyword'), evidence('shared-2', 'keyword')],
      [evidence('shared-2', 'semantic'), evidence('shared-1', 'semantic')]
    );

    expect(results).toHaveLength(2);
    expect(results.every((item) => item.source === 'hybrid')).toBe(true);
  });
});
