/**
 * Unit tests for `DefaultCascadeDeleteCoordinator`
 * (work-activity-analysis task 10.1).
 *
 * The coordinator stitches together the three derived-layer stores —
 * `SessionStore`, `ExtractedContentStore`, and `VectorStore` — so the
 * upstream privacy paths (retention pass, `delete-range`) can drop
 * every artefact tied to a set of frames in one call.
 *
 * The tests pivot on the two correctness properties named in design
 * §15:
 *
 *   - **W25 Cascade_Completeness** — after `cascadeByFrameIds(F)` for
 *     any frame-id set F, none of the three stores surface a record
 *     referencing a frame in F. We exercise the property both as a
 *     hand-rolled example and as a fast-check property over a small
 *     synthetic universe (10 frames per run, randomly partitioned into
 *     "delete" and "keep"). The PBT does not need exhaustive coverage
 *     because the coordinator's logic is a thin sequencer; the
 *     property guards against regressions in the call ordering that
 *     would leak rows across stores.
 *
 *   - **W26 No_Re_Sessionize** — a session whose `evidence_frame_ids`
 *     intersects F is removed entirely (R9.2). The aggregator is NOT
 *     re-invoked on the surviving frames in that session. We assert
 *     this by extending a multi-frame session, cascading on a single
 *     frame in the middle, and confirming no replacement session row
 *     reappears.
 *
 * Plus three example-based scenarios for the supporting paths:
 *
 *   - empty-input no-op
 *   - vector-store fallback to `reset()` when `deleteByFrameIds` is
 *     absent (logger receives the warning, `fallbackUsed` flips)
 *   - `cascadeByTimestampRange` removes everything in the window and
 *     additionally sweeps the vector store by timestamp for records
 *     missing `metadata.frameId`
 *
 * **Validates: Requirements 9.1, 9.2**
 */

import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DefaultCascadeDeleteCoordinator,
  type CascadeDeleteCoordinatorDependencies
} from '../../../src/services/work-activity/cascade-delete-coordinator.js';
import {
  DefaultSessionAggregator,
  type SessionAggregator
} from '../../../src/services/work-activity/sessions/aggregator.js';
import { SqliteSessionStore } from '../../../src/services/work-activity/sessions/session-store.js';
import { SqliteExtractedContentStore } from '../../../src/services/work-activity/extraction/extracted-content-store.js';
import {
  initDerivedSchema,
  openDerivedDatabase,
  type DerivedDatabase
} from '../../../src/services/work-activity/derived-database.js';
import type {
  RetrievalEvidenceItem,
  VectorSearchRequest,
  VectorStore,
  VectorStoreInspection,
  VectorStoreRecord
} from '../../../src/services/retrieval/types.js';
import type { ExtractionResult } from '../../../src/services/work-activity/extraction/types.js';
import type { Logger } from '../../../src/types/app-config.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const IDLE_THRESHOLD = 120;

/**
 * Lightweight in-memory `VectorStore` that mirrors the production
 * `InMemoryVectorStore` semantics needed by the coordinator. We
 * implement `deleteByFrameIds` / `deleteByTimestampRange` so the
 * primary path is exercised, and re-use `query` semantics for the
 * Cascade_Completeness assertion (a record is considered "visible" if
 * `query()` could return it).
 *
 * Building a fresh class instead of pulling in `InMemoryVectorStore`
 * keeps the test surface small and decouples this test from the file
 * I/O wiring that ships with the production class.
 */
class FakeVectorStore implements VectorStore {
  readonly kind = 'fake';
  records: VectorStoreRecord[] = [];

  async upsert(records: VectorStoreRecord[]): Promise<void> {
    const incoming = new Map(records.map((r) => [r.id, r]));
    const retained = this.records.filter((r) => !incoming.has(r.id));
    this.records = [...retained, ...records];
  }

  async reset(): Promise<void> {
    this.records = [];
  }

