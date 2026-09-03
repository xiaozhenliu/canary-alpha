/**
 * End-to-end integration test for the work-activity-analysis indexing
 * tail (task 6.3).
 *
 * The test wires the **real** collaborators
 * (`DefaultExtractionRegistry`, `SqliteExtractedContentStore`,
 * `SqliteSessionStore` + `DefaultSessionAggregator`, `SqliteHashIndex`
 * + `DefaultEmbeddingService`) against an in-memory derived database
 * (`openDerivedDatabase(':memory:')` + `initDerivedSchema`) and an
 * `InMemoryVectorStore`, then drives `IndexingService.runOnce()`
 * through a `StubScreenpipeClient` carrying hand-crafted AX frames.
 *
 * The point of going through the production wiring (instead of the
 * legacy `createLegacyIndexingService` shim) is to validate the four
 * end-to-end invariants the spec calls out for task 6.3:
 *
 *   1. **Coverage (R1.1)** — every privacy-allowed frame produces
 *      exactly one row in `extracted_content`.
 *   2. **Refinement_Override (R1.4 / W3)** — frames whose `appName`
 *      hits `TERMINAL_APP_NAMES` get tagged with
 *      `extraction_rule_kind === 'terminal'`; everything else gets
 *      `'generic'`.
 *   3. **Session boundaries (R3.3 / R3.5)** — same `(appName,
 *      contextKey)` within `idleThresholdSeconds` extends the same
 *      session; an app switch starts a new session; a same-app frame
 *      that exceeds `idleThresholdSeconds` since the previous frame
 *      starts a new session.
 *   4. **Vector-store row keying (R5)** — every extracted frame
 *      lands in the vector store under `id === 'extracted:${frameId}'`
 *      with the per-frame metadata Cascade_Delete and the find tool
 *      depend on (`frameId` / `frameTimestamp` / `extractedTextHash`
 *      / `appName` / `contextKey` / `sourceTypes`).
 *
 * **Validates: Requirements 1.1, 1.4, 3.3, 3.5, 3.6, 5.1, 5.2**
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createIndexingService } from '../../../src/services/retrieval/indexing-service.js';
import type {
  CheckpointStore,
  EmbeddingProvider,
  IndexedCheckpoint,
  ScreenpipeClient,
  ScreenpipeRecord,
  VectorStoreRecord
} from '../../../src/services/retrieval/types.js';
import { InMemoryVectorStore } from '../../../src/services/retrieval/vector-store.js';
import {
  initDerivedSchema,
  openDerivedDatabase,
  type DerivedDatabase
} from '../../../src/services/work-activity/derived-database.js';
import { SqliteExtractedContentStore } from '../../../src/services/work-activity/extraction/extracted-content-store.js';
import { createExtractionRegistry } from '../../../src/services/work-activity/extraction/registry.js';
import { SqliteHashIndex } from '../../../src/services/work-activity/hash-index.js';
import { DefaultEmbeddingService } from '../../../src/services/work-activity/embedding-service.js';
import { DefaultSessionAggregator } from '../../../src/services/work-activity/sessions/aggregator.js';
import { SqliteSessionStore } from '../../../src/services/work-activity/sessions/session-store.js';

// ---------------------------------------------------------------------------
// Test doubles — only the upstream-facing slots (embedding provider,
// checkpoint store, screenpipe client, vector store). Everything inside
// the work-activity tail is the real implementation.
// ---------------------------------------------------------------------------

/**
 * Deterministic embedding provider returning a fixed vector. The
 * indexing pipeline does not assert on embedding values; the stub
 * just needs a non-throwing `embed` so each non-empty extraction can
 * land a row in the vector store.
 */
class StubEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'stub';
  readonly embedCalls: string[] = [];

  constructor(
    private readonly shouldFail = false,
    private readonly failOnCall?: number
  ) {}

  async embed(input: string): Promise<number[]> {
    this.embedCalls.push(input);
    if (this.shouldFail || this.embedCalls.length === this.failOnCall) {
      throw new Error('simulated embedding failure');
    }
    return [0.1, 0.2, 0.3];
  }
}

class InMemoryCheckpointStore implements CheckpointStore {
  private checkpoint: IndexedCheckpoint | null = null;

  async readLatest(): Promise<IndexedCheckpoint | null> {
    return this.checkpoint;
  }

  async writeLatest(checkpoint: IndexedCheckpoint): Promise<void> {
    this.checkpoint = checkpoint;
  }

  async reset(): Promise<void> {
    this.checkpoint = null;
  }
}

/**
 * In-process screenpipe client backed by a fixed record list. Mirrors
 * `MetadataTestScreenpipeClient` from
 * `tests/unit/retrieval/properties.test.ts` — kept inline so this
 * suite stays self-contained.
 */
class StubScreenpipeClient implements ScreenpipeClient {
  constructor(private readonly records: ScreenpipeRecord[]) {}

