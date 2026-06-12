/**
 * Property-based tests for Disk_Budget conservation.
 *
 * Task 6.7 — Property 10: Disk_Budget 守恒（增长有界 + retention 兜底 + 触底告警）
 * Validates: Requirements 2.4, 2.5, 2.8
 *
 * For any frames time series + budget B + retentionDays R, after each
 * trim+retention cycle completes the following disjunction must hold:
 *
 *   (A) db.sqlite size ≤ B; OR
 *   (B) reachedFloor=true (no rows older than retentionDays remain)
 *       AND diskBudget.warning is a non-empty string
 *
 * The warning message check is modeled inline (not via the full
 * IngestionObservabilityService) as specified in the task description.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import * as fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import { runRetentionIfOverBudget } from '../../../src/services/capture/providers/screenpipe/trim-service.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** Returns the byte size of a file (0 if not found). */
async function fileSizeBytes(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath);
    return s.size;
  } catch {
    return 0;
  }
}

/**
 * Creates a minimal frames+elements SQLite database with WAL mode.
 * The `timestamp` column is TEXT (ISO-8601) so SQLite string comparison works.
 */
async function createDb(dir: string, sql: string): Promise<string> {
  const dbPath = join(dir, 'db.sqlite');
  await mkdir(dir, { recursive: true });
  await execFileAsync('sqlite3', [dbPath, sql]);
  return dbPath;
}

function buildSchema(): string {
  return [
    'PRAGMA journal_mode = WAL;',
    `CREATE TABLE frames(
      id INTEGER PRIMARY KEY,
      content_hash INTEGER,
      accessibility_tree_json TEXT,
      timestamp TEXT NOT NULL
    );`,
    `CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL);`
  ].join('\n');
}

/** Returns an ISO-8601 timestamp that is `daysAgo` integer days before now. */
function isoTimestampDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1_000).toISOString();
}

/**
 * Inline diskBudget.warning logic (mirrors design §Components 5 / §Components 8.6).
 *
 * When reachedFloor=true and size > budgetBytes, the IngestionObservabilityService
 * would return a non-empty warning string.  We model that logic here without
 * instantiating the full service (as specified in the task description).
 */
