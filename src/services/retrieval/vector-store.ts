import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parseCaptureId } from '../capture/types.js';

import { resolveRetrievalArtifactsDirectory } from '../../config/paths.js';
import type { AppConfig } from '../../types/app-config.js';
import type { RetrievalEvidenceItem, VectorStore, VectorStoreInspection, VectorStoreRecord, VectorSearchRequest } from './types.js';
import { SqliteVectorStore } from './sqlite-vector-store.js';
import type { DerivedDatabase } from '../work-activity/derived-database.js';

interface PersistedVectorStorePayload {
  records: VectorStoreRecord[];
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isVectorStoreRecord(value: unknown): value is VectorStoreRecord {
  if (!isObjectRecord(value)) {
    return false;
  }

  return typeof value.id === 'string'
    && typeof value.text === 'string'
    && typeof value.timestamp === 'string'
    && (value.appName === undefined || typeof value.appName === 'string')
    && (value.embedding === undefined || (Array.isArray(value.embedding) && value.embedding.every(isFiniteNumber)))
    && (value.metadata === undefined || isObjectRecord(value.metadata));
}

function parsePersistedVectorStorePayload(raw: string): PersistedVectorStorePayload {
  const parsed = JSON.parse(raw) as unknown;
  if (!isObjectRecord(parsed) || !Array.isArray(parsed.records) || !parsed.records.every(isVectorStoreRecord)) {
    throw new Error('Invalid vector store payload.');
  }

  return {
    records: parsed.records
  };
}

function dotProduct(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let total = 0;

  for (let index = 0; index < length; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }

  return total;
}

function toEvidence(record: VectorStoreRecord, request: VectorSearchRequest): RetrievalEvidenceItem {
  return {
    id: record.id,
    text: record.text,
    timestamp: record.timestamp,
    appName: record.appName,
    windowName: record.windowName,
    source: 'semantic' as const,
    sourceTypes: (record.metadata?.sourceTypes as string[] | undefined) ?? record.sourceTypes ?? [],
    score: Number(dotProduct(record.embedding ?? [], request.queryEmbedding).toFixed(6))
  };
}

function compareTimestamps(left: string, right: string): number {
  const leftMillis = Date.parse(left);
  const rightMillis = Date.parse(right);
  if (!Number.isNaN(leftMillis) && !Number.isNaN(rightMillis)) {
    return leftMillis - rightMillis;
  }

  return left.localeCompare(right);
}

function filterRecords(records: VectorStoreRecord[], request: VectorSearchRequest): VectorStoreRecord[] {
  return records.filter((record) => {
    const matchesApp = request.appName ? record.appName === request.appName : true;
    const matchesFrom = request.from ? compareTimestamps(record.timestamp, request.from) >= 0 : true;
    const matchesTo = request.to ? compareTimestamps(record.timestamp, request.to) <= 0 : true;
    const hasEmbedding = Array.isArray(record.embedding) && record.embedding.length > 0;
    return matchesApp && matchesFrom && matchesTo && hasEmbedding;
  });
}

function queryRecords(records: VectorStoreRecord[], request: VectorSearchRequest): RetrievalEvidenceItem[] {
  const limit = request.limit ?? 10;
  const offset = request.offset ?? 0;

  return filterRecords(records, request)
    .map((record) => toEvidence(record, request))
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(offset, offset + limit);
}

export function resolveVectorStoreDirectory(config: AppConfig['vectorStore']): string {
  return resolveRetrievalArtifactsDirectory(config);
}

export function resolveVectorStoreFilePath(config: AppConfig['vectorStore']): string {
  return join(resolveVectorStoreDirectory(config), 'vector-store.json');
}

export class InMemoryVectorStore implements VectorStore {
  readonly kind: string;
  protected readonly records: VectorStoreRecord[] = [];

  constructor(config: AppConfig['vectorStore']) {
    this.kind = config.kind;
  }

  async upsert(records: VectorStoreRecord[]): Promise<void> {
    const incoming = new Map(records.map((record) => [record.id, record]));
    const retained = this.records.filter((record) => !incoming.has(record.id));
    this.records.splice(0, this.records.length, ...retained, ...records);
  }

  async reset(): Promise<void> {
    this.records.splice(0, this.records.length);
  }

  async inspect(): Promise<VectorStoreInspection> {
    return {
      persisted: this.records.length > 0,
      readable: true,
      recordCount: this.records.length
    };
  }

  async query(request: VectorSearchRequest): Promise<RetrievalEvidenceItem[]> {
    return queryRecords(this.records, request);
  }

  async querySnapshot(request: VectorSearchRequest): Promise<RetrievalEvidenceItem[]> {
    return queryRecords(this.records, request);
  }

  async listByTimeWindow(from: string, to: string): Promise<VectorStoreRecord[]> {
    return this.records.filter((record) => {
      const matchesFrom = compareTimestamps(record.timestamp, from) >= 0;
      const matchesTo = compareTimestamps(record.timestamp, to) <= 0;
      return matchesFrom && matchesTo;
    });
  }

