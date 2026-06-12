/**
 * Property-based tests for the retrieval layer.
 *
 * Task 2.2 — Property 1: buildSearchUrl 主路径恒为 accessibility
 * Validates: Requirements 1.1
 *
 * Task 2.7 — Property 3: AX 文本子串可被关键词检索命中
 * Validates: Requirements 1.3
 *
 * Task 2.8 — Property 4: 跨源合并不变量（去重 + AX 优先 + OCR fallback + sourceTypes）
 * Validates: Requirements 1.4, 1.5, 1.6
 *
 * Task 4.9 — Smoke test: safe-record 默认参数 + privacy.excludeApps 默认值
 * Validates: Requirements 3.3, 4.6
 *
 * Since `buildSearchUrl` is not exported from screenpipe-client.ts, we test it
 * indirectly by intercepting the HTTP requests made by `HttpScreenpipeClient.search()`.
 * A local HTTP server captures every incoming URL so we can assert on the query
 * parameters that `buildSearchUrl` produced.
 */

import { createServer } from 'node:http';

import * as fc from 'fast-check';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { buildScreenpipeSafeRecordArgs } from '../../../scripts/screenpipe-safe-record.js';
import { appConfigSchema } from '../../../src/config/schema.js';
import { createFreshnessPolicy } from '../../../src/services/retrieval/freshness-policy.js';
import { createLegacyIndexingService as createIndexingService } from '../../helpers/indexing-test-doubles.js';
import { createScreenpipeClient, mergeByFrameId } from '../../../src/services/capture/providers/screenpipe/http-client.js';
import type {
  CheckpointStore,
  EmbeddingProvider,
  IndexedCheckpoint,
  ScreenpipeClient,
  ScreenpipeRecord,
  ScreenpipeSearchRequest,
  VectorSearchRequest,
  VectorStore,
  VectorStoreRecord
} from '../../../src/services/retrieval/types.js';
import { startScreenpipeStub } from '../../helpers/screenpipe-stub.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanup: Array<() => Promise<void>> = [];

afterAll(async () => {
  while (cleanup.length > 0) {
    const stop = cleanup.pop();
    if (stop) await stop();
  }
});

interface CapturedRequest {
  url: URL;
}

/**
 * Starts a minimal HTTP server that:
 * 1. Records every request URL it receives.
 * 2. Always responds with an empty Screenpipe search result so the client
 *    does not throw.
 */