function computeDiskBudgetWarning(
  currentSizeBytes: number,
  budgetBytes: number | null,
  reachedFloor: boolean
): string | undefined {
  if (budgetBytes === null) return undefined;

  // Retention floor reached: cannot shrink further within retention window
  if (reachedFloor && currentSizeBytes > budgetBytes) {
    return 'Disk budget exceeded but no rows older than retention-days are available; widen retention or raise budget';
  }

  // Approaching budget (≥ 90%)
  if (currentSizeBytes >= budgetBytes * 0.9) {
    return 'Will run retention pass on next trim cycle';
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

interface FrameDescriptor {
  /** How many integer days ago the frame was captured (1–60). */
  daysAgo: number;
  /** Approximate text payload size in bytes (0–256). */
  payloadSize: number;
}

const frameDescriptorArb: fc.Arbitrary<FrameDescriptor> = fc.record({
  // Use integer days to avoid 32-bit float precision issues with fc.float
  daysAgo: fc.integer({ min: 1, max: 60 }),
  payloadSize: fc.integer({ min: 0, max: 256 })
});

interface BudgetScenario {
  frames: FrameDescriptor[];
  budgetBytes: number;
  retentionDays: number;
}

const budgetScenarioArb: fc.Arbitrary<BudgetScenario> = fc.record({
  // Keep frame count small (1–10) to limit sqlite3 subprocess overhead per run
  frames: fc.array(frameDescriptorArb, { minLength: 1, maxLength: 10 }),
  // Budget is always set (never null) so the retention pass always runs
  budgetBytes: fc.integer({ min: 1, max: 50_000 }),
  retentionDays: fc.integer({ min: 1, max: 30 })
});

// ---------------------------------------------------------------------------
// Property 10: Disk_Budget 守恒
// Validates: Requirements 2.4, 2.5, 2.8
// ---------------------------------------------------------------------------

describe('Property 10: Disk_Budget 守恒（增长有界 + retention 兜底 + 触底告警）', () => {
  /**
   * **Property 10: Disk_Budget 守恒**
   * **Validates: Requirements 2.4, 2.5, 2.8**
   *
   * For any frames time series + budget B + retentionDays R, after
   * runRetentionIfOverBudget completes the following disjunction must hold:
   *
   *   (A) db.sqlite size ≤ B
   *   OR
   *   (B) reachedFloor=true (no rows older than retentionDays remain)
   *       AND diskBudget.warning is a non-empty string
   *
   * This encodes Requirements 2.4 (size bounded by budget), 2.5 (retention
   * deletes oldest rows until budget met or floor reached), and 2.8 (when
   * floor is reached and budget still exceeded, internal-status must surface
   * a non-empty warning).
   */
  it(
    'after runRetentionIfOverBudget: size ≤ budget OR (reachedFloor AND warning non-empty)',
    async () => {
      await fc.assert(
        fc.asyncProperty(budgetScenarioArb, async ({ frames, budgetBytes, retentionDays }) => {
          // ── Setup: create a temp directory and SQLite database ──
          const root = await mkdtemp(join(testTempRoot(), 'budget-prop10-'));
          cleanup.push(() => rm(root, { recursive: true, force: true }));

          // Build INSERT statements for each frame descriptor.
          // We assign a text payload of `payloadSize` bytes to
          // accessibility_tree_json to give the database some bulk.
          const insertStatements = frames.map((f, i) => {
            const ts = isoTimestampDaysAgo(f.daysAgo);
            const payload = f.payloadSize > 0 ? `'${'x'.repeat(f.payloadSize)}'` : 'NULL';
            return `INSERT INTO frames VALUES (${i + 1}, ${i + 1}, ${payload}, '${ts}');`;
          });

          const sql = [buildSchema(), ...insertStatements].join('\n');
          const dbPath = await createDb(root, sql);

          // ── Exercise: run the retention pass ──
          const result = await runRetentionIfOverBudget(dbPath, budgetBytes, retentionDays);

          // ── Measure post-retention db size ──
          const sizeAfter = await fileSizeBytes(dbPath);

          // ── Compute inline warning (mirrors IngestionObservabilityService logic) ──
          const warning = computeDiskBudgetWarning(sizeAfter, budgetBytes, result.reachedFloor);

          // ── Assert the disjunction ──
          const conditionA = sizeAfter <= budgetBytes;
          const conditionB = result.reachedFloor && typeof warning === 'string' && warning.length > 0;

          expect(
            conditionA || conditionB,
            [
              `Disk_Budget conservation violated:`,
              `  budgetBytes=${budgetBytes}`,
              `  retentionDays=${retentionDays}`,
              `  frames.length=${frames.length}`,
              `  sizeAfter=${sizeAfter}`,
              `  reachedFloor=${result.reachedFloor}`,
              `  framesDeleted=${result.framesDeleted}`,
              `  warning=${JSON.stringify(warning)}`,
              ``,
              `  Condition A (size ≤ budget): ${conditionA}`,
              `  Condition B (reachedFloor AND warning non-empty): ${conditionB}`,
              ``,
              `  Either the db must be within budget, or the floor must have been`,
              `  reached and a non-empty warning must be produced.`
            ].join('\n')
          ).toBe(true);
        }),
        // 50 runs × ~10 frames × ~3 sqlite3 calls per run ≈ manageable
        { numRuns: 50 }
      );
    },
    // Generous timeout: 50 async runs, each creating a SQLite db and running
    // the retention loop (which may issue multiple sqlite3 subprocess calls).
    120_000
  );

  // ---------------------------------------------------------------------------
  // Unit tests for the inline warning logic
  // ---------------------------------------------------------------------------

  /**
   * Boundary: budgetBytes=null → retention is a no-op, warning is always undefined.
   */
  it('computeDiskBudgetWarning returns undefined when budgetBytes is null', () => {
    expect(computeDiskBudgetWarning(999_999, null, false)).toBeUndefined();
    expect(computeDiskBudgetWarning(999_999, null, true)).toBeUndefined();
  });

  /**
   * Boundary: reachedFloor=true and size > budget → warning must be non-empty (R2.8).
   */
  it('computeDiskBudgetWarning returns non-empty string when reachedFloor=true and size > budget', () => {
    const warning = computeDiskBudgetWarning(1_000, 500, true);
    expect(typeof warning).toBe('string');
    expect((warning as string).length).toBeGreaterThan(0);
  });

  /**
   * Boundary: size >= 90% of budget → warning must be non-empty (R6.5).
   */
  it('computeDiskBudgetWarning returns non-empty string when size >= 90% of budget', () => {
    const budget = 1_000;
    const size = 900; // exactly 90%
    const warning = computeDiskBudgetWarning(size, budget, false);
    expect(typeof warning).toBe('string');
    expect((warning as string).length).toBeGreaterThan(0);
  });

  /**
   * Boundary: size < 90% of budget and reachedFloor=false → no warning.
   */
  it('computeDiskBudgetWarning returns undefined when size < 90% of budget and not at floor', () => {
    const budget = 1_000;
    const size = 800; // 80% — below threshold
    expect(computeDiskBudgetWarning(size, budget, false)).toBeUndefined();
  });
});
