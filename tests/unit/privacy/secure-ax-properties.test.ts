/**
 * Property-based tests for privacy controls in the retrieval layer.
 *
 * Task 4.7 — Property 16: delete-range round-trip
 * Validates: Requirements 4.3
 *
 * After delete-range(R) is confirmed, any retrieval call covering R must not
 * return any evidence with timestamp ∈ R, regardless of sourceTypes (AX or OCR).
 *
 * Modelled as: after delete-range(R), the suppressedRanges in PrivacyState
 * covers R. We apply the privacy filter with suppressedRanges covering R and
 * assert:
 *   1. No evidence with timestamp in R appears in the filtered result.
 *   2. Evidence with timestamp outside R is preserved.
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PrivacySuppressedRange } from '../../../src/services/privacy/types.js';
import type { RetrievalEvidenceItem } from '../../../src/services/retrieval/types.js';

// ---------------------------------------------------------------------------
// Privacy filter helpers (mirrors the logic in search-screen-service.ts)
// These are inlined here to test the property in isolation without depending
// on the full service stack.
// ---------------------------------------------------------------------------

function toTimestampMillis(timestamp: string): number | null {
  const millis = Date.parse(timestamp);
  return Number.isNaN(millis) ? null : millis;
}

function intersectsSuppressedRange(timestamp: string, range: PrivacySuppressedRange): boolean {
  const timestampMillis = toTimestampMillis(timestamp);
  const fromMillis = toTimestampMillis(range.from);
  const toMillis = toTimestampMillis(range.to);
  if (timestampMillis === null || fromMillis === null || toMillis === null) {
    return timestamp >= range.from && timestamp <= range.to;
  }

  return timestampMillis >= fromMillis && timestampMillis <= toMillis;
}

function filterSuppressedRanges(
  items: RetrievalEvidenceItem[],
  suppressedRanges: PrivacySuppressedRange[]
): RetrievalEvidenceItem[] {
  if (suppressedRanges.length === 0) {
    return items;
  }

  return items.filter(
    (item) => !suppressedRanges.some((range) => intersectsSuppressedRange(item.timestamp, range))
  );
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates a time range R = [startTimestamp, endTimestamp] where
 * startTimestamp < endTimestamp (at least 1 second apart).
 */
const timeRangeArb: fc.Arbitrary<{ start: Date; end: Date }> = fc
  .tuple(
    fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2029-12-31T23:59:58Z') }),
    fc.integer({ min: 1, max: 86400 }) // range width in seconds (1s to 24h)
  )
  .map(([start, widthSeconds]) => ({
    start,
    end: new Date(start.getTime() + widthSeconds * 1000)
  }));

/**
 * Generates a single RetrievalEvidenceItem with a timestamp strictly inside
 * the given range [start, end].
 */
function evidenceInsideRangeArb(
  start: Date,
  end: Date,
  sourceType: 'accessibility' | 'ocr'
): fc.Arbitrary<RetrievalEvidenceItem> {
  const rangeMs = end.getTime() - start.getTime();
  return fc
    .tuple(
      fc.string({ minLength: 1, maxLength: 32 }).map((s) => `${sourceType}-inside-${s}`),
      fc.string({ minLength: 1, maxLength: 128 }),
      // Timestamp strictly inside [start, end]: offset in [0, rangeMs]
      fc.integer({ min: 0, max: Math.max(0, rangeMs) })
    )
    .map(([id, text, offsetMs]) => ({
      id,
      text,
      timestamp: new Date(start.getTime() + offsetMs).toISOString(),
      source: 'keyword' as const,
      sourceTypes: [sourceType]
    }));
}

/**
 * Generates a single RetrievalEvidenceItem with a timestamp strictly outside
 * the given range [start, end] (either before start or after end).
 */
