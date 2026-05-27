/**
 * Property-based test for the Trim_Service.
 *
 * Task 6.5 — Property 8: Trim 把已迁移的 accessibility_tree_json 置 NULL
 * **Validates: Requirements 2.3**
 *
 * For any frames row f, if the elements table contains a row with
 * frame_id == f.id, then after runTrimOnce, f.accessibility_tree_json IS NULL.
 * Frames without elements must keep their accessibility_tree_json unchanged.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import * as fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import { runTrimOnce } from '../../../src/services/trim/screenpipe-trim-service.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Represents a frame row in the test database.
 */
interface FrameRow {
  id: number;
  contentHash: number | null;
  accessibilityTreeJson: string | null;
  hasElements: boolean;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates an arbitrary set of frame rows with unique ids.
 * Forces the first row to have both non-null accessibility_tree_json and
 * elements, so the property is always non-trivially exercised.
 */
const frameRowsArb: fc.Arbitrary<FrameRow[]> = fc
  .array(
    fc.record({
      id: fc.integer({ min: 1, max: 200 }),
      contentHash: fc.option(fc.integer({ min: 1, max: 9999 }), { nil: null }),
      accessibilityTreeJson: fc.option(
        // Trim trailing whitespace to avoid sqlite3 CLI output trimming issues
        fc.string({ minLength: 1, maxLength: 64 }).map((s) => `json-${s.trim() || 'x'}`),
        { nil: null }
      ),
      hasElements: fc.boolean()
    }),
    { minLength: 1, maxLength: 20 }
  )
  // Deduplicate by id (keep first occurrence)
  .map((rows) => {
    const seen = new Set<number>();
    return rows.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  })
  .filter((rows) => rows.length >= 1)
  // Force the first row to have both accessibility_tree_json and elements
  // so the property is always non-trivially exercised.
  .map((rows) => {
    const forced: FrameRow = {
      ...rows[0],
      accessibilityTreeJson: rows[0].accessibilityTreeJson ?? 'json-forced',
      hasElements: true
    };
    return [forced, ...rows.slice(1)];
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a SQLite database from FrameRow array.
 * Returns the path to the database file.
 */
async function createDbFromFrameRows(dir: string, frames: FrameRow[]): Promise<string> {
  const dbPath = join(dir, 'db.sqlite');
  await mkdir(dir, { recursive: true });

  const statements: string[] = [
    'PRAGMA journal_mode = WAL;',
    `CREATE TABLE frames(
      id INTEGER PRIMARY KEY,
      content_hash INTEGER,
      accessibility_tree_json TEXT
    );`,
    `CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL);`
  ];

  for (const f of frames) {
    const jsonVal =
      f.accessibilityTreeJson === null
        ? 'NULL'
        : `'${f.accessibilityTreeJson.replace(/'/g, "''")}'`;
    const hashVal = f.contentHash === null ? 'NULL' : String(f.contentHash);
    statements.push(`INSERT INTO frames VALUES (${f.id}, ${hashVal}, ${jsonVal});`);
  }

  let elemId = 1;
  for (const f of frames) {
    if (f.hasElements) {
      statements.push(`INSERT INTO elements VALUES (${elemId++}, ${f.id});`);
    }
  }

  await execFileAsync('sqlite3', [dbPath, statements.join('\n')]);
  return dbPath;
}

/**
 * Reads accessibility_tree_json for a given frame id.
 * Returns null if the value is NULL in the database, or the string value otherwise.
 */
async function getAccessibilityTreeJson(
  dbPath: string,
  frameId: number
): Promise<string | null> {
  const { stdout } = await execFileAsync('sqlite3', [
    dbPath,
    `SELECT COALESCE(accessibility_tree_json, '__NULL__') FROM frames WHERE id = ${frameId};`
  ]);
  const val = stdout.trim();
  if (val === '' || val === '__NULL__') return null;
  return val;
}

// ---------------------------------------------------------------------------
// Property 8: Trim 把已迁移的 accessibility_tree_json 置 NULL
// Validates: Requirements 2.3
// ---------------------------------------------------------------------------

describe('Property 8: Trim 把已迁移的 accessibility_tree_json 置 NULL', () => {
  /**
   * **Validates: Requirements 2.3**
   *
   * For any frames row f:
   * - If elements table has a row with frame_id == f.id AND f.accessibility_tree_json
   *   is not null, then after runTrimOnce, f.accessibility_tree_json IS NULL.
   * - If elements table has NO row with frame_id == f.id, then after runTrimOnce,
   *   f.accessibility_tree_json is unchanged (still whatever it was before).
   */
  it(
    'frames with elements have accessibility_tree_json set to NULL after runTrimOnce; frames without elements are unchanged',
    async () => {
      await fc.assert(
        fc.asyncProperty(frameRowsArb, async (frames) => {
          // ── Setup: create a temp directory and SQLite database ──
          const root = await mkdtemp(join(testTempRoot(), 'trim-pbt-prop8-'));
          cleanup.push(() => rm(root, { recursive: true, force: true }));

          const dbPath = await createDbFromFrameRows(root, frames);

          // ── Exercise: run trim ──
          await runTrimOnce(dbPath);

          // ── Pre-compute which frames survive duplicate removal ──
          // Trim deletes duplicate frames (same content_hash, keeping MIN(id)).
          // Frames that are deleted by the duplicate-removal pass cannot be
          // asserted on for the "unchanged" invariant.
          const minIdByHash = new Map<number, number>();
          for (const f of frames) {
            if (f.contentHash !== null) {
              const cur = minIdByHash.get(f.contentHash);
              if (cur === undefined || f.id < cur) {
                minIdByHash.set(f.contentHash, f.id);
              }
            }
          }
          const survivesDedup = (f: FrameRow): boolean => {
            if (f.contentHash === null) return true; // no content_hash → never deleted by dedup
            return minIdByHash.get(f.contentHash) === f.id;
          };

          // ── Assert: check each frame's accessibility_tree_json ──
          for (const frame of frames) {
            // Skip frames that were removed by the duplicate-removal pass —
            // they no longer exist in the DB so no invariant applies.
            if (!survivesDedup(frame)) continue;

            const actualJson = await getAccessibilityTreeJson(dbPath, frame.id);

            if (frame.hasElements && frame.accessibilityTreeJson !== null) {
              // Frame had elements AND had non-null accessibility_tree_json
              // → must be NULL after trim (Requirements 2.3)
              expect(
                actualJson,
                `Frame id=${frame.id} had elements and non-null accessibility_tree_json="${frame.accessibilityTreeJson}". ` +
                `Expected NULL after runTrimOnce, but got "${actualJson}".`
              ).toBeNull();
            } else if (!frame.hasElements) {
              // Frame had no elements → accessibility_tree_json must be unchanged
              expect(
                actualJson,
                `Frame id=${frame.id} had no elements. ` +
                `Expected accessibility_tree_json to remain "${frame.accessibilityTreeJson}", ` +
                `but got "${actualJson}".`
              ).toBe(frame.accessibilityTreeJson);
            }
            // If frame.hasElements && frame.accessibilityTreeJson === null:
            // it was already NULL before trim, so it stays NULL — no assertion needed.
          }
        }),
        { numRuns: 100 }
      );
    },
    120_000 // generous timeout: 100 async runs each creating a SQLite database
  );
});
