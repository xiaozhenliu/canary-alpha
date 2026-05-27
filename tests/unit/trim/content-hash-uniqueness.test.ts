/**
 * Property-based tests for the Trim_Service content_hash deduplication.
 *
 * Task 6.4 — Property 7: Trim 后 frames 的 content_hash 唯一
 * **Validates: Requirements 2.2**
 *
 * For any initial frames table state containing duplicate content_hash values,
 * after calling runTrimOnce, every non-null content_hash in the frames table
 * appears at most once.
 *
 * This file is separate from budget-properties.test.ts because that file uses
 * vi.mock to mock runTrimOnce (needed for Property 6's fake-timer tests).
 * Property 7 requires the real runTrimOnce implementation against a real
 * SQLite database.
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
// Helpers
// ---------------------------------------------------------------------------

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/**
 * Creates a SQLite database at the given path with the frames and elements
 * tables, then inserts the provided frames.
 *
 * Each frame is represented as { id, contentHash } where contentHash may be
 * null (to exercise the "skip NULL content_hash" path).
 */
async function createDbWithFrames(
  dbPath: string,
  frames: Array<{ id: number; contentHash: number | null }>
): Promise<void> {
  const createSql = [
    'PRAGMA journal_mode = WAL;',
    `CREATE TABLE frames(
      id INTEGER PRIMARY KEY,
      content_hash INTEGER,
      accessibility_tree_json TEXT
    );`,
    `CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL);`
  ].join('\n');

  await execFileAsync('sqlite3', [dbPath, createSql]);

  if (frames.length === 0) return;

  const valuesClauses = frames
    .map(({ id, contentHash }) => {
      const hashVal = contentHash === null ? 'NULL' : String(contentHash);
      return `(${id}, ${hashVal}, NULL)`;
    })
    .join(', ');

  const insertSql = `INSERT INTO frames(id, content_hash, accessibility_tree_json) VALUES ${valuesClauses};`;
  await execFileAsync('sqlite3', [dbPath, insertSql]);
}

/**
 * Reads all (id, content_hash) pairs from the frames table, returning only
 * rows where content_hash IS NOT NULL.
 */
async function readNonNullContentHashes(
  dbPath: string
): Promise<Array<{ id: number; contentHash: number }>> {
  const { stdout } = await execFileAsync('sqlite3', [
    dbPath,
    'SELECT id, content_hash FROM frames WHERE content_hash IS NOT NULL ORDER BY id;'
  ]);
  if (!stdout.trim()) return [];
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [id, hash] = line.split('|').map(Number);
      return { id, contentHash: hash };
    });
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates an arbitrary initial frames table state with potential duplicate
 * content_hash values.
 *
 * Strategy:
 * 1. Pick a small pool of distinct content_hash values (1–5 distinct hashes).
 * 2. Generate 1–20 frames, each assigned a hash from the pool (or NULL).
 *    This guarantees duplicates are common but not universal.
 * 3. Assign unique sequential IDs to each frame.
 */
const framesTableArb: fc.Arbitrary<Array<{ id: number; contentHash: number | null }>> = fc
  .tuple(
    // Pool of distinct non-null content_hash values (1–5 distinct values)
    fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 5 }),
    // Number of frames to generate
    fc.integer({ min: 1, max: 20 })
  )
  .chain(([hashPool, frameCount]) => {
    // Deduplicate the hash pool
    const distinctHashes = [...new Set(hashPool)];

    // For each frame, pick a hash from the pool or NULL
    return fc
      .array(
        fc.oneof(
          // Pick from the pool (weighted higher to create duplicates)
          fc.constantFrom(...distinctHashes),
          // Occasionally use NULL
          fc.constant(null as number | null)
        ),
        { minLength: frameCount, maxLength: frameCount }
      )
      .map((hashes) =>
        hashes.map((contentHash, idx) => ({
          id: idx + 1,
          contentHash
        }))
      );
  });

/**
 * Variant that guarantees at least one duplicate content_hash exists.
 * This exercises the core deduplication path of runTrimOnce.
 */
