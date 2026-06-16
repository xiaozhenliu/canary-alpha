import type { DerivedDatabase } from '../work-activity/derived-database.js';
import { blobToFloat32Array, float32ArrayToBlob } from '../../lib/blob.js';
import type {
  RetrievalEvidenceItem,
  VectorStore,
  VectorStoreInspection,
  VectorStoreRecord,
  VectorSearchRequest
} from './types.js';

const MAX_BIND_PARAMS = 500;

function dotProduct(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let total = 0;
  for (let i = 0; i < length; i += 1) {
    total += (left[i] ?? 0) * (right[i] ?? 0);
  }
  return total;
}

function* chunked<T>(items: T[], size: number): Generator<T[], void, void> {
  if (items.length <= size) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

export class SqliteVectorStore implements VectorStore {
  readonly kind = 'sqlite';

  constructor(private readonly db: DerivedDatabase) {}

  async upsert(records: VectorStoreRecord[]): Promise<void> {
    if (records.length === 0) return;

    for (const batch of chunked(records, MAX_BIND_PARAMS)) {
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO vectors (id, text, timestamp, app_name, window_name, embedding, source_types, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of batch) {
        if (!r.embedding || r.embedding.length === 0) continue;
        stmt.run(
          r.id,
          r.text,
          r.timestamp,
          r.appName ?? null,
          r.windowName ?? null,
          float32ArrayToBlob(r.embedding),
          JSON.stringify(r.sourceTypes ?? []),
          r.metadata ? JSON.stringify(r.metadata) : null
        );
      }
    }
  }

  async query(request: VectorSearchRequest): Promise<RetrievalEvidenceItem[]> {
    return this.queryInternal(request);
  }

  async querySnapshot(request: VectorSearchRequest): Promise<RetrievalEvidenceItem[]> {
    return this.queryInternal(request);
  }

  private queryInternal(request: VectorSearchRequest): RetrievalEvidenceItem[] {
    const limit = request.limit ?? 10;
    const offset = request.offset ?? 0;

    // Phase 1: filter — covering index, no BLOB read
    let candidateIds: string[];
    if (request.appName) {
      const stmt = this.db.prepare(
        `SELECT id FROM vectors WHERE app_name = ? AND timestamp BETWEEN ? AND ?`
      );
      candidateIds = (stmt.all(
        request.appName,
        request.from ?? '0000-01-01T00:00:00.000Z',
        request.to ?? '9999-12-31T23:59:59.999Z'
      ) as Array<{ id: string }>).map(r => r.id);
    } else {
      const stmt = this.db.prepare(
        `SELECT id FROM vectors WHERE timestamp BETWEEN ? AND ?`
      );
      candidateIds = (stmt.all(
        request.from ?? '0000-01-01T00:00:00.000Z',
        request.to ?? '9999-12-31T23:59:59.999Z'
      ) as Array<{ id: string }>).map(r => r.id);
    }

    if (candidateIds.length === 0) return [];

    // Phase 2: score — load embeddings in batches
    const scored: Array<{ id: string; text: string; timestamp: string; appName: string | null; windowName: string | null; sourceTypes: string[]; score: number }> = [];

    for (const chunk of chunked(candidateIds, MAX_BIND_PARAMS)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const stmt = this.db.prepare(
        `SELECT id, text, timestamp, app_name, window_name, embedding, source_types
         FROM vectors WHERE id IN (${placeholders})`
      );
      const rows = stmt.all(...chunk) as Array<{
        id: string; text: string; timestamp: string;
        app_name: string | null; window_name: string | null;
        embedding: Uint8Array; source_types: string;
      }>;
      for (const row of rows) {
        const emb = blobToFloat32Array(row.embedding);
        const score = Number(dotProduct(emb, request.queryEmbedding).toFixed(6));
        scored.push({
          id: row.id,
          text: row.text,
          timestamp: row.timestamp,
          appName: row.app_name,
          windowName: row.window_name,
          sourceTypes: parseJsonStringArray(row.source_types),
          score
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(offset, offset + limit).map(r => ({
      id: r.id,
      text: r.text,
      timestamp: r.timestamp,
      appName: r.appName ?? undefined,
      windowName: r.windowName ?? undefined,
      source: 'semantic' as const,
      sourceTypes: r.sourceTypes,
      score: r.score
    }));
  }

  async reset(): Promise<void> {
    this.db.exec('DELETE FROM vectors');
  }

  async inspect(): Promise<VectorStoreInspection> {
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM vectors').get() as { c: number | bigint } | undefined;
      const count = row ? Number(row.c) : 0;
      return {
        persisted: count > 0,
        readable: true,
        recordCount: count
      };
    } catch {
      return { persisted: false, readable: false };
    }
  }

  async listByTimeWindow(from: string, to: string): Promise<VectorStoreRecord[]> {
    const stmt = this.db.prepare(
      `SELECT id, text, timestamp, app_name, window_name, embedding, source_types, metadata
       FROM vectors WHERE timestamp BETWEEN ? AND ?`
    );
    const rows = stmt.all(from, to) as Array<{
      id: string; text: string; timestamp: string;
      app_name: string | null; window_name: string | null;
      embedding: Uint8Array; source_types: string; metadata: string | null;
    }>;
    return rows.map(row => ({
      id: row.id,
      text: row.text,
      timestamp: row.timestamp,
      appName: row.app_name ?? undefined,
      windowName: row.window_name ?? undefined,
      embedding: blobToFloat32Array(row.embedding),
      sourceTypes: parseJsonStringArray(row.source_types),
      metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : undefined
    }));
  }

  async deleteByFrameIds(frameIds: ReadonlyArray<string | number>): Promise<number> {
    if (frameIds.length === 0) return 0;

    const targets = new Set(frameIds.map(id => String(id)));
    let total = 0;

    // 1. Delete by extracted:N convention
    const extractedIds = Array.from(targets).map(id => `extracted:${id}`);
    for (const chunk of chunked(extractedIds, MAX_BIND_PARAMS)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const result = this.db.prepare(
        `DELETE FROM vectors WHERE id IN (${placeholders})`
      ).run(...chunk);
      total += Number(result.changes);
    }

    // 2. Delete by legacy metadata.frameId (json_extract returns the
    // JSON value which may be numeric or string — cast both sides)
    const frameIdArray = Array.from(targets);
    for (const chunk of chunked(frameIdArray, MAX_BIND_PARAMS)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const result = this.db.prepare(
        `DELETE FROM vectors WHERE CAST(json_extract(metadata, '$.frameId') AS TEXT) IN (${placeholders}) AND id NOT LIKE 'extracted:%'`
      ).run(...chunk);
      total += Number(result.changes);
    }

    // 3. Delete by captureId
    for (const frameId of targets) {
      const pattern = `%:frame:${frameId}`;
      const result = this.db.prepare(
        `DELETE FROM vectors WHERE json_extract(metadata, '$.captureId') LIKE ? AND id NOT LIKE 'extracted:%'`
      ).run(pattern);
      total += Number(result.changes);
    }

    return total;
  }

  async deleteByTimestampRange(from: string, to: string): Promise<number> {
    // Match InMemoryVectorStore semantics: prefer metadata.frameTimestamp,
    // fall back to record.timestamp when metadata is absent.
    const result = this.db.prepare(
      `DELETE FROM vectors
       WHERE COALESCE(
         NULLIF(json_extract(metadata, '$.frameTimestamp'), ''),
         timestamp
       ) BETWEEN ? AND ?`
    ).run(from, to);
    return Number(result.changes);
  }

  async close(): Promise<void> {
    // No-op: SQLite handle lifecycle managed by create-app.ts
  }
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch { /* fall through */ }
  return [];
}