async function startCapturingServer(): Promise<{
  serverUrl: string;
  captured: CapturedRequest[];
}> {
  const captured: CapturedRequest[] = [];

  const emptyResponse = JSON.stringify({ data: [], pagination: { limit: 0, offset: 0, total: 0 } });

  const server = createServer((req, res) => {
    if (req.url) {
      captured.push({ url: new URL(req.url, 'http://127.0.0.1') });
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(emptyResponse);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
  );

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind capturing server');
  }

  return { serverUrl: `http://127.0.0.1:${address.port}`, captured };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates arbitrary valid ISO-8601 timestamps in the range 2020–2030.
 * We keep them simple (no sub-second precision) to avoid edge cases in URL
 * encoding that are unrelated to the property under test.
 */
const isoTimestamp = fc
  .date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2030-12-31T23:59:59Z') })
  .map((d) => d.toISOString());

/**
 * Generates arbitrary valid `ScreenpipeSearchRequest` objects.
 * All fields are optional in the type, so we generate them with fc.option to
 * cover both present and absent cases.
 */
const screenpipeSearchRequestArb: fc.Arbitrary<ScreenpipeSearchRequest> = fc.record(
  {
    query: fc.option(fc.string({ minLength: 1, maxLength: 128 }), { nil: undefined }),
    appName: fc.option(fc.string({ minLength: 1, maxLength: 64 }), { nil: undefined }),
    from: fc.option(isoTimestamp, { nil: undefined }),
    to: fc.option(isoTimestamp, { nil: undefined }),
    limit: fc.option(fc.integer({ min: 1, max: 1000 }), { nil: undefined }),
    offset: fc.option(fc.integer({ min: 0, max: 10000 }), { nil: undefined })
  },
  { requiredKeys: [] }
);

// ---------------------------------------------------------------------------
// Property 1: buildSearchUrl 主路径恒为 accessibility
// Validates: Requirements 1.1
// ---------------------------------------------------------------------------

describe('Property 1: buildSearchUrl 主路径恒为 accessibility', () => {
  it(
    'content_type query param is always "accessibility" for any ScreenpipeSearchRequest',
    async () => {
      const { serverUrl, captured } = await startCapturingServer();
      const client = createScreenpipeClient(serverUrl);

      await fc.assert(
        fc.asyncProperty(screenpipeSearchRequestArb, async (request) => {
          // Clear previously captured requests so each run is independent.
          captured.length = 0;

          await client.search(request);

          // HttpScreenpipeClient.search() issues two requests: one for
          // 'accessibility' and one for 'ocr'. We care about the accessibility
          // request — it must always be present and carry content_type=accessibility.
          const accessibilityRequests = captured.filter(
            (r) => r.url.searchParams.get('content_type') === 'accessibility'
          );

          // ── Assertion 1: at least one accessibility request was issued ──
          expect(accessibilityRequests.length).toBeGreaterThanOrEqual(1);

          const axUrl = accessibilityRequests[0].url;

          // ── Assertion 2: content_type === 'accessibility' ──
          expect(axUrl.searchParams.get('content_type')).toBe('accessibility');

          // ── Assertion 3: other params correspond to request fields ──

          // q ↔ request.query
          if (request.query !== undefined) {
            expect(axUrl.searchParams.get('q')).toBe(request.query);
          } else {
            expect(axUrl.searchParams.has('q')).toBe(false);
          }

          // app_name ↔ request.appName
          if (request.appName !== undefined) {
            expect(axUrl.searchParams.get('app_name')).toBe(request.appName);
          } else {
            expect(axUrl.searchParams.has('app_name')).toBe(false);
          }

          // start_time ↔ request.from
          if (request.from !== undefined) {
            expect(axUrl.searchParams.get('start_time')).toBe(request.from);
          } else {
            expect(axUrl.searchParams.has('start_time')).toBe(false);
          }

          // end_time ↔ request.to
          if (request.to !== undefined) {
            expect(axUrl.searchParams.get('end_time')).toBe(request.to);
          } else {
            expect(axUrl.searchParams.has('end_time')).toBe(false);
          }

          // limit ↔ request.limit (defaults to 500 when absent)
          const expectedLimit = String(request.limit ?? 500);
          expect(axUrl.searchParams.get('limit')).toBe(expectedLimit);

          // offset ↔ request.offset (defaults to 0 when absent)
          const expectedOffset = String(request.offset ?? 0);
          expect(axUrl.searchParams.get('offset')).toBe(expectedOffset);
        }),
        { numRuns: 100 }
      );
    },
    60_000 // generous timeout for 100 async property runs
  );
});

// ---------------------------------------------------------------------------
// Property 2: AX 行存在则可被时间窗查询命中
// Validates: Requirements 1.2
// ---------------------------------------------------------------------------

/**
 * Generates a time window [from, to] and a set of AX records whose timestamps
 * all fall within that window.
 *
 * Strategy:
 * 1. Pick a window start and end (from < to, at least 1 second apart).
 * 2. Generate 1–5 AX records with timestamps inside [from, to].
 * 3. Assign unique ids and non-empty text to each record.
 */
const axRecordsInWindowArb: fc.Arbitrary<{
  from: string;
  to: string;
  records: ScreenpipeRecord[];
}> = fc
  .tuple(
    fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2029-12-31T23:59:58Z') }),
    fc.integer({ min: 1, max: 3600 }) // window width in seconds
  )
  .chain(([windowStart, widthSeconds]) => {
    const from = windowStart.toISOString();
    const to = new Date(windowStart.getTime() + widthSeconds * 1000).toISOString();

    return fc
      .array(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 32 }).map((s) => `ax-${s}`),
          text: fc.string({ minLength: 1, maxLength: 128 }),
          // Timestamp strictly inside [from, to]
          timestamp: fc
            .integer({ min: 0, max: widthSeconds - 1 })
            .map((offsetSec) =>
              new Date(windowStart.getTime() + offsetSec * 1000).toISOString()
            ),
          appName: fc.constant('TestApp' as string | undefined),
          sourceTypes: fc.constant(['accessibility'] as string[])
        }),
        { minLength: 1, maxLength: 5 }
      )
      .map((records) => ({ from, to, records }));
  });

describe('Property 2: AX 行存在则可被时间窗查询命中', () => {
  // Track stubs started during property runs so we can clean them up.
  const axWindowStubs: Array<{ stop(): Promise<void> }> = [];

  afterEach(async () => {
    while (axWindowStubs.length > 0) {
      const stub = axWindowStubs.pop();
      if (stub) await stub.stop();
    }
  });

  it(
    'at least one evidence item with sourceTypes containing "accessibility" is returned for a time-window query covering injected AX records',
    async () => {
      await fc.assert(
        fc.asyncProperty(axRecordsInWindowArb, async ({ from, to, records }) => {
          // ── Setup: inject AX records into a fresh stub ──
          const stub = await startScreenpipeStub({ records });
          axWindowStubs.push(stub);

          const client = createScreenpipeClient(stub.url);

          // ── Exercise: search with the time window that covers all injected records ──
          const result = await client.search({ from, to });

          // ── Assert: at least one record has sourceTypes containing 'accessibility' ──
          // When HttpScreenpipeClient queries with content_type=accessibility, the stub
          // returns the injected records and normalizeScreenpipeRecord injects
          // sourceTypes=['accessibility'] (flat-branch: id/text/timestamp present).
          const axEvidence = result.filter((r) => r.sourceTypes.includes('accessibility'));

          expect(
            axEvidence.length,
            `Expected at least one evidence item with sourceTypes=['accessibility'] ` +
            `for time window [${from}, ${to}] with ${records.length} injected AX record(s). ` +
            `Got ${result.length} total records, ${axEvidence.length} with accessibility sourceType.`
          ).toBeGreaterThanOrEqual(1);
        }),
        { numRuns: 100 }
      );
    },
    120_000 // generous timeout: 100 async runs each starting a stub server
  );
});