  async query(_request: VectorSearchRequest): Promise<RetrievalEvidenceItem[]> {
    // Cascade_Completeness asserts on the survival of records, not on
    // ranking, so a trivial mapping is sufficient. A record is
    // "visible" iff it is still in `this.records`.
    return this.records.map((r) => ({
      id: r.id,
      text: r.text,
      timestamp: r.timestamp,
      appName: r.appName,
      windowName: r.windowName,
      score: 0,
      source: 'semantic',
      sourceTypes: r.sourceTypes ?? []
    }));
  }

  async inspect(): Promise<VectorStoreInspection> {
    return { persisted: this.records.length > 0, readable: true, recordCount: this.records.length };
  }

  async deleteByFrameIds(frameIds: ReadonlyArray<string | number>): Promise<number> {
    const targets = new Set(frameIds.map((id) => String(id)));
    const before = this.records.length;
    this.records = this.records.filter((r) => {
      const frameId = r.metadata?.frameId;
      if (frameId === undefined || frameId === null) return true;
      return !targets.has(String(frameId));
    });
    return before - this.records.length;
  }

  async deleteByTimestampRange(from: string, to: string): Promise<number> {
    const before = this.records.length;
    this.records = this.records.filter((r) => {
      const metaTs = r.metadata?.frameTimestamp;
      const ts = typeof metaTs === 'string' && metaTs.length > 0 ? metaTs : r.timestamp;
      const inRange = ts >= from && ts <= to;
      return !inRange;
    });
    return before - this.records.length;
  }
}

/**
 * Vector store missing the optional fine-grained delete methods —
 * exercises the design §11.2 fallback path that calls `reset()`.
 */
class LegacyVectorStore implements VectorStore {
  readonly kind = 'legacy';
  records: VectorStoreRecord[] = [];

  async upsert(records: VectorStoreRecord[]): Promise<void> {
    this.records.push(...records);
  }
  async reset(): Promise<void> {
    this.records = [];
  }
  async query(): Promise<RetrievalEvidenceItem[]> {
    return [];
  }
  // Deliberately no `deleteByFrameIds` / `deleteByTimestampRange`.
}

/**
 * Builds a deterministic vector-store record tied to a derived
 * `extracted_content` row. The id pattern matches what
 * `DefaultEmbeddingService` writes (`extracted:${frameId}`) so cascade
 * tests reflect the production wire format.
 */
function buildVectorRecord(
  frameId: number,
  frameTimestamp: string,
  text = `text-${frameId}`
): VectorStoreRecord {
  return {
    id: `extracted:${frameId}`,
    text,
    timestamp: frameTimestamp,
    sourceTypes: ['accessibility'],
    embedding: [frameId / 100, frameId / 1000, frameId / 10000],
    metadata: {
      frameId,
      frameTimestamp,
      sourceTypes: ['accessibility']
    }
  };
}

/**
 * Builds an `ExtractionResult` with sensible defaults — tests override
 * `frameId`, `frameTimestamp`, and `appName`/`contextKey` to set up
 * scenarios. The hash is deterministic per `frameId` so PBT runs do
 * not collide.
 */
function makeExtraction(
  frameId: number,
  overrides: Partial<ExtractionResult> = {}
): ExtractionResult {
  return {
    frameId,
    frameTimestamp: tsAt(frameId),
    appName: 'Editor',
    contextLabel: 'main.ts',
    contextKey: 'Editor::main.ts',
    extractedText: `text-${frameId}`,
    extractedTextHash: `hash-${frameId}`.padEnd(64, '0'),
    extractionRuleKind: 'generic',
    sourceTypes: ['accessibility'],
    ...overrides
  };
}

/**
 * Builds an ISO 8601 timestamp `secondsAfterEpoch` seconds after the
 * arbitrary base `2026-06-01T12:00:00Z`. Mirrors the helper used in
 * the rest of the work-activity unit tests so timestamps are
 * comparable across files.
 */
function tsAt(secondsAfterEpoch: number): string {
  const base = Date.UTC(2026, 5, 1, 12, 0, 0); // month is 0-indexed
  return new Date(base + secondsAfterEpoch * 1000).toISOString();
}