  async search(request: {
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<ScreenpipeRecord[]> {
    const filtered = this.records.filter((record) => {
      const recordTime = Date.parse(record.timestamp);
      const matchesFrom = request.from
        ? recordTime >= Date.parse(request.from)
        : true;
      const matchesTo = request.to
        ? recordTime <= Date.parse(request.to)
        : true;
      return matchesFrom && matchesTo;
    });
    const offset = request.offset ?? 0;
    if (typeof request.limit === 'number') {
      return filtered.slice(offset, offset + request.limit);
    }
    return filtered.slice(offset);
  }

  async recent(_minutes: number): Promise<ScreenpipeRecord[]> {
    return this.records;
  }
}

// ---------------------------------------------------------------------------
// AX tree fixtures
// ---------------------------------------------------------------------------

interface AXTreeNode {
  role: string;
  value?: string;
  children?: AXTreeNode[];
}

/** AXApplication → AXTextArea fixture used by terminal frames. */
function terminalTree(text: string): string {
  const tree: AXTreeNode = {
    role: 'AXApplication',
    children: [{ role: 'AXTextArea', value: text }]
  };
  return JSON.stringify(tree);
}

/** AXApplication → AXWebArea fixture used by non-terminal frames. */
function genericTree(text: string): string {
  const tree: AXTreeNode = {
    role: 'AXApplication',
    children: [{ role: 'AXWebArea', value: text }]
  };
  return JSON.stringify(tree);
}

// ---------------------------------------------------------------------------
// Per-test fixture
// ---------------------------------------------------------------------------

/**
 * Idle threshold used by the aggregator in this test. Anything ≤
 * IDLE_THRESHOLD seconds counts as "same session"; anything >
 * IDLE_THRESHOLD starts a new one.
 */
const IDLE_THRESHOLD = 120;

let db: DerivedDatabase;

beforeEach(() => {
  // Fresh in-memory database per test so we can assert on absolute
  // row counts without worrying about cross-test bleed-through.
  db = openDerivedDatabase(':memory:');
  initDerivedSchema(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wires the production `IndexingService` against the per-test
 * in-memory derived database, an `InMemoryVectorStore`, and the
 * supplied screenpipe client. Returns every collaborator the
 * assertions need to inspect (the database is shared via the closure
 * variable `db`).
 *
 * The `now` provider is mutable via the returned `setNow` helper so
 * tests can drive multi-`runOnce()` scenarios — important for
 * R3.6's `flushIdleOpenSessions` invariant which fires at the start
 * of every run.
 */
function buildIndexingHarness(
  records: ScreenpipeRecord[],
  options: {
    now: Date;
    checkpointStore?: CheckpointStore;
    embeddingShouldFail?: boolean;
    embeddingFailOnCall?: number;
  } = { now: new Date('2026-04-13T11:10:00.000Z') }
): {
  runOnce: (opts?: { forceBacklog?: boolean }) => Promise<void>;
  setNow: (next: Date) => void;
  vectorStore: InMemoryVectorStore;
  embeddingProvider: StubEmbeddingProvider;
  extractedContentStore: SqliteExtractedContentStore;
  sessionStore: SqliteSessionStore;
  checkpointStore: CheckpointStore;
} {
  const embeddingProvider = new StubEmbeddingProvider(
    options.embeddingShouldFail ?? false,
    options.embeddingFailOnCall
  );
  const captureClient = new StubScreenpipeClient(records);
  const vectorStore = new InMemoryVectorStore({
    kind: 'in-memory'
  } as never);
  const checkpointStore = options.checkpointStore ?? new InMemoryCheckpointStore();

  // Mutable clock — the aggregator and embedding service close over
  // the getter, so changes made by `setNow` are visible on the next
  // call without re-wiring dependencies.
  let currentNow = options.now;

  const extractedContentStore = new SqliteExtractedContentStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const hashIndex = new SqliteHashIndex(db);
  const extractionRegistry = createExtractionRegistry();
  let sessionCounter = 0;
  const sessionAggregator = new DefaultSessionAggregator({
    store: sessionStore,
    idleThresholdSeconds: IDLE_THRESHOLD,
    now: () => currentNow,
    // Deterministic, monotonic ids — the test asserts on counts and
    // evidence_frame_ids, not on the literal session_id values, so a
    // counter is enough.
    generateSessionId: () => `sid-${++sessionCounter}`
  });
  const embeddingService = new DefaultEmbeddingService({
    embeddingProvider,
    vectorStore,
    hashIndex,
    now: () => currentNow,
    captureProviderName: 'screenpipe'
  });

  const indexing = createIndexingService({
    embeddingProvider,
    captureClient,
    vectorStore,
    checkpointStore,
    // Wide enough to cover every fixture frame in a single backlog
    // pass, regardless of `now`.
    freshnessWindowMinutes: 60,
    maxCatchUpBatches: 3,
    maxCatchUpRecords: 100,
    extractionRegistry,
    extractedContentStore,
    sessionAggregator,
    sessionStore,
    embeddingService,
    embeddingConcurrency: 1,
    sessionIdleThresholdSeconds: IDLE_THRESHOLD,
    captureProviderName: 'screenpipe'
  });

  return {
    async runOnce(opts: { forceBacklog?: boolean } = {}): Promise<void> {
      const forceBacklog = opts.forceBacklog ?? true;
      if (!forceBacklog) {
        // No forced backlog → the indexing service's standard
        // checkpoint-based flow filters records via
        // `isNewerThanCheckpoint`. Use this for follow-up runs that
        // should NOT re-index already-seen frames (e.g. R3.6 idle
        // flush scenarios).
        await indexing.runOnce(currentNow);
        return;
      }
      // Force-backlog so the run picks up every fixture record
      // regardless of how `freshnessWindowMinutes` interacts with the
      // fixture timestamps. The `from`/`to` covers a generous window
      // around the fixture; the indexing service then bypasses the
      // per-record `isNewerThanCheckpoint` filter — that is the
      // intended semantics for "first-time index" calls.
      const timestamps = records.map((r) => r.timestamp).sort();
      const from = timestamps[0] ?? currentNow.toISOString();
      const to = timestamps[timestamps.length - 1] ?? currentNow.toISOString();
      await indexing.runOnce(currentNow, {
        from,
        to,
        nextOffset: 0
      });
    },
    setNow(next: Date): void {
      currentNow = next;
    },
    vectorStore,
    embeddingProvider,
    extractedContentStore,
    sessionStore,
    checkpointStore
  };
}

/** Reads every row from `extracted_content` ordered by frame_timestamp. */
async function dumpExtractedContent(
  store: SqliteExtractedContentStore
): Promise<
  Array<{
    frameId: number;
    appName: string | undefined;
    contextLabel: string;
    contextKey: string;
    extractionRuleKind: 'generic' | 'terminal';
    extractedText: string;
    extractedTextHash: string | null;
    sourceTypes: string[];
  }>
> {
  // The store does not surface a "list everything" method, so go
  // through `listByTimeWindow` with very wide bounds (the fixture
  // timestamps are well inside).
  const rows = await store.listByTimeWindow(
    '0000-01-01T00:00:00.000Z',
    '9999-12-31T23:59:59.999Z'
  );
  return rows.map((row) => ({
    frameId: row.frameId,
    appName: row.appName,
    contextLabel: row.contextLabel,
    contextKey: row.contextKey,
    extractionRuleKind: row.extractionRuleKind,
    extractedText: row.extractedText,
    extractedTextHash: row.extractedTextHash,
    sourceTypes: row.sourceTypes
  }));
}

/**
 * Returns the vector-store records ordered by `metadata.frameId`
 * ascending, missing-frameId rows trailing. We pull the records via
 * `listByTimeWindow` (with a deliberately wide window) because that
 * method returns the raw `VectorStoreRecord[]` shape including
 * `embedding` + `metadata`, whereas `query()` coerces rows to
 * `RetrievalEvidenceItem`.
 */
async function dumpVectorStoreRecordsAsync(
  vectorStore: InMemoryVectorStore
): Promise<VectorStoreRecord[]> {
  const records = await vectorStore.listByTimeWindow(
    '0000-01-01T00:00:00.000Z',
    '9999-12-31T23:59:59.999Z'
  );
  return records
    .slice()
    .sort((a, b) => {
      const aFrameId = (a.metadata?.frameId as number | undefined) ?? Number.MAX_SAFE_INTEGER;
      const bFrameId = (b.metadata?.frameId as number | undefined) ?? Number.MAX_SAFE_INTEGER;
      return aFrameId - bFrameId;
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IndexingService end-to-end work-activity tail (task 6.3)', () => {
  it('extracts every privacy-allowed frame, routes Terminal vs non-Terminal apps to the right rule, and folds the stream into sessions', async () => {
    // ───────────────────────────────────────────────────────────────
    // Fixture: 5 frames spanning two apps with one same-app idle gap.
    //
    //   Frame 1  iTerm2 / ~/code (zsh)        T0          → terminal rule
    //   Frame 2  iTerm2 / ~/code (zsh)        T0+30s      → terminal rule, same session as #1
    //   Frame 3  Safari / Example Page         T0+60s      → generic rule, new session (app switch)
    //   Frame 4  Safari / Example Page         T0+90s      → generic rule, same session as #3
    //   Frame 5  Safari / Example Page         T0+300s     → generic rule, new session (idle > 120s)
    //
    // Expected sessions (3 total):
    //   S-A: iTerm2  evidence=[1, 2]
    //   S-B: Safari  evidence=[3, 4]
    //   S-C: Safari  evidence=[5]
    //
    // Expected vector-store records: 5 (one per non-empty extraction),
    // ids `extracted:1` … `extracted:5`.
    // ───────────────────────────────────────────────────────────────
    const T0 = Date.parse('2026-04-13T11:00:00.000Z');
    const tsAt = (offsetSeconds: number): string =>
      new Date(T0 + offsetSeconds * 1000).toISOString();

    const records: ScreenpipeRecord[] = [
      {
        id: 'frame-1',
        text: 'ls -la output here',
        timestamp: tsAt(0),
        appName: 'iTerm2',
        windowName: '~/code (zsh)',
        frameId: 1,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: terminalTree('ls -la output here')
      },
      {
        id: 'frame-2',
        text: 'more terminal stuff',
        timestamp: tsAt(30),
        appName: 'iTerm2',
        windowName: '~/code (zsh)',
        frameId: 2,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: terminalTree('more terminal stuff')
      },
      {
        id: 'frame-3',
        text: 'browser body content',
        timestamp: tsAt(60),
        appName: 'Safari',
        windowName: 'Example Page',
        frameId: 3,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: genericTree('browser body content')
      },
      {
        id: 'frame-4',
        text: 'more browser content',
        timestamp: tsAt(90),
        appName: 'Safari',
        windowName: 'Example Page',
        frameId: 4,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: genericTree('more browser content')
      },
      {
        id: 'frame-5',
        text: 'after idle gap',
        // 210s after frame 4 → exceeds the 120s idle threshold, so
        // the aggregator must close the open Safari session and
        // start a new one even though appName + contextKey are
        // unchanged.
        timestamp: tsAt(300),
        appName: 'Safari',
        windowName: 'Example Page',
        frameId: 5,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: genericTree('after idle gap')
      }
    ];

    const harness = buildIndexingHarness(records, {
      now: new Date(T0 + 600 * 1000) // 5 minutes after the last frame
    });

    await harness.runOnce();

    // -------------------------------------------------------------
    // Assertion 1 — Coverage (R1.1): every input frame produces an
    // `extracted_content` row.
    // -------------------------------------------------------------
    const extractedRows = await dumpExtractedContent(harness.extractedContentStore);
    expect(extractedRows).toHaveLength(records.length);
    expect(extractedRows.map((row) => row.frameId).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5
    ]);

    // -------------------------------------------------------------
    // Assertion 2 — Refinement_Override (R1.4 / W3): the Terminal app
    // walks the terminal rule, every other app walks the generic rule.
    // -------------------------------------------------------------
    const byFrameId = new Map(extractedRows.map((row) => [row.frameId, row]));

    expect(byFrameId.get(1)?.extractionRuleKind).toBe('terminal');
    expect(byFrameId.get(2)?.extractionRuleKind).toBe('terminal');
    expect(byFrameId.get(3)?.extractionRuleKind).toBe('generic');
    expect(byFrameId.get(4)?.extractionRuleKind).toBe('generic');
    expect(byFrameId.get(5)?.extractionRuleKind).toBe('generic');

    // Terminal frames use the universal structured output while retaining
    // the terminal rule kind; generic frames use the same body prefix.
    expect(byFrameId.get(1)?.extractedText).toContain('[Body] ls -la output here');
    expect(byFrameId.get(3)?.extractedText).toContain('browser body content');
    // contextLabel preserves the raw window title (un-normalised).
    expect(byFrameId.get(1)?.contextLabel).toBe('~/code (zsh)');
    expect(byFrameId.get(3)?.contextLabel).toBe('Example Page');

    // -------------------------------------------------------------
    // Assertion 3 — session boundaries (R3.3 / R3.5).
    //
    // Three sessions are expected: one for the iTerm2 stretch, one
    // for the first Safari stretch, and one for the post-idle Safari
    // stretch. The aggregator stores `evidence_frame_ids` as a
    // JSON-decoded `number[]`, in time-of-arrival order.
    // -------------------------------------------------------------
    const allSessions = await harness.sessionStore.listSessions({});
    expect(allSessions).toHaveLength(3);

    // Group by app for stable assertion regardless of insert order
    // (the SQL `ORDER BY started_at DESC` already gives newest-first;
    // we group manually so the assertions read as session intent).
    const itermSessions = allSessions.filter((s) => s.app_name === 'iTerm2');
    const safariSessions = allSessions
      .filter((s) => s.app_name === 'Safari')
      // Stable order for assertions: by `started_at` ascending so the
      // first Safari session in the test fixture (frames 3-4) comes
      // before the post-idle one (frame 5).
      .sort((a, b) => a.started_at.localeCompare(b.started_at));

    expect(itermSessions).toHaveLength(1);
    expect(itermSessions[0].evidence_frame_ids).toEqual([1, 2]);
    expect(itermSessions[0].started_at).toBe(records[0].timestamp);
    expect(itermSessions[0].ended_at).toBe(records[1].timestamp);
    // Verify the (appName, contextKey) discriminator the aggregator
    // actually uses — without this, a regression that aggregated
    // purely on `appName` would still pass the count + evidence
    // checks above.
    expect(itermSessions[0].context_key).toBe(byFrameId.get(1)!.contextKey);
    expect(itermSessions[0].context_label).toBe('~/code (zsh)');
    expect(itermSessions[0].source_types).toEqual(['accessibility']);

    expect(safariSessions).toHaveLength(2);
    expect(safariSessions[0].evidence_frame_ids).toEqual([3, 4]);
    expect(safariSessions[0].started_at).toBe(records[2].timestamp);
    expect(safariSessions[0].ended_at).toBe(records[3].timestamp);
    expect(safariSessions[0].context_key).toBe(byFrameId.get(3)!.contextKey);
    expect(safariSessions[0].context_label).toBe('Example Page');

    expect(safariSessions[1].evidence_frame_ids).toEqual([5]);
    expect(safariSessions[1].started_at).toBe(records[4].timestamp);
    expect(safariSessions[1].ended_at).toBe(records[4].timestamp);
    expect(safariSessions[1].context_key).toBe(byFrameId.get(5)!.contextKey);

    // The two Safari sessions are distinct rows, not a re-extension
    // of the same one.
    expect(safariSessions[0].session_id).not.toBe(safariSessions[1].session_id);

    // -------------------------------------------------------------
    // Assertion 4 — vector-store row keying (R5).
    //
    // Every extracted frame produces a vector-store record keyed by
    // `extracted:${frameId}` with the design §5.1 metadata payload.
    // -------------------------------------------------------------
    const vectorRecords = await dumpVectorStoreRecordsAsync(harness.vectorStore);
    expect(vectorRecords).toHaveLength(records.length);
    expect(vectorRecords.map((r) => r.id)).toEqual([
      'extracted:1',
      'extracted:2',
      'extracted:3',
      'extracted:4',
      'extracted:5'
    ]);

    for (const original of records) {
      const upserted = vectorRecords.find(
        (r) => r.id === `extracted:${original.frameId}`
      );
      expect(upserted, `vector store row for frameId=${original.frameId}`).toBeDefined();
      expect(upserted!.metadata!.frameId).toBe(original.frameId);
      expect(upserted!.metadata!.frameTimestamp).toBe(original.timestamp);
      // R5.2 requires `metadata.appName` to always be present —
      // implementation coerces `undefined` to '' so JSON-backed
      // stores round-trip the key. Mirror the contract here.
      expect(upserted!.metadata!.appName).toBe(original.appName ?? '');
      expect(upserted!.metadata!.sourceTypes).toEqual(['accessibility']);

      // Use the extracted_content row as the source of truth for
      // hash + contextKey rather than re-deriving them in the test
      // — the assertion validates that the embedding service writes
      // the same view the SQL/keyword paths see, without re-encoding
      // `normalizeWindowTitle` / `computeExtractedTextHash` here.
      const extracted = byFrameId.get(original.frameId!)!;
      // Sanity guard against the "DB and vector both write null"
      // failure mode: every fixture frame has a non-empty
      // `extractedText`, so the persisted hash MUST be non-null.
      // Without this, the cross-store equality below would still
      // pass even if both columns silently regressed to `null`.
      expect(extracted.extractedTextHash).not.toBeNull();
      expect(upserted!.metadata!.extractedTextHash).toBe(
        extracted.extractedTextHash
      );
      expect(upserted!.metadata!.contextKey).toBe(extracted.contextKey);
    }

    // The embedding provider was called once per extracted text (no
    // hash dedup expected because every fixture text is unique).
    expect(harness.embeddingProvider.embedCalls).toHaveLength(records.length);
  });

  it('writes extracted_content rows for empty extractions but skips embedding them', async () => {
    // Frames whose AX tree is `null` collapse to Empty_Extraction
    // (R1.6) regardless of which rule matches. We deliberately use
    // `accessibilityTreeJson: null` (and not e.g. an AX tree without
    // an anchor) so this test stays stable against future changes
    // to the generic rule's anchor-discovery role set — the design
    // pins `null` as the canonical "no extraction possible" input.
    //
    // The extracted_content row still persists (Coverage), but the
    // embedding service short-circuits (Empty_Skip, W14) so no
    // vector-store row is produced.
    const T0 = Date.parse('2026-04-13T11:00:00.000Z');
    const tsAt = (offsetSeconds: number): string =>
      new Date(T0 + offsetSeconds * 1000).toISOString();

    const records: ScreenpipeRecord[] = [
      {
        id: 'frame-empty',
        // `text` is the empty string so the indexing service's
        // `resolveAccessibilityTreeJson` synthetic-tree fallback
        // does not kick in (it only fires when `text` is non-empty
        // *and* `accessibilityTreeJson` is `undefined`). Combined
        // with the explicit `null` below, the registry receives a
        // null AX tree — both `terminal` and `generic` rules
        // collapse to Empty_Extraction.
        text: '',
        timestamp: tsAt(0),
        appName: 'Notes',
        windowName: 'Untitled',
        frameId: 10,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: null
      },
      {
        id: 'frame-non-empty',
        text: 'document body text',
        timestamp: tsAt(30),
        appName: 'Notes',
        windowName: 'Untitled',
        frameId: 11,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: genericTree('document body text')
      }
    ];

    const harness = buildIndexingHarness(records, {
      now: new Date(T0 + 600 * 1000)
    });

    await harness.runOnce();

    // Both frames have an extracted_content row (Coverage).
    const extractedRows = await dumpExtractedContent(harness.extractedContentStore);
    expect(extractedRows).toHaveLength(2);

    const emptyRow = extractedRows.find((r) => r.frameId === 10);
    const nonEmptyRow = extractedRows.find((r) => r.frameId === 11);
    expect(emptyRow).toBeDefined();
    expect(emptyRow!.extractedText).toBe(''); // Empty_Extraction
    // Hash MUST be null for empty extractions — the embedding
    // service's Empty_Skip branch short-circuits on `extractedText
    // === ''`, not on the hash, but the `extracted_content` row
    // contract (design §1) pairs empty text with null hash.
    expect(emptyRow!.extractedTextHash).toBeNull();
    expect(emptyRow!.contextLabel).toBe('Untitled'); // R1.6 — non-empty
    expect(nonEmptyRow!.extractedText).toContain('document body text');
    expect(nonEmptyRow!.extractedTextHash).not.toBeNull();

    // Only the non-empty frame produced a vector-store row — the
    // empty frame's `extracted:10` id MUST NOT exist.
    const vectorRecords = await dumpVectorStoreRecordsAsync(harness.vectorStore);
    expect(vectorRecords).toHaveLength(1);
    expect(vectorRecords[0].id).toBe('extracted:11');
    expect(
      vectorRecords.find((r) => r.id === 'extracted:10'),
      'empty extractions MUST NOT produce a vector-store row'
    ).toBeUndefined();

    // The embedding provider was called exactly once, for the non-
    // empty extraction.
    expect(harness.embeddingProvider.embedCalls).toEqual(['[Body] document body text']);
  });

  it('closes idle Open_Sessions on the next runOnce via flushIdleOpenSessions (R3.6)', async () => {
    // Drives two `runOnce()` calls separated by enough wall-clock
    // time that the Open_Session created in the first run becomes
    // idle (`now - ended_at > idleThreshold`). The second run picks
    // up no new frames, but the entry-of-runOnce
    // `flushIdleOpenSessions` MUST close the stale row anyway.
    const T0 = Date.parse('2026-04-13T11:00:00.000Z');
    const tsAt = (offsetSeconds: number): string =>
      new Date(T0 + offsetSeconds * 1000).toISOString();

    const records: ScreenpipeRecord[] = [
      {
        id: 'frame-1',
        text: 'editing notes',
        timestamp: tsAt(0),
        appName: 'Notes',
        windowName: 'Untitled',
        frameId: 1,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: genericTree('editing notes')
      }
    ];

    const harness = buildIndexingHarness(records, {
      // First run's `now` is just past the frame timestamp so the
      // session opens but does not yet meet the idle close
      // condition.
      now: new Date(T0 + 10 * 1000)
    });

    await harness.runOnce();

    // After run 1: one open session with the expected evidence.
    const afterRun1 = await harness.sessionStore.listSessions({});
    expect(afterRun1).toHaveLength(1);
    expect(afterRun1[0].is_open).toBe(true);
    expect(afterRun1[0].closed_at).toBeNull();
    expect(afterRun1[0].evidence_frame_ids).toEqual([1]);

    // Advance the clock well past the idle threshold and re-run.
    // The fixture has no new frames, but R3.6 mandates that
    // `flushIdleOpenSessions` runs at the start of every
    // `runOnce()` and closes any session whose
    // `ended_at < now - idleThreshold`.
    //
    // Pass `forceBacklog: false` so the indexing service uses its
    // standard checkpoint-based flow — without this the harness
    // would re-process frame 1 via the forced backlog window,
    // which would re-extend the open session before the flush gets
    // a chance to close it. Real production wiring relies on the
    // checkpoint filter for the same reason, so this also
    // exercises the realistic call shape.
    const flushNow = new Date(T0 + (IDLE_THRESHOLD + 60) * 1000);
    harness.setNow(flushNow);
    await harness.runOnce({ forceBacklog: false });

    const afterRun2 = await harness.sessionStore.listSessions({});
    expect(afterRun2).toHaveLength(1);
    expect(afterRun2[0].is_open).toBe(false);
    expect(afterRun2[0].closed_at).toBe(flushNow.toISOString());
    // Evidence is unchanged — the flush only flips the `is_open`
    // flag and stamps `closed_at`; the original session still owns
    // the only frame ingested in run 1.
    expect(afterRun2[0].evidence_frame_ids).toEqual([1]);
    expect(afterRun2[0].session_id).toBe(afterRun1[0].session_id);
  });

  it('starts a new session when contextKey changes within the idle threshold (R3.3 contextKey discriminator)', async () => {
    // Two frames in the same app at gap < idleThreshold but with
    // different `windowName` → different `contextKey`. The
    // aggregator MUST start a new session for the second frame
    // even though the time gap alone would otherwise extend the
    // existing one. Without this assertion the suite would still
    // pass against a regression that aggregated purely on
    // `appName`.
    const T0 = Date.parse('2026-04-13T11:00:00.000Z');
    const tsAt = (offsetSeconds: number): string =>
      new Date(T0 + offsetSeconds * 1000).toISOString();

    const records: ScreenpipeRecord[] = [
      {
        id: 'frame-1',
        text: 'first document',
        timestamp: tsAt(0),
        appName: 'Notes',
        windowName: 'Doc A',
        frameId: 1,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: genericTree('first document')
      },
      {
        id: 'frame-2',
        text: 'second document',
        // Gap of 30s — well inside the 120s idle threshold.
        timestamp: tsAt(30),
        appName: 'Notes',
        // Different windowName → different contextKey. Same app.
        windowName: 'Doc B',
        frameId: 2,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: genericTree('second document')
      }
    ];

    const harness = buildIndexingHarness(records, {
      now: new Date(T0 + 600 * 1000)
    });
    await harness.runOnce();

    const sessions = await harness.sessionStore.listSessions({});
    expect(sessions).toHaveLength(2);

    const byContextLabel = new Map(
      sessions.map((s) => [s.context_label, s])
    );
    expect(byContextLabel.get('Doc A')?.evidence_frame_ids).toEqual([1]);
    expect(byContextLabel.get('Doc B')?.evidence_frame_ids).toEqual([2]);
    // Both sessions ride on the same app but distinct contextKeys.
    expect(byContextLabel.get('Doc A')?.app_name).toBe('Notes');
    expect(byContextLabel.get('Doc B')?.app_name).toBe('Notes');
    expect(byContextLabel.get('Doc A')?.context_key).not.toBe(
      byContextLabel.get('Doc B')?.context_key
    );
  });

  it('extends the same session across `dirty` markers because contextKey normalises them away (R3.4)', async () => {
    // Two frames in the same app whose raw window titles differ
    // only by a `•` "modified" marker. The aggregator MUST treat
    // them as the same session because `Context_Key` strips the
    // marker during normalisation — even though the
    // `context_label` (which preserves the raw title) differs
    // between frames.
    //
    // This test pins the contextKey/contextLabel split: the
    // contextKey discriminator test above shares the same gap +
    // idle settings but flips the contextKey itself, so without
    // this companion case a regression that aggregated purely on
    // `context_label` (or on the raw `windowName`) would still
    // pass everything.
    const T0 = Date.parse('2026-04-13T11:00:00.000Z');
    const tsAt = (offsetSeconds: number): string =>
      new Date(T0 + offsetSeconds * 1000).toISOString();

    const records: ScreenpipeRecord[] = [
      {
        id: 'frame-1',
        text: 'first revision',
        timestamp: tsAt(0),
        appName: 'TextEdit',
        // Saved title (no `•` marker).
        windowName: 'Notes.txt',
        frameId: 1,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: genericTree('first revision')
      },
      {
        id: 'frame-2',
        text: 'second revision',
        timestamp: tsAt(30),
        appName: 'TextEdit',
        // Same document with a `•` modified marker; normalisation
        // strips the marker so the two frames share `context_key`.
        windowName: '• Notes.txt',
        frameId: 2,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: genericTree('second revision')
      }
    ];

    const harness = buildIndexingHarness(records, {
      now: new Date(T0 + 600 * 1000)
    });
    await harness.runOnce();

    const sessions = await harness.sessionStore.listSessions({});
    // Single session — both frames collapse to the same contextKey
    // and the gap is well under the idle threshold.
    expect(sessions).toHaveLength(1);
    expect(sessions[0].evidence_frame_ids).toEqual([1, 2]);

    // The two extracted_content rows have the same `context_key`
    // even though their raw `context_label`s differ — this is the
    // key contract the test pins.
    const extractedRows = await dumpExtractedContent(
      harness.extractedContentStore
    );
    const row1 = extractedRows.find((r) => r.frameId === 1)!;
    const row2 = extractedRows.find((r) => r.frameId === 2)!;
    expect(row1.contextLabel).toBe('Notes.txt');
    expect(row2.contextLabel).toBe('• Notes.txt');
    expect(row1.contextKey).toBe(row2.contextKey);
  });

  it('suppresses identical repeated frames via line delta dedup and only embeds incremental changes (USE-R05)', async () => {
    const T0 = Date.parse('2026-04-13T12:00:00.000Z');
    const tsAt = (offsetSeconds: number): string =>
      new Date(T0 + offsetSeconds * 1000).toISOString();

    const records: ScreenpipeRecord[] = [
      {
        id: 'frame-1',
        text: 'first line',
        timestamp: tsAt(0),
        appName: 'Notes',
        windowName: 'Meeting',
        frameId: 101,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: genericTree('Discussion topic 1')
      },
      {
        id: 'frame-2',
        text: 'identical frame',
        timestamp: tsAt(10),
        appName: 'Notes',
        windowName: 'Meeting',
        frameId: 102,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: genericTree('Discussion topic 1')
      },
      {
        id: 'frame-3',
        text: 'incremental line added',
        timestamp: tsAt(20),
        appName: 'Notes',
        windowName: 'Meeting',
        frameId: 103,
        sourceTypes: ['accessibility'],
        accessibilityTreeJson: JSON.stringify({
          role: 'AXWindow',
          title: 'Meeting',
          children: [
            { role: 'AXTextArea', value: 'Discussion topic 1\nDiscussion topic 2' }
          ]
        })
      }
    ];

    const harness = buildIndexingHarness(records, {
      now: new Date(T0 + 600 * 1000)
    });
    await harness.runOnce();

    const extractedRows = await dumpExtractedContent(harness.extractedContentStore);
    const row1 = extractedRows.find((r) => r.frameId === 101)!;
    const row2 = extractedRows.find((r) => r.frameId === 102)!;
    const row3 = extractedRows.find((r) => r.frameId === 103)!;

    // Frame 1 emitted full text
    expect(row1.extractedText).toContain('Discussion topic 1');
    expect(row1.extractedTextHash).not.toBeNull();

    // Frame 2 was 100% duplicate in the same session -> suppressed to 0 bytes
    expect(row2.extractedText).toBe('');
    expect(row2.extractedTextHash).toBeNull();

    // Frame 3 had 1 new line -> only the new line was emitted
    expect(row3.extractedText).toContain('Discussion topic 2');
    expect(row3.extractedText).not.toContain('Discussion topic 1');
    expect(row3.extractedTextHash).not.toBeNull();

    // Exactly 2 embedding calls were made (Frame 1 and Frame 3); Frame 2 was skipped
    expect(harness.embeddingProvider.embedCalls).toHaveLength(2);

    // All 3 frames were still aggregated into the same session
    const sessions = await harness.sessionStore.listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].evidence_frame_ids).toEqual([101, 102, 103]);
  });

  it('does not reprocess an inclusive checkpoint row from a forced backlog', async () => {
    const timestamp = '2026-09-02T11:30:00.000Z';
    const record: ScreenpipeRecord = {
      id: 'inclusive-checkpoint-frame',
      text: 'checkpoint capture',
      timestamp,
      appName: 'Notes',
      windowName: 'Meeting',
      frameId: 151,
      sourceTypes: ['accessibility'],
      accessibilityTreeJson: genericTree('checkpoint body')
    };
    const harness = buildIndexingHarness([record], {
      now: new Date('2026-09-02T11:30:05.000Z')
    });

    await harness.runOnce();
    const firstRow = (await dumpExtractedContent(harness.extractedContentStore))
      .find((row) => row.frameId === 151)!;
    expect(firstRow.extractedText).toContain('[Body] checkpoint body');

    // The forced backlog starts at the checkpoint timestamp, so the capture
    // client returns the checkpoint row inclusively on this second pass.
    await harness.runOnce();

    const secondRow = (await dumpExtractedContent(harness.extractedContentStore))
      .find((row) => row.frameId === 151)!;
    expect(secondRow.extractedText).toBe(firstRow.extractedText);
    expect(harness.embeddingProvider.embedCalls).toEqual(['[Body] checkpoint body']);

    const sessions = await harness.sessionStore.listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].evidence_frame_ids).toEqual([151]);
  });

  it('restores line-dedup state for an open session after an indexing-service restart', async () => {
    const T0 = Date.parse('2026-04-13T12:00:00.000Z');
    const frame1: ScreenpipeRecord = {
      id: 'frame-1',
      text: 'first capture',
      timestamp: new Date(T0).toISOString(),
      appName: 'Notes',
      windowName: 'Meeting',
      frameId: 201,
      sourceTypes: ['accessibility'],
      accessibilityTreeJson: genericTree('Discussion topic')
    };
    const frame2: ScreenpipeRecord = {
      ...frame1,
      id: 'frame-2',
      text: 'second capture',
      timestamp: new Date(T0 + 10_000).toISOString(),
      frameId: 202
    };
    const frame0: ScreenpipeRecord = {
      ...frame1,
      id: 'frame-0',
      text: 'earlier capture',
      timestamp: new Date(T0 - 10_000).toISOString(),
      frameId: 200
    };

    const firstService = buildIndexingHarness([frame0, frame1], {
      now: new Date(T0 + 5_000)
    });
    await firstService.runOnce();

    const restartedService = buildIndexingHarness([frame0, frame1, frame2], {
      now: new Date(T0 + 15_000),
      checkpointStore: firstService.checkpointStore
    });
    await restartedService.runOnce({ forceBacklog: false });

    const rows = await dumpExtractedContent(restartedService.extractedContentStore);
    const restartedRow = rows.find((row) => row.frameId === 202)!;
    expect(restartedRow.extractedText).toBe('');
    expect(restartedService.embeddingProvider.embedCalls).toEqual([]);

    const sessions = await restartedService.sessionStore.listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].evidence_frame_ids).toEqual([200, 201, 202]);
  });