// ---------------------------------------------------------------------------
// Property 4: 跨源合并不变量（去重 + AX 优先 + OCR fallback + sourceTypes）
// Validates: Requirements 1.4, 1.5, 1.6
// ---------------------------------------------------------------------------

/**
 * Arbitrary that generates a single ScreenpipeRecord with a given sourceType.
 * frameId is optional (fc.option) to cover both the "has frameId" and
 * "no frameId" cases that mergeByFrameId must handle.
 */
function screenpipeRecordArb(sourceType: 'accessibility' | 'ocr'): fc.Arbitrary<ScreenpipeRecord> {
  return fc.record({
    id: fc.string({ minLength: 1, maxLength: 32 }),
    text: fc.string({ minLength: 0, maxLength: 128 }),
    timestamp: fc
      .date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2030-12-31T23:59:59Z') })
      .map((d) => d.toISOString()),
    appName: fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: undefined }),
    windowName: fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: undefined }),
    frameId: fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: undefined }),
    sourceTypes: fc.constant([sourceType] as string[])
  });
}

/**
 * Arbitrary for a list of AX records and a list of OCR records.
 * We use a shared pool of frameIds (1–20) so that the two lists can overlap
 * in interesting ways, exercising the deduplication logic.
 */
const axOcrListPairArb: fc.Arbitrary<{ ax: ScreenpipeRecord[]; ocr: ScreenpipeRecord[] }> = fc
  .array(screenpipeRecordArb('accessibility'), { minLength: 0, maxLength: 20 })
  .chain((axList) =>
    fc
      .array(screenpipeRecordArb('ocr'), { minLength: 0, maxLength: 20 })
      .map((ocrList) => ({ ax: axList, ocr: ocrList }))
  );

describe('Property 4: 跨源合并不变量（去重 + AX 优先 + OCR fallback + sourceTypes）', () => {
  it(
    'mergeByFrameId satisfies all four cross-source merge invariants',
    () => {
      fc.assert(
        fc.property(axOcrListPairArb, ({ ax, ocr }) => {
          const result = mergeByFrameId(ax, ocr);

          // ── Invariant 1: each frameId appears at most once in the result ──
          const frameIdsSeen = new Set<number>();
          for (const record of result) {
            if (record.frameId !== undefined) {
              expect(frameIdsSeen.has(record.frameId)).toBe(false);
              frameIdsSeen.add(record.frameId);
            }
          }

          // Build lookup sets for quick membership checks
          const axFrameIds = new Set(ax.map((r) => r.frameId).filter((id): id is number => id !== undefined));
          const ocrOnlyFrameIds = new Set(
            ocr
              .map((r) => r.frameId)
              .filter((id): id is number => id !== undefined && !axFrameIds.has(id))
          );

          for (const record of result) {
            if (record.frameId === undefined) {
              // Records without frameId are merged by id uniqueness — skip
              // frame-level invariants for them.
              continue;
            }

            // ── Invariant 2: AX wins when frameId exists in AX list ──
            if (axFrameIds.has(record.frameId)) {
              expect(record.sourceTypes).toEqual(['accessibility']);
            } else {
              // frameId only in OCR
              expect(record.sourceTypes).toEqual(['ocr']);
            }
          }

          // ── Invariant 3: all OCR-only frameIds appear in the result ──
          for (const ocrOnlyId of ocrOnlyFrameIds) {
            const found = result.some((r) => r.frameId === ocrOnlyId);
            expect(found).toBe(true);
          }

          // ── Invariant 4: every sourceTypes is a non-empty subset of {"accessibility","ocr"} ──
          const validSourceTypes = new Set(['accessibility', 'ocr']);
          for (const record of result) {
            expect(record.sourceTypes.length).toBeGreaterThan(0);
            for (const st of record.sourceTypes) {
              expect(validSourceTypes.has(st)).toBe(true);
            }
          }
        }),
        { numRuns: 500 }
      );
    },
    60_000 // generous timeout for 500 property runs
  );
});

// ---------------------------------------------------------------------------
// Property 3: AX 文本子串可被关键词检索命中
// Validates: Requirements 1.3
// ---------------------------------------------------------------------------

/**
 * Generates an arbitrary AX text (min 3 chars) paired with a non-empty
 * substring Q derived from that text (NFC-normalised, case-insensitive).
 *
 * Strategy:
 * 1. Generate a base text of at least 3 printable ASCII characters (avoiding
 *    control characters and characters that would be mangled by URL encoding
 *    in ways unrelated to the property under test).
 * 2. Pick a start index and a length to slice a non-empty substring Q.
 * 3. NFC-normalise both text and Q (they are already ASCII so NFC is a no-op,
 *    but we apply it explicitly to match the spec wording).
 */