interface Fixture {
  db: DerivedDatabase;
  sessionStore: SqliteSessionStore;
  extractedContentStore: SqliteExtractedContentStore;
  vectorStore: FakeVectorStore;
  aggregator: SessionAggregator;
  coordinator: DefaultCascadeDeleteCoordinator;
}

/**
 * Wires a fresh in-memory derived database, three stores, an
 * aggregator (for W26 No_Re_Sessionize), and the coordinator under
 * test. Each test gets its own fixture via `beforeEach` so cross-test
 * state cannot leak.
 */
function buildFixture(
  vectorStoreOverride?: VectorStore,
  loggerOverride?: Logger
): Fixture {
  const db = openDerivedDatabase(':memory:');
  initDerivedSchema(db);
  const sessionStore = new SqliteSessionStore(db);
  const extractedContentStore = new SqliteExtractedContentStore(db);
  const vectorStore = (vectorStoreOverride ?? new FakeVectorStore()) as FakeVectorStore;

  let counter = 0;
  const aggregator = new DefaultSessionAggregator({
    store: sessionStore,
    idleThresholdSeconds: IDLE_THRESHOLD,
    now: () => new Date('2026-06-02T00:00:00.000Z'),
    generateSessionId: () => `sid-${++counter}`
  });

  const deps: CascadeDeleteCoordinatorDependencies = {
    sessionStore,
    extractedContentStore,
    vectorStore,
    logger: loggerOverride
  };
  const coordinator = new DefaultCascadeDeleteCoordinator(deps);

  return {
    db,
    sessionStore,
    extractedContentStore,
    vectorStore,
    aggregator,
    coordinator
  };
}

/**
 * Drives a sequence of frames through the full extraction + session
 * + vector-store pipeline (the parts the cascade test cares about).
 * Returns the list of session ids that the aggregator created so
 * tests can assert specific rows were removed.
 */
async function ingestFrames(
  fixture: Fixture,
  extractions: ExtractionResult[]
): Promise<void> {
  for (const e of extractions) {
    await fixture.extractedContentStore.upsert(e);
    await fixture.aggregator.handleExtraction(e);
    await fixture.vectorStore.upsert([buildVectorRecord(e.frameId, e.frameTimestamp, e.extractedText)]);
  }
}

// ---------------------------------------------------------------------------
// Per-test fixture
// ---------------------------------------------------------------------------

let fixture: Fixture;

beforeEach(() => {
  fixture = buildFixture();
});

afterEach(() => {
  fixture.db.close();
});

// ---------------------------------------------------------------------------
// Empty-input fast path
// ---------------------------------------------------------------------------

