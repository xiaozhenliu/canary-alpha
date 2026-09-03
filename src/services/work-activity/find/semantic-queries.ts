/**
 * Semantic (vector) query pipeline for the `find` MCP tool.
 *
 * Extracted from `find-service.ts` (GRO-171) so the service file
 * retains only orchestration. The core embed → vector-query →
 * reverse-resolve flow and its helper functions live here.
 */

import type {
  EmbeddingProvider,
  RetrievalEvidenceItem,
  VectorSearchRequest,
  VectorStore
} from '../../retrieval/types.js';
import type { ExtractedContentStore } from '../extraction/extracted-content-store.js';
import type { ExtractionResult } from '../extraction/types.js';
import type { EvidenceItem } from './find-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recovers the numeric frame id from a `RetrievalEvidenceItem` that
 * came back from the vector store.
 *
 * The embedding service (design §5.1, `embedding-service.ts`) writes
 * each row with `id = "extracted:${frameId}"` and stuffs `frameId`
 * into `metadata.frameId`. The current `RetrievalEvidenceItem` shape
 * does NOT surface metadata to read consumers, so we parse the id
 * prefix instead — same source of truth, exactly one parser site.
 *
 * Returns `null` for any id that does not match the expected prefix
 * or whose suffix is not a finite integer; the caller drops such
 * hits silently rather than fabricating a frame id.
 */
export function extractFrameId(hit: RetrievalEvidenceItem): number | null {
  const id = hit.id;
  if (typeof id !== 'string' || !id.startsWith('extracted:')) return null;
  const suffix = id.slice('extracted:'.length);
  if (suffix.length === 0) return null;
  const parsed = Number(suffix);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return parsed;
}

/**
 * Re-shapes an `ExtractionResult` (returned by
 * `ExtractedContentStore.getByFrameIds`) into the semantic-mode
 * `EvidenceItem` shape. Differs from `rowToEvidenceItem` in two
 * ways:
 *
 *   - `matchSource` is `'semantic'` because the row was reached via
 *     the vector store (R7.5). When the semantic path falls back
 *     to keyword (R7.6), `findKeyword` is called instead and emits
 *     `'keyword'` items; we never lie about how a hit was scored.
 *   - The caller passes the vector-store score so the response can
 *     surface it via the optional `score` field (R7.3).
 *
 * `sessionId` is left undefined here; `findSemantic` decorates the
 * items in a separate pass via `lookupSessionsByFrameIds`, mirroring
 * the keyword path.
 */
export function rowToSemanticEvidenceItem(
  row: ExtractionResult,
  score: number | undefined
): EvidenceItem {
  return {
    frameId: row.frameId,
    appName: row.appName,
    contextLabel: row.contextLabel,
    extractedText: row.extractedText,
    timestamp: row.frameTimestamp,
    matchSource: 'semantic',
    score,
    sourceTypes: row.sourceTypes
  };
}

// ---------------------------------------------------------------------------
// Core semantic query
// ---------------------------------------------------------------------------

/**
 * Embeds the query, searches the vector store, and reverse-resolves
 * each hit to its `extracted_content` row. Returns `null` when the
 * embedding or vector-store step fails (signalling the caller to
 * fall back to keyword mode), or an `EvidenceItem[]` on success
 * (which may be empty when the vector store had no hits in the
 * time window).
 *
 * Over-fetches (`limit * 2`) to leave headroom for post-filtering
 * steps that may shrink the candidate list (hash-dedup, rows since
 * Cascade_Deleted). The over-fetch is bounded (×2 + max 100) so it
 * can't blow up pathologically.
 */
export async function executeSemanticQuery(params: {
  embeddingProvider: EmbeddingProvider;
  vectorStore: VectorStore;
  extractedContentStore: ExtractedContentStore;
  query: string;
  from: string;
  to: string;
  appName?: string;
  limit: number;
}): Promise<EvidenceItem[] | null> {
  let queryEmbedding: number[];
  try {
    queryEmbedding = await params.embeddingProvider.embed(params.query);
  } catch {
    return null;
  }

  const vectorRequest: VectorSearchRequest = {
    queryEmbedding,
    from: params.from,
    to: params.to,
    appName: params.appName,
    limit: Math.max(params.limit * 2, params.limit)
  };
  let vectorHits: RetrievalEvidenceItem[];
  try {
    vectorHits = await params.vectorStore.query(vectorRequest);
  } catch {
    return null;
  }

  const frameIds = vectorHits
    .map((hit) => extractFrameId(hit))
    .filter((id): id is number => id !== null);

  if (frameIds.length === 0) {
    return [];
  }

  const rows = await params.extractedContentStore.getByFrameIds(frameIds);
  const rowsByFrameId = new Map<number, ExtractionResult>(
    rows.map((row) => [row.frameId, row])
  );

  const orderedItems: EvidenceItem[] = [];
  for (const hit of vectorHits) {
    if (orderedItems.length >= params.limit) break;
    const frameId = extractFrameId(hit);
    if (frameId === null) continue;
    const row = rowsByFrameId.get(frameId);
    if (row === undefined) continue;
    orderedItems.push(rowToSemanticEvidenceItem(row, hit.score));
  }

  return orderedItems;
}