  it('does not restore an extracted row whose embedding never crossed the checkpoint', async () => {
    const T0 = Date.parse('2026-09-02T12:00:00.000Z');
    const frame1: ScreenpipeRecord = {
      id: 'pending-frame-1',
      text: 'pending capture',
      timestamp: new Date(T0).toISOString(),
      appName: 'Notes',
      windowName: 'Meeting',
      frameId: 301,
      sourceTypes: ['accessibility'],
      accessibilityTreeJson: genericTree('Pending discussion')
    };

    const checkpointStore = new InMemoryCheckpointStore();
    const failedService = buildIndexingHarness([frame1], {
      now: new Date(T0 + 5_000),
      checkpointStore,
      embeddingShouldFail: true
    });
    await expect(failedService.runOnce()).rejects.toThrow('simulated embedding failure');
    await expect(checkpointStore.readLatest()).resolves.toBeNull();

    const restartedService = buildIndexingHarness([frame1], {
      now: new Date(T0 + 15_000),
      checkpointStore
    });
    await restartedService.runOnce({ forceBacklog: false });

    const rows = await dumpExtractedContent(restartedService.extractedContentStore);
    const retriedRow = rows.find((row) => row.frameId === 301)!;
    expect(retriedRow.extractedText).toContain('Pending discussion');
    expect(restartedService.embeddingProvider.embedCalls).toEqual([
      '[Body] Pending discussion'
    ]);
  });