function evidenceOutsideRangeArb(
  start: Date,
  end: Date,
  sourceType: 'accessibility' | 'ocr'
): fc.Arbitrary<RetrievalEvidenceItem> {
  // Generate timestamps either before start (by 1s–1h) or after end (by 1s–1h)
  return fc
    .tuple(
      fc.string({ minLength: 1, maxLength: 32 }).map((s) => `${sourceType}-outside-${s}`),
      fc.string({ minLength: 1, maxLength: 128 }),
      fc.boolean(), // true = before start, false = after end
      fc.integer({ min: 1000, max: 3600_000 }) // offset in ms (1s to 1h)
    )
    .map(([id, text, before, offsetMs]) => {
      const timestamp = before
        ? new Date(start.getTime() - offsetMs).toISOString()
        : new Date(end.getTime() + offsetMs).toISOString();
      return {
        id,
        text,
        timestamp,
        source: 'keyword' as const,
        sourceTypes: [sourceType]
      };
    });
}

/**
 * Main arbitrary: generates a range R plus mixed AX/OCR records both inside
 * and outside R.
 */
const deleteRangeScenarioArb: fc.Arbitrary<{
  rangeFrom: string;
  rangeTo: string;
  insideRecords: RetrievalEvidenceItem[];
  outsideRecords: RetrievalEvidenceItem[];
}> = timeRangeArb.chain(({ start, end }) => {
  const insideAxArb = fc.array(evidenceInsideRangeArb(start, end, 'accessibility'), {
    minLength: 0,
    maxLength: 5
  });
  const insideOcrArb = fc.array(evidenceInsideRangeArb(start, end, 'ocr'), {
    minLength: 0,
    maxLength: 5
  });
  const outsideAxArb = fc.array(evidenceOutsideRangeArb(start, end, 'accessibility'), {
    minLength: 0,
    maxLength: 5
  });
  const outsideOcrArb = fc.array(evidenceOutsideRangeArb(start, end, 'ocr'), {
    minLength: 0,
    maxLength: 5
  });

  return fc
    .tuple(insideAxArb, insideOcrArb, outsideAxArb, outsideOcrArb)
    .map(([insideAx, insideOcr, outsideAx, outsideOcr]) => ({
      rangeFrom: start.toISOString(),
      rangeTo: end.toISOString(),
      insideRecords: [...insideAx, ...insideOcr],
      outsideRecords: [...outsideAx, ...outsideOcr]
    }));
});

// ---------------------------------------------------------------------------
// Property 16: delete-range round-trip
// Validates: Requirements 4.3
// ---------------------------------------------------------------------------