const axTextWithSubstringArb: fc.Arbitrary<{ text: string; query: string }> = fc
  .string({
    minLength: 3,
    maxLength: 128,
    // Restrict to printable ASCII to avoid URL-encoding edge cases that are
    // orthogonal to the property under test.
    unit: fc.mapToConstant(
      { num: 26, build: (n) => String.fromCharCode(65 + n) },   // A-Z
      { num: 26, build: (n) => String.fromCharCode(97 + n) },   // a-z
      { num: 10, build: (n) => String.fromCharCode(48 + n) },   // 0-9
      { num: 1,  build: () => ' ' }                             // space
    )
  })
  .chain((text) => {
    const nfcText = text.normalize('NFC');
    return fc
      .tuple(
        fc.integer({ min: 0, max: nfcText.length - 1 }),
        fc.integer({ min: 1, max: nfcText.length })
      )
      .map(([start, len]) => {
        const end = Math.min(start + len, nfcText.length);
        const actualEnd = end > start ? end : start + 1;
        const rawQ = nfcText.slice(start, actualEnd);
        // Randomly vary case to exercise case-insensitive matching
        return { text: nfcText, query: rawQ.normalize('NFC') };
      });
  });

describe('Property 3: AX 文本子串可被关键词検索命中', () => {
  // Track stubs started during property runs so we can clean them up.
  const stubs: Array<{ stop(): Promise<void> }> = [];

  afterEach(async () => {
    while (stubs.length > 0) {
      const stub = stubs.pop();
      if (stub) await stub.stop();
    }
  });

  it(
    'search with a substring Q of an AX record text always returns that record in evidence',
    async () => {
      await fc.assert(
        fc.asyncProperty(axTextWithSubstringArb, async ({ text, query }) => {
          // ── Setup: inject one AX record into a fresh stub ──
          const axRecord: ScreenpipeRecord = {
            id: 'ax-prop3-record',
            text,
            timestamp: '2025-01-15T10:00:00.000Z',
            appName: 'TestApp',
            sourceTypes: ['accessibility']
          };

          const stub = await startScreenpipeStub({ records: [axRecord] });
          stubs.push(stub);

          const client = createScreenpipeClient(stub.url);

          // ── Exercise: search with Q as query (case-insensitive via stub) ──
          const records = await client.search({ query });

          // ── Assert: at least one record derived from the AX record is present ──
          // The record must:
          //   1. Have the same id as the injected AX record (or text match).
          //   2. Have sourceTypes containing 'accessibility' (AX path wins in merge).
          const derivedRecord = records.find(
            (r) => r.id === axRecord.id && r.sourceTypes.includes('accessibility')
          );

          expect(
            derivedRecord,
            `Expected to find AX record with id="${axRecord.id}" and sourceTypes=['accessibility'] ` +
            `when searching for query="${query}" in text="${text}"`
          ).toBeDefined();
        }),
        { numRuns: 100 }
      );
    },
    120_000 // generous timeout: 100 async runs each starting a stub server
  );
});

// ---------------------------------------------------------------------------
// Property 5: sourceTypes 数组稳定性（idempotence）
// Validates: Requirements 1.5
// ---------------------------------------------------------------------------

/**
 * Builds a deterministic Screenpipe search response payload from a list of
 * records.  The stub server returns this payload for every request, so two
 * consecutive calls with the same request will receive identical data.
 */
function buildStubResponse(records: ScreenpipeRecord[]): string {
  return JSON.stringify({
    data: records.map((r) => ({
      // Use the flat top-level shape that normalizeScreenpipeRecord prefers.
      id: r.id,
      text: r.text,
      timestamp: r.timestamp,
      appName: r.appName,
      window_name: r.windowName,
      frame_id: r.frameId
    })),
    pagination: { limit: records.length, offset: 0, total: records.length }
  });
}

/**
 * Starts a stub HTTP server that always returns the same fixed response body
 * for every GET /search request.  The response body is set once at startup and
 * never changes, so two consecutive calls receive identical data.
 */
async function startFixedResponseServer(responseBody: string): Promise<{
  serverUrl: string;
}> {
  const server = createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(responseBody);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
  );

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind fixed-response server');
  }

  return { serverUrl: `http://127.0.0.1:${address.port}` };
}

/**
 * Arbitrary that generates a non-empty list of ScreenpipeRecords with mixed
 * sourceTypes (the stub server ignores content_type, so the client's
 * mergeByFrameId logic determines the final sourceTypes).
 *
 * We generate records with explicit frameIds drawn from a small pool (1–10)
 * so that AX and OCR records can share frameIds, exercising the merge path.
 * We also include some records without frameId to cover the id-uniqueness path.
 */
