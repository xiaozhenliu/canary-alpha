import type { RetrievalEvidenceItem } from './types.js';

function contribution(rank: number): number {
  return 1 / (60 + rank + 1);
}

export function fuseHybridResults(
  keywordResults: RetrievalEvidenceItem[],
  semanticResults: RetrievalEvidenceItem[],
  limit = 10
): RetrievalEvidenceItem[] {
  const merged = new Map<string, RetrievalEvidenceItem & { fusedScore: number; sources: Set<string> }>();

  keywordResults.forEach((item, index) => {
    const existing = merged.get(item.id);
    const fusedScore = contribution(index);

    if (existing) {
      existing.fusedScore += fusedScore;
      existing.sources.add('keyword');
      return;
    }

    merged.set(item.id, {
      ...item,
      fusedScore,
      sources: new Set(['keyword'])
    });
  });

  semanticResults.forEach((item, index) => {
    const existing = merged.get(item.id);
    const fusedScore = contribution(index);

    if (existing) {
      existing.fusedScore += fusedScore;
      existing.sources.add('semantic');
      return;
    }

    merged.set(item.id, {
      ...item,
      fusedScore,
      sources: new Set(['semantic'])
    });
  });

  return [...merged.values()]
    .sort((left, right) => right.fusedScore - left.fusedScore)
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      text: item.text,
      timestamp: item.timestamp,
      appName: item.appName,
      windowName: item.windowName,
      score: Number(item.fusedScore.toFixed(6)),
      source: item.sources.size > 1 ? 'hybrid' : (item.source as RetrievalEvidenceItem['source']),
      sourceTypes: item.sourceTypes
    }));
}