const framesWithDuplicatesArb: fc.Arbitrary<Array<{ id: number; contentHash: number | null }>> =
  fc
    .tuple(
      // At least one hash value that will be duplicated
      fc.integer({ min: 1, max: 1_000_000 }),
      // How many times to duplicate it (2–5)
      fc.integer({ min: 2, max: 5 }),
      // Additional unique frames (0–10)
      fc.array(fc.integer({ min: 1_000_001, max: 2_000_000 }), { minLength: 0, maxLength: 10 })
    )
    .map(([duplicatedHash, duplicateCount, uniqueHashes]) => {
      const frames: Array<{ id: number; contentHash: number | null }> = [];
      let id = 1;

      // Add the duplicated frames
      for (let i = 0; i < duplicateCount; i++) {
        frames.push({ id: id++, contentHash: duplicatedHash });
      }

      // Add unique frames (distinct hashes not in the duplicate set)
      for (const hash of uniqueHashes) {
        if (hash !== duplicatedHash) {
          frames.push({ id: id++, contentHash: hash });
        }
      }

      // Optionally add some NULL frames
      frames.push({ id: id++, contentHash: null });

      return frames;
    });

// ---------------------------------------------------------------------------
// Property 7: Trim 后 frames 的 content_hash 唯一
// Validates: Requirements 2.2
// ---------------------------------------------------------------------------

describe('Property 7: Trim 后 frames 的 content_hash 唯一', () => {
  /**
   * **Validates: Requirements 2.2**
   *
   * For any initial frames table state containing duplicate content_hash values,
   * after calling runTrimOnce, every non-null content_hash in the frames table
   * appears at most once.
   *
   * This property uses a real SQLite database in a temp directory to ensure
   * the test validates actual SQL execution, not mocked behavior.
   */
  it(
    'after runTrimOnce, every non-null content_hash appears at most once in the frames table',
    async () => {
      await fc.assert(
        fc.asyncProperty(framesTableArb, async (frames) => {
          // ── Setup: create a real SQLite database in a temp directory ──
          const root = await mkdtemp(join(testTempRoot(), 'trim-pbt-p7-'));
          cleanup.push(() => rm(root, { recursive: true, force: true }));
          const dbPath = join(root, 'db.sqlite');

          await createDbWithFrames(dbPath, frames);

          // ── Exercise: run trim once ──
          await runTrimOnce(dbPath);

          // ── Assert: every non-null content_hash appears at most once ──
          const remaining = await readNonNullContentHashes(dbPath);

          const hashCounts = new Map<number, number>();
          for (const { contentHash } of remaining) {
            hashCounts.set(contentHash, (hashCounts.get(contentHash) ?? 0) + 1);
          }

          for (const [hash, count] of hashCounts) {
            expect(
              count,
              `content_hash ${hash} appears ${count} times after runTrimOnce — expected at most 1`
            ).toBeLessThanOrEqual(1);
          }
        }),
        { numRuns: 100 }
      );
    },
    120_000 // generous timeout: 100 async runs each creating a real SQLite db
  );

  it(
    'after runTrimOnce, every non-null content_hash appears at most once (guaranteed-duplicate variant)',
    async () => {
      await fc.assert(
        fc.asyncProperty(framesWithDuplicatesArb, async (frames) => {
          // ── Setup: create a real SQLite database in a temp directory ──
          const root = await mkdtemp(join(testTempRoot(), 'trim-pbt-dup-p7-'));
          cleanup.push(() => rm(root, { recursive: true, force: true }));
          const dbPath = join(root, 'db.sqlite');

          await createDbWithFrames(dbPath, frames);

          // Verify precondition: there are duplicates before trim
          const beforeTrim = await readNonNullContentHashes(dbPath);
          const beforeCounts = new Map<number, number>();
          for (const { contentHash } of beforeTrim) {
            beforeCounts.set(contentHash, (beforeCounts.get(contentHash) ?? 0) + 1);
          }
          const hasDuplicatesBefore = [...beforeCounts.values()].some((c) => c > 1);
          expect(hasDuplicatesBefore).toBe(true);

          // ── Exercise: run trim once ──
          const result = await runTrimOnce(dbPath);

          // Trim should have removed at least one duplicate
          expect(result.duplicatesRemoved).toBeGreaterThanOrEqual(1);

          // ── Assert: every non-null content_hash appears at most once ──
          const remaining = await readNonNullContentHashes(dbPath);

          const hashCounts = new Map<number, number>();
          for (const { contentHash } of remaining) {
            hashCounts.set(contentHash, (hashCounts.get(contentHash) ?? 0) + 1);
          }

          for (const [hash, count] of hashCounts) {
            expect(
              count,
              `content_hash ${hash} appears ${count} times after runTrimOnce — expected at most 1`
            ).toBeLessThanOrEqual(1);
          }
        }),
        { numRuns: 100 }
      );
    },
    120_000 // generous timeout: 100 async runs each creating a real SQLite db
  );
});