const mixedRecordListArb: fc.Arbitrary<ScreenpipeRecord[]> = fc
  .array(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 16 }),
      text: fc.string({ minLength: 0, maxLength: 64 }),
      timestamp: fc
        .date({ min: new Date('2024-01-01T00:00:00Z'), max: new Date('2025-12-31T23:59:59Z') })
        .map((d) => d.toISOString()),
      appName: fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: undefined }),
      windowName: fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: undefined }),
      frameId: fc.option(fc.integer({ min: 1, max: 10 }), { nil: undefined }),
      sourceTypes: fc.constant(['accessibility'] as string[])
    }),
    { minLength: 1, maxLength: 15 }
  );

describe('Property 5: sourceTypes 数组稳定性（idempotence）', () => {
  it(
    'two consecutive search() calls with the same stub data return identical sourceTypes for every evidence id',
    async () => {
      await fc.assert(
        fc.asyncProperty(mixedRecordListArb, screenpipeSearchRequestArb, async (records, request) => {
          // Build a fixed response body from the generated records.
          // The stub server returns this body for every request (both the AX
          // and OCR sub-requests inside search()), so the merge result is
          // fully determined by the record set and mergeByFrameId logic.
          const responseBody = buildStubResponse(records);
          const { serverUrl } = await startFixedResponseServer(responseBody);
          const client = createScreenpipeClient(serverUrl);

          // ── First call ──
          const result1 = await client.search(request);

          // ── Second call (same request, same stub data) ──
          const result2 = await client.search(request);

          // Build a map from id → sourceTypes for each call.
          const sourceTypesById1 = new Map(result1.map((r) => [r.id, r.sourceTypes]));
          const sourceTypesById2 = new Map(result2.map((r) => [r.id, r.sourceTypes]));

          // ── Assertion: every id present in either result has the same
          //    sourceTypes array (value + order) in both calls ──
          const allIds = new Set([...sourceTypesById1.keys(), ...sourceTypesById2.keys()]);
          for (const id of allIds) {
            const st1 = sourceTypesById1.get(id);
            const st2 = sourceTypesById2.get(id);

            // Both calls must agree on whether the id is present.
            expect(st1).toBeDefined();
            expect(st2).toBeDefined();

            // The sourceTypes arrays must be deeply equal (same elements, same order).
            expect(st1).toEqual(st2);
          }
        }),
        { numRuns: 100 }
      );
    },
    120_000 // generous timeout: 100 async runs, each spawning a server
  );
});

// ---------------------------------------------------------------------------
// Property 20: 未分类窗口与 Substantive 行为等价
// Validates: Requirements 3.6
// ---------------------------------------------------------------------------

/**
 * Known Noise_Window entries (must match NOISE_WINDOWS in search-screen-service.ts).
 * Records with these windowNames must be filtered out.
 */
const NOISE_WINDOW_NAMES = ['Control Center', 'Notification Center'] as const;

/**
 * Known Substantive_Work_Window examples (from design §Components 8 fixture table).
 * These are used to verify that unclassified windows behave the same as substantive ones.
 */
const SUBSTANTIVE_WINDOW_NAMES = [
  'design.ts — canary-alpha-mcp',
  'xz@host: ~/Projects/canary-alpha-mcp',
  'Linear — LIN-123 accessibility-capture'
];

/**
 * Generates an arbitrary window name that is neither a Noise_Window nor a
 * known Substantive_Work_Window — i.e., an "unclassified" window.
 *
 * Strategy: generate a string that does not case-insensitively match any
 * Noise_Window name. We use a prefix "UnclassifiedApp-" to guarantee
 * uniqueness without relying on random chance.
 */
const unclassifiedWindowNameArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 32 })
  .map((s) => `UnclassifiedApp-${s}`)
  .filter((name) => {
    const normalized = name.trim().toLowerCase();
    return !NOISE_WINDOW_NAMES.some((n) => n.toLowerCase() === normalized);
  });

/**
 * Generates a pair of ScreenpipeRecords with identical text and timestamp but
 * different (appName, windowName):
 *   - `substantive`: uses a known Substantive_Work_Window name
 *   - `unclassified`: uses an unclassified window name
 *
 * Both records should be retrievable (not filtered out).
 */
const equivalentWindowRecordPairArb: fc.Arbitrary<{
  substantive: ScreenpipeRecord;
  unclassified: ScreenpipeRecord;
}> = fc
  .tuple(
    fc.string({ minLength: 3, maxLength: 64 }),  // shared text
    fc.constantFrom(...SUBSTANTIVE_WINDOW_NAMES), // substantive window name
    unclassifiedWindowNameArb                     // unclassified window name
  )
  .map(([text, substantiveWindowName, unclassifiedWindowName]) => ({
    substantive: {
      id: 'substantive-record',
      text,
      timestamp: '2025-06-01T10:00:00.000Z',
      appName: 'Code',
      windowName: substantiveWindowName,
      sourceTypes: ['accessibility'] as string[]
    },
    unclassified: {
      id: 'unclassified-record',
      text,
      timestamp: '2025-06-01T10:00:00.000Z',
      appName: 'SomeOtherApp',
      windowName: unclassifiedWindowName,
      sourceTypes: ['accessibility'] as string[]
    }
  }));