describe('DefaultCascadeDeleteCoordinator.cascadeByFrameIds — empty fast path', () => {
  it('returns the zero result without touching the stores when frameIds is empty', async () => {
    // Seed a row to confirm the coordinator does NOT touch anything
    // when handed an empty list. SQLite would otherwise reject `IN ()`
    // and the wrapper stores have their own empty fast-paths — this
    // assertion exercises the coordinator's own short-circuit.
    await ingestFrames(fixture, [makeExtraction(1)]);

    const result = await fixture.coordinator.cascadeByFrameIds([]);
    expect(result).toEqual({
      extractedContent: 0,
      sessions: 0,
      embeddings: 0,
      fallbackUsed: 'none'
    });

    // Pre-existing data is intact.
    expect(await fixture.extractedContentStore.getByFrameIds([1])).toHaveLength(1);
    expect(fixture.vectorStore.records).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// W25 Cascade_Completeness — example-based
// ---------------------------------------------------------------------------

describe('DefaultCascadeDeleteCoordinator.cascadeByFrameIds — W25 Cascade_Completeness (example)', () => {
  it('removes the matching row from extracted_content, sessions, and the vector store', async () => {
    // Two sessions (Editor on main.ts, Browser on docs) so we have
    // both surviving and deleted rows on each store.
    await ingestFrames(fixture, [
      makeExtraction(1, { contextKey: 'Editor::main.ts' }),
      makeExtraction(2, {
        contextKey: 'Editor::main.ts',
        frameTimestamp: tsAt(2)
      }),
      makeExtraction(3, {
        appName: 'Browser',
        contextKey: 'Browser::docs',
        frameTimestamp: tsAt(3)
      })
    ]);

    const result = await fixture.coordinator.cascadeByFrameIds([1, 2]);

    expect(result.extractedContent).toBe(2);
    expect(result.sessions).toBe(1); // The Editor session covered both frames.
    expect(result.embeddings).toBe(2);
    expect(result.fallbackUsed).toBe('none');

    // 1) extracted_content
    expect(await fixture.extractedContentStore.getByFrameIds([1, 2])).toEqual([]);
    const remaining = await fixture.extractedContentStore.getByFrameIds([3]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].frameId).toBe(3);

    // 2) sessions — Editor session deleted, Browser session preserved.
    const sessionsLeft = await fixture.sessionStore.listSessions({});
    expect(sessionsLeft).toHaveLength(1);
    expect(sessionsLeft[0].evidence_frame_ids).toEqual([3]);

    // 3) vectorStore — query returns no record carrying a frameId in the
    // deleted set.
    const queried = await fixture.vectorStore.query({
      queryEmbedding: [0, 0, 0]
    });
    const visibleFrameIds = queried.map((item) => Number(item.id.replace('extracted:', '')));
    expect(visibleFrameIds).not.toContain(1);
    expect(visibleFrameIds).not.toContain(2);
    expect(visibleFrameIds).toContain(3);
  });
});

// ---------------------------------------------------------------------------
// W25 Cascade_Completeness — property-based (small universe)
// ---------------------------------------------------------------------------

describe('DefaultCascadeDeleteCoordinator.cascadeByFrameIds — W25 Cascade_Completeness (PBT)', () => {
  it(
    'never leaves a record referencing a deleted frame across all three stores',
    async () => {
      // Generator: a small frame universe (5..14) split into two
      // disjoint sets — `toDelete` (the cascade target) and `toKeep`
      // (rows we expect to survive). Both sets may be empty; the
      // generator below skips the all-empty case to keep the
      // assertions meaningful.
      const arb = fc
        .tuple(
          fc.subarray([5, 6, 7, 8, 9, 10, 11, 12, 13, 14], { minLength: 0, maxLength: 10 }),
          fc.subarray([5, 6, 7, 8, 9, 10, 11, 12, 13, 14], { minLength: 0, maxLength: 10 })
        )
        .map(([a, b]) => {
          const aSet = new Set(a);
          const bSet = new Set(b.filter((id) => !aSet.has(id)));
          return { toDelete: a, toKeep: [...bSet] };
        })
        .filter(({ toDelete, toKeep }) => toDelete.length + toKeep.length > 0);

      await fc.assert(
        fc.asyncProperty(arb, async ({ toDelete, toKeep }) => {
          // Fresh fixture per run so PBT does not bleed state across
          // shrinks.
          const local = buildFixture();
          try {
            const all = [...new Set([...toDelete, ...toKeep])].sort((x, y) => x - y);
            const extractions = all.map((id) =>
              makeExtraction(id, {
                // Spread frames across two apps so multiple sessions
                // exist; sessions whose evidence intersects `toDelete`
                // are expected to disappear, the rest to survive.
                appName: id % 2 === 0 ? 'Editor' : 'Browser',
                contextKey: id % 2 === 0 ? 'Editor::main.ts' : 'Browser::docs',
                frameTimestamp: tsAt(id)
              })
            );
            await ingestFrames(local, extractions);

            await local.coordinator.cascadeByFrameIds(toDelete);

            // Assertion 1 — extracted_content has no row in `toDelete`.
            const extractedRows = await local.extractedContentStore.getByFrameIds(
              toDelete.length === 0 ? [-1] : toDelete
            );
            expect(extractedRows).toHaveLength(0);

            // Assertion 2 — sessions: every surviving session's
            // `evidence_frame_ids` is disjoint from `toDelete`.
            const sessions = await local.sessionStore.listSessions({});
            const deletedSet = new Set(toDelete);
            for (const row of sessions) {
              for (const fid of row.evidence_frame_ids) {
                expect(deletedSet.has(fid)).toBe(false);
              }
            }

            // Assertion 3 — vectorStore: no record visible via
            // `query()` carries a frameId in `toDelete`.
            const queried = await local.vectorStore.query({
              queryEmbedding: [0, 0, 0]
            });
            for (const item of queried) {
              const fid = Number(item.id.replace('extracted:', ''));
              expect(deletedSet.has(fid)).toBe(false);
            }

            // Assertion 4 — extracted_content for `toKeep` rows that
            // were NOT in `toDelete` is intact (cascade is targeted,
            // not a wipe).
            const survivingIds = toKeep.filter((id) => !deletedSet.has(id));
            if (survivingIds.length > 0) {
              const survivors = await local.extractedContentStore.getByFrameIds(survivingIds);
              expect(survivors.map((r) => r.frameId).sort()).toEqual(
                [...survivingIds].sort()
              );
            }
          } finally {
            local.db.close();
          }
        }),
        { numRuns: 50 }
      );
    },
    20_000
  );
});

// ---------------------------------------------------------------------------
// W26 No_Re_Sessionize
// ---------------------------------------------------------------------------

describe('DefaultCascadeDeleteCoordinator.cascadeByFrameIds — W26 No_Re_Sessionize', () => {
  it('removes the entire session row even when only one of multiple frames is in the cascade', async () => {
    // Build a single Editor session containing five frames.
    const extractions = [1, 2, 3, 4, 5].map((i) =>
      makeExtraction(i, { frameTimestamp: tsAt(i) })
    );
    await ingestFrames(fixture, extractions);

    const sessionsBefore = await fixture.sessionStore.listSessions({});
    expect(sessionsBefore).toHaveLength(1);
    expect(sessionsBefore[0].evidence_frame_ids).toEqual([1, 2, 3, 4, 5]);

    // Cascade on a single mid-session frame.
    const result = await fixture.coordinator.cascadeByFrameIds([3]);
    expect(result.sessions).toBe(1);

    // The entire session is gone — the surviving frames are NOT
    // re-bundled into a replacement row.
    const sessionsAfter = await fixture.sessionStore.listSessions({});
    expect(sessionsAfter).toEqual([]);

    // The aggregator is not re-invoked, so even the surviving
    // `extracted_content` rows for frames 1, 2, 4, 5 (which are NOT
    // part of the cascade) do not produce a new session.
    const remaining = await fixture.extractedContentStore.getByFrameIds([1, 2, 3, 4, 5]);
    const remainingIds = remaining.map((r) => r.frameId).sort();
    expect(remainingIds).toEqual([1, 2, 4, 5]);

    // Re-running cascade on an empty set must not magically
    // reconstitute the deleted session.
    await fixture.coordinator.cascadeByFrameIds([]);
    expect(await fixture.sessionStore.listSessions({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// VectorStore fallback path
// ---------------------------------------------------------------------------

describe('DefaultCascadeDeleteCoordinator.cascadeByFrameIds — vector store fallback', () => {
  it('falls back to vectorStore.reset() and warns the logger when deleteByFrameIds is missing', async () => {
    // Build a fixture wired to a legacy vector store that exposes only
    // the bare `VectorStore` surface. The session and extraction
    // stores still receive their delete calls; the vector store loses
    // every record because the fallback is a wipe.
    const legacy = new LegacyVectorStore();
    const warn = vi.fn();
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn()
    };
    const local = buildFixture(legacy, logger);
    try {
      await local.extractedContentStore.upsert(makeExtraction(1));
      await local.aggregator.handleExtraction(makeExtraction(1));
      await legacy.upsert([buildVectorRecord(1, tsAt(1))]);
      // Add an unrelated record to demonstrate the wipe semantics —
      // the fallback intentionally drops everything because metadata
      // attribution is unavailable.
      await legacy.upsert([buildVectorRecord(99, tsAt(99))]);

      const result = await local.coordinator.cascadeByFrameIds([1]);

      expect(result.embeddings).toBe(0);
      expect(result.fallbackUsed).toBe('vector-store-reset');
      expect(legacy.records).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/vectorStore lacks deleteByFrameIds/);

      // Sessions and extracted_content still got their precise
      // deletes — the fallback is scoped to the vector path.
      expect(await local.sessionStore.listSessions({})).toEqual([]);
      expect(await local.extractedContentStore.getByFrameIds([1])).toEqual([]);
    } finally {
      local.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// cascadeByTimestampRange
// ---------------------------------------------------------------------------

describe('DefaultCascadeDeleteCoordinator.cascadeByTimestampRange', () => {
  it('removes every derived artefact whose source frame falls in the closed interval', async () => {
    await ingestFrames(fixture, [
      makeExtraction(1, { frameTimestamp: tsAt(10) }),
      makeExtraction(2, { frameTimestamp: tsAt(20) }),
      makeExtraction(3, {
        appName: 'Browser',
        contextKey: 'Browser::docs',
        frameTimestamp: tsAt(120) // outside the window once we choose
      })
    ]);

    const result = await fixture.coordinator.cascadeByTimestampRange(
      tsAt(0),
      tsAt(60)
    );

    expect(result.extractedContent).toBe(2);
    expect(result.sessions).toBe(1);
    expect(result.embeddings).toBeGreaterThanOrEqual(2);
    expect(result.fallbackUsed).toBe('none');

    // Window contents gone, outside-window survives.
    expect(await fixture.extractedContentStore.getByFrameIds([1, 2])).toEqual([]);
    const survivors = await fixture.extractedContentStore.getByFrameIds([3]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].frameId).toBe(3);

    const sessions = await fixture.sessionStore.listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].evidence_frame_ids).toEqual([3]);

    const queried = await fixture.vectorStore.query({ queryEmbedding: [0, 0, 0] });
    const visibleIds = queried.map((q) => Number(q.id.replace('extracted:', '')));
    expect(visibleIds).toEqual([3]);
  });

  it('also sweeps vector-store records that lack metadata.frameId via deleteByTimestampRange', async () => {
    // Seed a vector record that has no `frameId` metadata — the
    // frame-id pass cannot find it, but the timestamp sweep must.
    await fixture.vectorStore.upsert([
      {
        id: 'orphan',
        text: 'orphan text',
        timestamp: tsAt(15),
        sourceTypes: ['accessibility'],
        embedding: [1, 0, 0],
        metadata: {
          frameTimestamp: tsAt(15)
          // No frameId — simulates an older record from before the
          // metadata schema settled.
        }
      }
    ]);

    // Add one in-window frame so the frame-id pass also runs.
    await ingestFrames(fixture, [makeExtraction(7, { frameTimestamp: tsAt(20) })]);

    const before = fixture.vectorStore.records.map((r) => r.id).sort();
    expect(before).toEqual(['extracted:7', 'orphan']);

    const result = await fixture.coordinator.cascadeByTimestampRange(tsAt(0), tsAt(60));

    // Both records gone — orphan via the timestamp sweep, frame 7 via
    // the frame-id pass. The total embedding count therefore reaches 2.
    expect(fixture.vectorStore.records).toEqual([]);
    expect(result.embeddings).toBe(2);
  });

  it('returns zero counts when the window contains no extracted_content rows', async () => {
    // The empty-frame-id fast path applies here too — `cascadeByFrameIds([])`
    // skips the stores, but the timestamp-range pass still calls
    // `deleteByTimestampRange` on the vector store. With no records
    // the call is a no-op.
    const result = await fixture.coordinator.cascadeByTimestampRange(
      tsAt(0),
      tsAt(60)
    );
    expect(result).toEqual({
      extractedContent: 0,
      sessions: 0,
      embeddings: 0,
      fallbackUsed: 'none'
    });
  });
});