  it('uses capture-cursor order when restoring same-timestamp checkpoint rows', async () => {
    const timestamp = '2026-09-02T12:30:00.000Z';
    const firstFrame: ScreenpipeRecord = {
      id: 'same-time-a',
      text: 'checkpointed capture',
      timestamp,
      appName: 'Notes',
      windowName: 'Meeting',
      frameId: 401,
      sourceTypes: ['accessibility'],
      accessibilityTreeJson: genericTree('checkpointed context')
    };
    const failedFrame: ScreenpipeRecord = {
      id: 'same-time-b',
      text: 'pending capture',
      timestamp,
      appName: 'Notes',
      windowName: 'Meeting',
      frameId: 402,
      sourceTypes: ['accessibility'],
      accessibilityTreeJson: genericTree('pending context')
    };

    const checkpointStore = new InMemoryCheckpointStore();
    const firstService = buildIndexingHarness([firstFrame, failedFrame], {
      now: new Date('2026-09-02T12:30:05.000Z'),
      checkpointStore,
      embeddingFailOnCall: 2
    });
    await firstService.runOnce();
    await expect(checkpointStore.readLatest()).resolves.toEqual({
      cursor: 'same-time-a',
      timestamp
    });

    const restartedService = buildIndexingHarness([firstFrame, failedFrame], {
      now: new Date('2026-09-02T12:30:15.000Z'),
      checkpointStore
    });
    await restartedService.runOnce({ forceBacklog: false });

    const rows = await dumpExtractedContent(restartedService.extractedContentStore);
    const retriedRow = rows.find((row) => row.frameId === 402)!;
    expect(retriedRow.extractedText).toContain('[Body] pending context');
    expect(restartedService.embeddingProvider.embedCalls).toEqual([
      '[Body] pending context'
    ]);
  });