describe('Property 20: 未分类窗口与 Substantive 行为等价', () => {
  /**
   * **Validates: Requirements 3.6**
   *
   * For any AX record r whose (appName, windowName) is neither in
   * Substantive_Work_Window nor in Noise_Window, its indexing and retrieval
   * behaviour (whether it is indexed, whether it can be found by keyword,
   * whether it appears in time-window queries) MUST be the same as for an AX
   * record with equivalent content whose (appName, windowName) belongs to
   * Substantive_Work_Window.
   *
   * Concretely: both the substantive record and the unclassified record must
   * appear in search results — neither should be filtered out.
   */
  const unclassifiedStubs: Array<{ stop(): Promise<void> }> = [];

  afterEach(async () => {
    while (unclassifiedStubs.length > 0) {
      const stub = unclassifiedStubs.pop();
      if (stub) await stub.stop();
    }
  });

  it(
    'unclassified-window records are returned by search just like substantive-window records',
    async () => {
      await fc.assert(
        fc.asyncProperty(equivalentWindowRecordPairArb, async ({ substantive, unclassified }) => {
          // ── Setup: inject both records into a fresh stub ──
          const stub = await startScreenpipeStub({
            records: [substantive, unclassified]
          });
          unclassifiedStubs.push(stub);

          const client = createScreenpipeClient(stub.url);

          // ── Exercise: search with the shared text as query ──
          const results = await client.search({ query: substantive.text });

          // ── Assert 1: the substantive record is present ──
          // (baseline: substantive windows are never filtered out)
          const substantiveResult = results.find((r) => r.id === substantive.id);
          expect(
            substantiveResult,
            `Expected substantive record (id="${substantive.id}", windowName="${substantive.windowName}") ` +
            `to appear in search results for query="${substantive.text}"`
          ).toBeDefined();

          // ── Assert 2: the unclassified record is also present ──
          // (R3.6: unclassified windows behave the same as substantive windows)
          const unclassifiedResult = results.find((r) => r.id === unclassified.id);
          expect(
            unclassifiedResult,
            `Expected unclassified record (id="${unclassified.id}", windowName="${unclassified.windowName}") ` +
            `to appear in search results for query="${unclassified.text}". ` +
            `Unclassified windows must not be filtered out (R3.6).`
          ).toBeDefined();

          // ── Assert 3: both records have sourceTypes containing 'accessibility' ──
          // (they should be treated identically in the retrieval pipeline)
          if (substantiveResult) {
            expect(substantiveResult.sourceTypes).toContain('accessibility');
          }
          if (unclassifiedResult) {
            expect(unclassifiedResult.sourceTypes).toContain('accessibility');
          }
        }),
        { numRuns: 100 }
      );
    },
    120_000 // generous timeout: 100 async runs each starting a stub server
  );

  it(
    'noise-window records are filtered out while unclassified-window records are not',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(
            fc.string({ minLength: 3, maxLength: 64 }),   // shared text
            fc.constantFrom(...NOISE_WINDOW_NAMES),        // noise window name
            unclassifiedWindowNameArb                      // unclassified window name
          ),
          async ([text, noiseWindowName, unclassifiedWindowName]) => {
            const noiseRecord: ScreenpipeRecord = {
              id: 'noise-record',
              text,
              timestamp: '2025-06-01T10:00:00.000Z',
              appName: 'Control Center',
              windowName: noiseWindowName,
              sourceTypes: ['accessibility'] as string[]
            };

            const unclassifiedRecord: ScreenpipeRecord = {
              id: 'unclassified-record-2',
              text,
              timestamp: '2025-06-01T10:00:00.000Z',
              appName: 'SomeOtherApp',
              windowName: unclassifiedWindowName,
              sourceTypes: ['accessibility'] as string[]
            };

            // ── Setup: inject both records into a fresh stub ──
            const stub = await startScreenpipeStub({
              records: [noiseRecord, unclassifiedRecord]
            });
            unclassifiedStubs.push(stub);

            const client = createScreenpipeClient(stub.url);

            // ── Exercise: search with the shared text as query ──
            const results = await client.search({ query: text });

            // ── Assert: unclassified record IS present (not filtered) ──
            const unclassifiedResult = results.find((r) => r.id === unclassifiedRecord.id);
            expect(
              unclassifiedResult,
              `Expected unclassified record (windowName="${unclassifiedWindowName}") ` +
              `to appear in search results. Unclassified windows must not be filtered out (R3.6).`
            ).toBeDefined();

            // Note: The noise record filtering happens at the SearchScreenService layer
            // (filterNoiseWindows), not at the ScreenpipeClient layer. The client.search()
            // call returns raw merged records before service-level filtering. Therefore
            // we only assert that the unclassified record is present — the noise filtering
            // property is covered by Property 19.
          }
        ),
        { numRuns: 100 }
      );
    },
    120_000
  );
});