  async deleteByFrameIds(frameIds: ReadonlyArray<string | number>): Promise<number> {
    const targets = new Set(frameIds.map((id) => String(id)));
    if (targets.size === 0) {
      return 0;
    }

    const before = this.records.length;
    const remaining = this.records.filter((record) => {
      // Match on legacy metadata.frameId key (records written before the
      // captureId migration) OR on the neutral metadata.captureId key
      // (records written after Task 5 dual-write). A record is deleted
      // when EITHER key resolves to a target frame id.
      const legacyFrameId = record.metadata?.frameId;
      const matchesLegacy = legacyFrameId !== undefined && legacyFrameId !== null
        && targets.has(String(legacyFrameId));

      const captureId = record.metadata?.captureId;
      const captureParts = typeof captureId === 'string' ? parseCaptureId(captureId) : null;
      const matchesCapture = captureParts?.kind === 'frame' && targets.has(captureParts.value);

      return !matchesLegacy && !matchesCapture;
    });

    this.records.splice(0, this.records.length, ...remaining);
    return before - remaining.length;
  }

  async deleteByTimestampRange(from: string, to: string): Promise<number> {
    const before = this.records.length;
    const remaining = this.records.filter((record) => {
      const metadataTimestamp = record.metadata?.frameTimestamp;
      const timestamp =
        typeof metadataTimestamp === 'string' && metadataTimestamp.length > 0
          ? metadataTimestamp
          : record.timestamp;
      const inRange =
        compareTimestamps(timestamp, from) >= 0 && compareTimestamps(timestamp, to) <= 0;
      return !inRange;
    });

    this.records.splice(0, this.records.length, ...remaining);
    return before - remaining.length;
  }
}

export class FileBackedVectorStore extends InMemoryVectorStore {
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor(
    config: AppConfig['vectorStore'],
    private readonly filePath: string
  ) {
    super(config);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = await readFile(this.filePath, 'utf8');
          const parsed = parsePersistedVectorStorePayload(raw);
          this.records.splice(0, this.records.length, ...parsed.records);
        } catch (error) {
          const nodeError = error as NodeJS.ErrnoException;
          if (nodeError.code !== 'ENOENT') {
            throw new Error(`Failed to load vector store at ${this.filePath}: ${nodeError.message}`);
          }
        }

        this.loaded = true;
      })().finally(() => {
        this.loadPromise = null;
      });
    }

    await this.loadPromise;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: PRIVATE_DIR_MODE });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(
      tempPath,
      JSON.stringify({ records: this.records } satisfies PersistedVectorStorePayload),
      { encoding: 'utf8', mode: PRIVATE_FILE_MODE }
    );
    await rename(tempPath, this.filePath);
  }

  override async upsert(records: VectorStoreRecord[]): Promise<void> {
    await this.ensureLoaded();
    await super.upsert(records);
    await this.persist();
  }

  async reset(): Promise<void> {
    this.records.splice(0, this.records.length);
    this.loaded = true;
    this.loadPromise = null;
    await this.persist();
  }

  async inspect(): Promise<VectorStoreInspection> {
    try {
      const handle = await open(this.filePath, 'r');
      try {
        const stats = await handle.stat();
        if (stats.size === 0) {
          return {
            persisted: true,
            readable: false,
            recordCount: 0
          };
        }

        const raw = await handle.readFile({ encoding: 'utf8' });
        const parsed = parsePersistedVectorStorePayload(raw);
        return {
          persisted: parsed.records.length > 0,
          readable: true,
          recordCount: parsed.records.length
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return {
          persisted: false,
          readable: true
        };
      }

      return {
        persisted: true,
        readable: false
      };
    }
  }

  override async query(request: VectorSearchRequest): Promise<RetrievalEvidenceItem[]> {
    await this.ensureLoaded();
    return super.query(request);
  }

  override async querySnapshot(request: VectorSearchRequest): Promise<RetrievalEvidenceItem[]> {
    await this.ensureLoaded();
    return super.querySnapshot(request);
  }

  override async listByTimeWindow(from: string, to: string): Promise<VectorStoreRecord[]> {
    await this.ensureLoaded();
    return super.listByTimeWindow(from, to);
  }

  override async deleteByFrameIds(frameIds: ReadonlyArray<string | number>): Promise<number> {
    await this.ensureLoaded();
    const deleted = await super.deleteByFrameIds(frameIds);
    if (deleted > 0) {
      await this.persist();
    }
    return deleted;
  }

  override async deleteByTimestampRange(from: string, to: string): Promise<number> {
    await this.ensureLoaded();
    const deleted = await super.deleteByTimestampRange(from, to);
    if (deleted > 0) {
      await this.persist();
    }
    return deleted;
  }

  async close(): Promise<void> {
    await this.ensureLoaded();
    await this.persist();
  }
}

export { SqliteVectorStore } from './sqlite-vector-store.js';

export function createVectorStore(config: AppConfig, db?: DerivedDatabase): VectorStore {
  if (config.vectorStore.kind === 'file') {
    return new FileBackedVectorStore(config.vectorStore, resolveVectorStoreFilePath(config.vectorStore));
  }
  if (!db) {
    throw new Error('SqliteVectorStore requires a DerivedDatabase handle');
  }
  return new SqliteVectorStore(db);
}