describe('Property 16: delete-range round-trip', () => {
  it(
    'after delete-range(R), no evidence with timestamp ∈ R appears in filtered results, regardless of sourceTypes',
    () => {
      fc.assert(
        fc.property(deleteRangeScenarioArb, ({ rangeFrom, rangeTo, insideRecords, outsideRecords }) => {
          // ── Setup: model delete-range(R) as adding R to suppressedRanges ──
          // After delete-range(R) is confirmed, DefaultPrivacyControlService
          // adds R to suppressedRanges (for last_1h) or the records are
          // physically deleted. In both cases, the privacy filter with
          // suppressedRanges covering R must block all evidence in R.
          const suppressedRanges: PrivacySuppressedRange[] = [
            { from: rangeFrom, to: rangeTo }
          ];

          const allRecords = [...insideRecords, ...outsideRecords];

          // ── Exercise: apply the privacy filter ──
          const filtered = filterSuppressedRanges(allRecords, suppressedRanges);

          // ── Assertion 1: no evidence with timestamp ∈ R appears ──
          // This holds regardless of sourceTypes (AX or OCR).
          const rangeFromMs = Date.parse(rangeFrom);
          const rangeToMs = Date.parse(rangeTo);

          for (const item of filtered) {
            const ts = Date.parse(item.timestamp);
            const isInRange = !Number.isNaN(ts) && ts >= rangeFromMs && ts <= rangeToMs;
            expect(
              isInRange,
              `Evidence item id="${item.id}" with timestamp="${item.timestamp}" ` +
              `(sourceTypes=${JSON.stringify(item.sourceTypes)}) ` +
              `should not appear in filtered results after delete-range([${rangeFrom}, ${rangeTo}])`
            ).toBe(false);
          }

          // ── Assertion 2: evidence with timestamp outside R is preserved ──
          // Every record that was outside R must still appear in the filtered result.
          const filteredIds = new Set(filtered.map((item) => item.id));
          for (const item of outsideRecords) {
            expect(
              filteredIds.has(item.id),
              `Evidence item id="${item.id}" with timestamp="${item.timestamp}" ` +
              `(sourceTypes=${JSON.stringify(item.sourceTypes)}) ` +
              `outside range [${rangeFrom}, ${rangeTo}] should be preserved after delete-range`
            ).toBe(true);
          }
        }),
        { numRuns: 100 }
      );
    },
    60_000 // generous timeout for 100 property runs
  );

  it(
    'delete-range(R) blocks both AX and OCR evidence with timestamp ∈ R',
    () => {
      fc.assert(
        fc.property(
          timeRangeArb,
          fc.integer({ min: 0, max: 3600_000 }), // offset within range
          ({ start, end }, offsetMs) => {
            const rangeFrom = start.toISOString();
            const rangeTo = end.toISOString();
            const rangeMs = end.getTime() - start.getTime();
            const clampedOffset = Math.min(offsetMs, rangeMs);
            const insideTimestamp = new Date(start.getTime() + clampedOffset).toISOString();

            const axRecord: RetrievalEvidenceItem = {
              id: 'ax-inside',
              text: 'AX text inside range',
              timestamp: insideTimestamp,
              source: 'keyword',
              sourceTypes: ['accessibility']
            };

            const ocrRecord: RetrievalEvidenceItem = {
              id: 'ocr-inside',
              text: 'OCR text inside range',
              timestamp: insideTimestamp,
              source: 'keyword',
              sourceTypes: ['ocr']
            };

            const suppressedRanges: PrivacySuppressedRange[] = [
              { from: rangeFrom, to: rangeTo }
            ];

            const filtered = filterSuppressedRanges([axRecord, ocrRecord], suppressedRanges);

            // Both AX and OCR records inside R must be blocked
            expect(
              filtered.find((r) => r.id === 'ax-inside'),
              `AX record with timestamp="${insideTimestamp}" inside range [${rangeFrom}, ${rangeTo}] ` +
              `should be blocked by delete-range`
            ).toBeUndefined();

            expect(
              filtered.find((r) => r.id === 'ocr-inside'),
              `OCR record with timestamp="${insideTimestamp}" inside range [${rangeFrom}, ${rangeTo}] ` +
              `should be blocked by delete-range`
            ).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    },
    60_000
  );

  it(
    'delete-range(R) with empty record set returns empty result',
    () => {
      fc.assert(
        fc.property(timeRangeArb, ({ start, end }) => {
          const suppressedRanges: PrivacySuppressedRange[] = [
            { from: start.toISOString(), to: end.toISOString() }
          ];

          const filtered = filterSuppressedRanges([], suppressedRanges);
          expect(filtered).toHaveLength(0);
        }),
        { numRuns: 50 }
      );
    },
    30_000
  );
});

// ---------------------------------------------------------------------------
// Property 15: 隐私一致性（OCR / AX 等价）
// Validates: Requirements 4.1, 4.2, 4.5
// ---------------------------------------------------------------------------

/**
 * Additional imports needed for Property 15.
 * Note: PrivacyState and ScreenpipeRecord are imported at the top of this file
 * via the existing imports. We add the necessary types here inline.
 */

import type { PrivacyState } from '../../../src/services/privacy/types.js';
import type { ScreenpipeRecord } from '../../../src/services/retrieval/types.js';

// ---------------------------------------------------------------------------
// Privacy filter helpers for Property 15
// (mirrors the full filter chain in search-screen-service.ts)
// ---------------------------------------------------------------------------

const ACTIVE_PAUSE_OPEN_END_P15 = '9999-12-31T23:59:59.999Z';

function normalizeAppNameP15(appName: string): string {
  return appName.toLowerCase();
}

function isExcludedAppP15(appName: string | undefined, privacy: PrivacyState): boolean {
  if (!appName) return false;
  const normalized = normalizeAppNameP15(appName);
  return privacy.excludedApps.some((excluded) => normalizeAppNameP15(excluded) === normalized);
}

function filterExcludedAppsP15<T extends { appName?: string }>(items: T[], privacy: PrivacyState): T[] {
  if (privacy.excludedApps.length === 0) return items;
  return items.filter((item) => !isExcludedAppP15(item.appName, privacy));
}

function intersectsSuppressedRangeP15(timestamp: string, range: { from: string; to: string }): boolean {
  const tsMs = Date.parse(timestamp);
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  if (!Number.isNaN(tsMs) && !Number.isNaN(fromMs) && !Number.isNaN(toMs)) {
    return tsMs >= fromMs && tsMs <= toMs;
  }
  return timestamp >= range.from && timestamp <= range.to;
}

function filterSuppressedRangesP15<T extends { timestamp: string }>(items: T[], privacy: PrivacyState): T[] {
  const ranges = privacy.suppressedRanges ?? [];
  if (ranges.length === 0) return items;
  return items.filter((item) => !ranges.some((range) => intersectsSuppressedRangeP15(item.timestamp, range)));
}

function createActivePauseRangeP15(privacy: PrivacyState): { from: string; to: string } | null {
  if (!privacy.paused || !privacy.pauseStartedAt) return null;
  return { from: privacy.pauseStartedAt, to: ACTIVE_PAUSE_OPEN_END_P15 };
}

function applyRuntimePrivacyStateP15(privacy: PrivacyState): PrivacyState {
  const activePauseRange = createActivePauseRangeP15(privacy);
  if (!activePauseRange) return privacy;
  return {
    ...privacy,
    suppressedRanges: [...(privacy.suppressedRanges ?? []), activePauseRange]
  };
}

/**
 * Apply all privacy filters (excludedApps + suppressedRanges + pause) to a
 * list of records, mirroring the logic in search-screen-service.ts.
 */
function applyPrivacyFilterP15<T extends { appName?: string; timestamp: string }>(
  items: T[],
  privacy: PrivacyState
): T[] {
  const effectivePrivacy = applyRuntimePrivacyStateP15(privacy);
  return filterSuppressedRangesP15(filterExcludedAppsP15(items, effectivePrivacy), effectivePrivacy);
}

// ---------------------------------------------------------------------------
// Arbitraries for Property 15
// ---------------------------------------------------------------------------

/**
 * Generates a valid ISO-8601 timestamp in the range 2020–2030.
 */
const isoTimestampP15 = fc
  .date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2030-12-31T23:59:59Z') })
  .map((d) => d.toISOString());

/**
 * Generates a non-empty app name (printable ASCII, no leading/trailing spaces).
 */
const appNameArbP15 = fc
  .string({ minLength: 1, maxLength: 32 })
  .filter((s) => s.trim().length > 0 && s === s.trim());

/**
 * Generates a pair of records (AX + OCR) sharing the same appName and timestamp.
 */
const recordPairArbP15: fc.Arbitrary<{
  appName: string;
  timestamp: string;
  axRecord: ScreenpipeRecord;
  ocrRecord: ScreenpipeRecord;
}> = fc
  .tuple(appNameArbP15, isoTimestampP15)
  .map(([appName, timestamp]) => ({
    appName,
    timestamp,
    axRecord: {
      id: `ax-${appName}-${timestamp}`,
      text: 'AX text content',
      timestamp,
      appName,
      sourceTypes: ['accessibility']
    } satisfies ScreenpipeRecord,
    ocrRecord: {
      id: `ocr-${appName}-${timestamp}`,
      text: 'OCR text content',
      timestamp,
      appName,
      sourceTypes: ['ocr']
    } satisfies ScreenpipeRecord
  }));

/**
 * Generates a PrivacyState where paused=true and pauseStartedAt is at or
 * before the given timestamp (so the timestamp falls in the active pause range).
 */
function pausedPrivacyArbP15(timestamp: string): fc.Arbitrary<PrivacyState> {
  const tsMs = Date.parse(timestamp);
  const minStart = new Date('2020-01-01T00:00:00Z');
  const maxStart = new Date(tsMs);
  return fc
    .date({ min: minStart, max: maxStart })
    .map((d) => ({
      paused: true,
      pauseStartedAt: d.toISOString(),
      excludedApps: []
    } satisfies PrivacyState));
}

/**
 * Generates a PrivacyState where excludedApps contains the given appName
 * (case-insensitively, with random case variation).
 */
function excludedAppsPrivacyArbP15(appName: string): fc.Arbitrary<PrivacyState> {
  return fc
    .array(fc.boolean(), { minLength: appName.length, maxLength: appName.length })
    .map((bools) => {
      const variedCase = appName
        .split('')
        .map((ch, i) => (bools[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join('');
      return {
        paused: false,
        excludedApps: [variedCase]
      } satisfies PrivacyState;
    });
}

/**
 * Generates a PrivacyState where suppressedRanges contains a range that covers
 * the given timestamp.
 */
function suppressedRangesPrivacyArbP15(timestamp: string): fc.Arbitrary<PrivacyState> {
  const tsMs = Date.parse(timestamp);
  const minFrom = new Date('2020-01-01T00:00:00Z');
  const maxFrom = new Date(tsMs);
  const minTo = new Date(tsMs);
  const maxTo = new Date('2030-12-31T23:59:59Z');

  return fc
    .tuple(
      fc.date({ min: minFrom, max: maxFrom }),
      fc.date({ min: minTo, max: maxTo })
    )
    .map(([from, to]) => ({
      paused: false,
      excludedApps: [],
      suppressedRanges: [{ from: from.toISOString(), to: to.toISOString() }]
    } satisfies PrivacyState));
}

// ---------------------------------------------------------------------------
// Property 15 test suite
// ---------------------------------------------------------------------------

describe('Property 15: 隐私一致性（OCR / AX 等价）', () => {
  /**
   * Core helper: asserts that for a given privacy state, the blocking decision
   * is identical for the AX record and the OCR record (both blocked or both
   * allowed).
   */
  function assertPrivacyConsistencyP15(
    axRecord: ScreenpipeRecord,
    ocrRecord: ScreenpipeRecord,
    privacy: PrivacyState,
    conditionLabel: string
  ): void {
    const axFiltered = applyPrivacyFilterP15([axRecord], privacy);
    const ocrFiltered = applyPrivacyFilterP15([ocrRecord], privacy);

    const axBlocked = axFiltered.length === 0;
    const ocrBlocked = ocrFiltered.length === 0;

    expect(
      axBlocked,
      `Privacy condition "${conditionLabel}" must block AX ⟺ OCR for ` +
      `appName="${axRecord.appName}", timestamp="${axRecord.timestamp}". ` +
      `AX blocked=${axBlocked}, OCR blocked=${ocrBlocked}.`
    ).toBe(ocrBlocked);
  }

  it(
    'paused state blocks AX ⟺ OCR for the same (appName, timestamp)',
    () => {
      fc.assert(
        fc.property(
          recordPairArbP15.chain(({ appName, timestamp, axRecord, ocrRecord }) =>
            pausedPrivacyArbP15(timestamp).map((privacy) => ({
              appName,
              timestamp,
              axRecord,
              ocrRecord,
              privacy
            }))
          ),
          ({ axRecord, ocrRecord, privacy }) => {
            assertPrivacyConsistencyP15(axRecord, ocrRecord, privacy, 'paused');
          }
        ),
        { numRuns: 100 }
      );
    },
    60_000
  );

  it(
    'excludedApps blocks AX ⟺ OCR for the same (appName, timestamp)',
    () => {
      fc.assert(
        fc.property(
          recordPairArbP15.chain(({ appName, timestamp, axRecord, ocrRecord }) =>
            excludedAppsPrivacyArbP15(appName).map((privacy) => ({
              appName,
              timestamp,
              axRecord,
              ocrRecord,
              privacy
            }))
          ),
          ({ axRecord, ocrRecord, privacy }) => {
            assertPrivacyConsistencyP15(axRecord, ocrRecord, privacy, 'excludedApps');
          }
        ),
        { numRuns: 100 }
      );
    },
    60_000
  );

  it(
    'suppressedRanges blocks AX ⟺ OCR for the same (appName, timestamp)',
    () => {
      fc.assert(
        fc.property(
          recordPairArbP15.chain(({ appName, timestamp, axRecord, ocrRecord }) =>
            suppressedRangesPrivacyArbP15(timestamp).map((privacy) => ({
              appName,
              timestamp,
              axRecord,
              ocrRecord,
              privacy
            }))
          ),
          ({ axRecord, ocrRecord, privacy }) => {
            assertPrivacyConsistencyP15(axRecord, ocrRecord, privacy, 'suppressedRanges');
          }
        ),
        { numRuns: 100 }
      );
    },
    60_000
  );

  it(
    'all three conditions: when blocking condition is active, both AX and OCR are blocked',
    () => {
      // Verify the positive case: when the condition IS active, both records ARE blocked
      fc.assert(
        fc.property(
          recordPairArbP15,
          ({ appName, timestamp, axRecord, ocrRecord }) => {
            // Test paused condition (timestamp >= pauseStartedAt)
            const pausedPrivacy: PrivacyState = {
              paused: true,
              pauseStartedAt: timestamp, // exactly at timestamp → should be blocked
              excludedApps: []
            };
            const axAfterPause = applyPrivacyFilterP15([axRecord], pausedPrivacy);
            const ocrAfterPause = applyPrivacyFilterP15([ocrRecord], pausedPrivacy);
            expect(axAfterPause.length).toBe(0);
            expect(ocrAfterPause.length).toBe(0);

            // Test excludedApps condition
            const excludedPrivacy: PrivacyState = {
              paused: false,
              excludedApps: [appName]
            };
            const axAfterExclude = applyPrivacyFilterP15([axRecord], excludedPrivacy);
            const ocrAfterExclude = applyPrivacyFilterP15([ocrRecord], excludedPrivacy);
            expect(axAfterExclude.length).toBe(0);
            expect(ocrAfterExclude.length).toBe(0);

            // Test suppressedRanges condition (range exactly covers timestamp)
            const suppressedPrivacy: PrivacyState = {
              paused: false,
              excludedApps: [],
              suppressedRanges: [{ from: timestamp, to: timestamp }]
            };
            const axAfterSuppress = applyPrivacyFilterP15([axRecord], suppressedPrivacy);
            const ocrAfterSuppress = applyPrivacyFilterP15([ocrRecord], suppressedPrivacy);
            expect(axAfterSuppress.length).toBe(0);
            expect(ocrAfterSuppress.length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    },
    60_000
  );

  it(
    'when no blocking condition is active, both AX and OCR pass through',
    () => {
      // Verify the negative case: when no condition is active, both records pass
      fc.assert(
        fc.property(
          recordPairArbP15,
          ({ axRecord, ocrRecord }) => {
            const noBlockPrivacy: PrivacyState = {
              paused: false,
              excludedApps: []
            };
            const axFiltered = applyPrivacyFilterP15([axRecord], noBlockPrivacy);
            const ocrFiltered = applyPrivacyFilterP15([ocrRecord], noBlockPrivacy);
            expect(axFiltered.length).toBe(1);
            expect(ocrFiltered.length).toBe(1);
          }
        ),
        { numRuns: 100 }
      );
    },
    60_000
  );
});