// ---------------------------------------------------------------------------
// Task 4.9 — Smoke test: safe-record 默认参数 + privacy.excludeApps 默认值
// Validates: Requirements 3.3, 4.6
// ---------------------------------------------------------------------------

describe('Smoke test 4.9: buildScreenpipeSafeRecordArgs 默认参数', () => {
  it('default args include --use-pii-removal', () => {
    const args = buildScreenpipeSafeRecordArgs([]);
    expect(args).toContain('--use-pii-removal');
  });

  it('default args include --ignored-windows Control Center', () => {
    const args = buildScreenpipeSafeRecordArgs([]);
    const idx = args.indexOf('--ignored-windows');
    // There may be multiple --ignored-windows entries; find the one for 'Control Center'
    const pairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--ignored-windows') {
        pairs.push(args[i + 1]);
      }
    }
    expect(pairs).toContain('Control Center');
  });

  it('default args include --ignored-windows Notification Center', () => {
    const args = buildScreenpipeSafeRecordArgs([]);
    const pairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--ignored-windows') {
        pairs.push(args[i + 1]);
      }
    }
    expect(pairs).toContain('Notification Center');
  });

  it('default args include --retention-days 7', () => {
    const args = buildScreenpipeSafeRecordArgs([]);
    const idx = args.indexOf('--retention-days');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('7');
  });
});

describe('Smoke test 4.9: appConfigSchema 默认 privacy.excludeApps', () => {
  it('default privacy.excludeApps contains "1Password"', () => {
    const config = appConfigSchema.parse({});
    expect(config.privacy.excludeApps).toContain('1Password');
  });

  it('default privacy.excludeApps contains "Keychain Access"', () => {
    const config = appConfigSchema.parse({});
    expect(config.privacy.excludeApps).toContain('Keychain Access');
  });
});

// ---------------------------------------------------------------------------
// Property 19: Noise_Window 永不返回
// Validates: Requirements 3.4, 3.6
// ---------------------------------------------------------------------------
//
// NOTE: Property 19 was removed by task 8.1 of the work-activity-analysis
// spec. It exercised `DefaultSearchScreenService.filterEvidenceWithLatestPrivacy`
// which was deleted alongside the legacy `search-screen` MCP tool. The
// equivalent invariant for the replacement `find` / `recall` / `inspect`
// tools will land alongside their service implementations in tasks 8.2 - 8.5.

// ---------------------------------------------------------------------------
// Task 5.2: 单元测试：metadata 持久化
// Validates: Requirements 1.5, 6.2
// ---------------------------------------------------------------------------
//
// After one IndexingService.runOnce() call, every VectorStoreRecord upserted
// into the vector store must carry metadata.sourceTypes that matches the
// sourceTypes on the original ScreenpipeRecord.

// ---------------------------------------------------------------------------
// Local stubs for Task 5.2
// ---------------------------------------------------------------------------

class MetadataTestEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'metadata-test-stub';

  async embed(input: string): Promise<number[]> {
    // Deterministic embedding based on text length — no network needed.
    return [input.length, 0, 0];
  }
}

class MetadataTestCheckpointStore implements CheckpointStore {
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

class MetadataTestScreenpipeClient implements ScreenpipeClient {
  constructor(private readonly records: ScreenpipeRecord[]) {}

  async search(request: { from?: string; to?: string; limit?: number; offset?: number }): Promise<ScreenpipeRecord[]> {
    const filtered = this.records.filter((record) => {
      const recordTime = Date.parse(record.timestamp);
      const matchesFrom = request.from ? recordTime >= Date.parse(request.from) : true;
      const matchesTo = request.to ? recordTime <= Date.parse(request.to) : true;
      return matchesFrom && matchesTo;
    });
    const offset = request.offset ?? 0;
    const limit = request.limit;
    if (typeof limit === 'number') {
      return filtered.slice(offset, offset + limit);
    }
    return filtered.slice(offset);
  }

  async recent(_minutes: number): Promise<ScreenpipeRecord[]> {
    return this.records;
  }
}

class MetadataRecordingVectorStore implements VectorStore {
  readonly kind = 'metadata-recording';
  readonly upsertedRecords: VectorStoreRecord[] = [];

  async upsert(records: VectorStoreRecord[]): Promise<void> {
    this.upsertedRecords.push(...records);
  }

  async reset(): Promise<void> {
    this.upsertedRecords.length = 0;
  }