  it('resets deduplication when wall-clock idle flush closes a session before delayed frames', async () => {
    const T0 = Date.parse('2026-09-02T13:00:00.000Z');
    const firstFrame: ScreenpipeRecord = {
      id: 'idle-frame-1',
      text: 'first capture',
      timestamp: new Date(T0).toISOString(),
      appName: 'Notes',
      windowName: 'Meeting',
      frameId: 501,
      sourceTypes: ['accessibility'],
      accessibilityTreeJson: genericTree('same meeting context')
    };
    const delayedFrame: ScreenpipeRecord = {
      ...firstFrame,
      id: 'idle-frame-2',
      text: 'delayed capture',
      timestamp: new Date(T0 + 10_000).toISOString(),
      frameId: 502
    };
    const records: ScreenpipeRecord[] = [firstFrame];
    const harness = buildIndexingHarness(records, {
      now: new Date(T0 + 5_000)
    });
    await harness.runOnce();

    records.push(delayedFrame);
    harness.setNow(new Date(T0 + 600_000));
    await harness.runOnce({ forceBacklog: false });

    const rows = await dumpExtractedContent(harness.extractedContentStore);
    const delayedRow = rows.find((row) => row.frameId === 502)!;
    expect(delayedRow.extractedText).toContain('[Body] same meeting context');

    const sessions = await harness.sessionStore.listSessions({});
    expect(sessions).toHaveLength(2);
    expect(
      sessions
        .map((session) => session.evidence_frame_ids)
        .sort((a, b) => a[0] - b[0])
    ).toEqual([[501], [502]]);
  });
});