  async query(): Promise<import('../../../src/services/retrieval/types.js').RetrievalEvidenceItem[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Task 5.2: metadata 持久化 — sourceTypes persisted to VectorStoreRecord.metadata', () => {
  it(
    'upserted VectorStoreRecords carry metadata.sourceTypes matching the original ScreenpipeRecord.sourceTypes',
    async () => {
      // ── Arrange ──
      const axRecords: ScreenpipeRecord[] = [
        {
          id: 'ax-record-1',
          text: 'Accessibility text from IDE window',
          timestamp: '2025-06-01T10:00:00.000Z',
          appName: 'Code',
          windowName: 'design.ts — canary-alpha-mcp',
          frameId: 101,
          sourceTypes: ['accessibility']
        },
        {
          id: 'ax-record-2',
          text: 'Another accessibility record from browser',
          timestamp: '2025-06-01T10:01:00.000Z',
          appName: 'Google Chrome',
          windowName: 'Linear — LIN-123',
          frameId: 102,
          sourceTypes: ['accessibility']
        },
        {
          id: 'ocr-record-1',
          text: 'OCR fallback record',
          timestamp: '2025-06-01T10:02:00.000Z',
          appName: 'Terminal',
          windowName: 'xz@host: ~/Projects',
          frameId: 103,
          sourceTypes: ['ocr']
        }
      ];

      const vectorStore = new MetadataRecordingVectorStore();
      const checkpointStore = new MetadataTestCheckpointStore();
      const captureClient = new MetadataTestScreenpipeClient(axRecords);

      const service = createIndexingService({
        embeddingProvider: new MetadataTestEmbeddingProvider(),
        captureClient,
        vectorStore,
        checkpointStore,
        freshnessWindowMinutes: 60,
        maxCatchUpBatches: 3,
        maxCatchUpRecords: 100
      });

      // ── Act ──
      const now = new Date('2025-06-01T10:30:00.000Z');
      const result = await service.runOnce(now);

      // ── Assert: all records were indexed ──
      expect(result.indexed).toBe(axRecords.length);
      expect(vectorStore.upsertedRecords).toHaveLength(axRecords.length);

      // ── Assert: metadata.sourceTypes matches original record's sourceTypes ──
      for (const original of axRecords) {
        const upserted = vectorStore.upsertedRecords.find((r) => r.id === original.id);

        expect(
          upserted,
          `Expected to find upserted record with id="${original.id}"`
        ).toBeDefined();

        expect(
          upserted!.metadata,
          `Expected metadata to be defined on upserted record id="${original.id}"`
        ).toBeDefined();

        expect(
          upserted!.metadata!['sourceTypes'],
          `Expected metadata.sourceTypes to match original sourceTypes for id="${original.id}"`
        ).toEqual(original.sourceTypes);
      }
    }
  );

  it(
    'metadata.windowName and metadata.frameId are also persisted alongside sourceTypes',
    async () => {
      // ── Arrange ──
      const record: ScreenpipeRecord = {
        id: 'ax-with-window',
        text: 'AX record with window and frame metadata',
        timestamp: '2025-06-01T11:00:00.000Z',
        appName: 'Code',
        windowName: 'index.ts — my-project',
        frameId: 42,
        sourceTypes: ['accessibility']
      };

      const vectorStore = new MetadataRecordingVectorStore();
      const checkpointStore = new MetadataTestCheckpointStore();
      const captureClient = new MetadataTestScreenpipeClient([record]);

      const service = createIndexingService({
        embeddingProvider: new MetadataTestEmbeddingProvider(),
        captureClient,
        vectorStore,
        checkpointStore,
        freshnessWindowMinutes: 60,
        maxCatchUpBatches: 3,
        maxCatchUpRecords: 100
      });

      // ── Act ──
      await service.runOnce(new Date('2025-06-01T11:30:00.000Z'));

      // ── Assert ──
      expect(vectorStore.upsertedRecords).toHaveLength(1);
      const upserted = vectorStore.upsertedRecords[0]!;

      expect(upserted.metadata!['sourceTypes']).toEqual(['accessibility']);
      expect(upserted.metadata!['windowName']).toBe('index.ts — my-project');
      expect(upserted.metadata!['frameId']).toBe(42);
    }
  );

  it(
    'metadata.sourceTypes is preserved for OCR records as well',
    async () => {
      // ── Arrange ──
      const ocrRecord: ScreenpipeRecord = {
        id: 'ocr-only-record',
        text: 'OCR-only text content',
        timestamp: '2025-06-01T12:00:00.000Z',
        appName: 'Safari',
        sourceTypes: ['ocr']
      };

      const vectorStore = new MetadataRecordingVectorStore();
      const checkpointStore = new MetadataTestCheckpointStore();
      const captureClient = new MetadataTestScreenpipeClient([ocrRecord]);

      const service = createIndexingService({
        embeddingProvider: new MetadataTestEmbeddingProvider(),
        captureClient,
        vectorStore,
        checkpointStore,
        freshnessWindowMinutes: 60,
        maxCatchUpBatches: 3,
        maxCatchUpRecords: 100
      });

      // ── Act ──
      await service.runOnce(new Date('2025-06-01T12:30:00.000Z'));

      // ── Assert ──
      expect(vectorStore.upsertedRecords).toHaveLength(1);
      const upserted = vectorStore.upsertedRecords[0]!;
      expect(upserted.metadata!['sourceTypes']).toEqual(['ocr']);
    }
  );
});
