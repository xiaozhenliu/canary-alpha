/**
 * Integration tests for trim + retention pass.
 *
 * Extends the existing screenpipe-trim-service integration tests with
 * Disk_Budget configuration scenarios (Requirements 2.1, 2.4, 2.5).
 *
 * Three scenarios:
 *   1. budget=null  → retention is a no-op (backward compatible)
 *   2. budget set, old rows exist → retention deletes old rows until under budget
 *   3. budget set, no rows older than retention-days → reachedFloor=true, no rows deleted
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { runRetentionIfOverBudget, runTrimOnce } from '../../src/services/trim/screenpipe-trim-service.js';
import { testTempRoot } from '../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createDb(dir: string, sql: string): Promise<string> {
  const dbPath = join(dir, 'db.sqlite');
  await mkdir(dir, { recursive: true });
  await execFileAsync('sqlite3', [dbPath, sql]);
  return dbPath;
}

/** Returns the byte size of a file. */
async function fileSize(filePath: string): Promise<number> {
  const s = await stat(filePath);
  return s.size;
}

/** Counts rows in a table. */
async function countRows(dbPath: string, table: string): Promise<number> {
  const { stdout } = await execFileAsync('sqlite3', [dbPath, `SELECT COUNT(*) FROM ${table};`]);
  return parseInt(stdout.trim(), 10);
}

/**
 * Creates a minimal frames+elements schema with WAL mode.
 * Timestamps are ISO-8601 strings so SQLite string comparison works correctly.
 */
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

/** ISO timestamp N days ago. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1_000).toISOString();
}

/** ISO timestamp N days in the future. */
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1_000).toISOString();
}

// ---------------------------------------------------------------------------
// Scenario 1: budget=null → retention is a no-op
// ---------------------------------------------------------------------------

describe('runRetentionIfOverBudget – budget=null (backward compatible)', () => {
  it('returns zero counts and reachedFloor=false without touching the database', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'retention-null-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const sql = [
      buildSchema(),
      // Insert old rows that would be deleted if budget were set
      `INSERT INTO frames VALUES (1, 1, NULL, '${daysAgo(30)}');`,
      `INSERT INTO frames VALUES (2, 2, NULL, '${daysAgo(20)}');`,
      `INSERT INTO elements VALUES (1, 1), (2, 2);`
    ].join('\n');
    const dbPath = await createDb(root, sql);

    const result = await runRetentionIfOverBudget(dbPath, null, 7);

    expect(result.framesDeleted).toBe(0);
    expect(result.elementsDeleted).toBe(0);
    expect(result.reachedFloor).toBe(false);

    // Database must be untouched
    expect(await countRows(dbPath, 'frames')).toBe(2);
    expect(await countRows(dbPath, 'elements')).toBe(2);
  });

  it('runTrimOnce with budgetBytes=null does not delete any rows', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'trim-null-budget-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const sql = [
      buildSchema(),
      `INSERT INTO frames VALUES (1, 1, NULL, '${daysAgo(30)}');`,
      `INSERT INTO frames VALUES (2, 2, NULL, '${daysAgo(20)}');`,
      `INSERT INTO elements VALUES (1, 1), (2, 2);`
    ].join('\n');
    const dbPath = await createDb(root, sql);

    // Pass budgetBytes=null explicitly (the TrimOptions path)
    await runTrimOnce(dbPath, { budgetBytes: null, retentionDays: 7 });

    expect(await countRows(dbPath, 'frames')).toBe(2);
    expect(await countRows(dbPath, 'elements')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: budget set, old rows exist → retention deletes old rows
// ---------------------------------------------------------------------------

describe('runRetentionIfOverBudget – budget triggers deletion of old rows', () => {
  it('deletes frames and elements older than retention-days when db exceeds budget', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'retention-over-budget-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const sql = [
      buildSchema(),
      // Two old rows (30 days ago, well beyond 7-day retention)
      `INSERT INTO frames VALUES (1, 1, NULL, '${daysAgo(30)}');`,
      `INSERT INTO frames VALUES (2, 2, NULL, '${daysAgo(20)}');`,
      // One recent row (within retention window)
      `INSERT INTO frames VALUES (3, 3, NULL, '${daysAgo(1)}');`,
      `INSERT INTO elements VALUES (1, 1), (2, 2), (3, 3);`
    ].join('\n');
    const dbPath = await createDb(root, sql);

    // Use a budget of 1 byte to guarantee the db is always "over budget"
    // so the retention loop runs until it hits the floor or clears old rows.
    const result = await runRetentionIfOverBudget(dbPath, 1, 7);

    // Old rows (>7 days) should have been deleted
    expect(result.framesDeleted).toBeGreaterThan(0);
    expect(result.elementsDeleted).toBeGreaterThan(0);

    // The recent row (1 day ago) must still be present
    const { stdout } = await execFileAsync('sqlite3', [dbPath, `SELECT id FROM frames WHERE id = 3;`]);
    expect(stdout.trim()).toBe('3');
  });

  it('runTrimOnce with budgetBytes=1 triggers retention and removes old rows', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'trim-over-budget-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const sql = [
      buildSchema(),
      `INSERT INTO frames VALUES (1, 1, NULL, '${daysAgo(30)}');`,
      `INSERT INTO frames VALUES (2, 2, NULL, '${daysAgo(20)}');`,
      `INSERT INTO frames VALUES (3, 3, NULL, '${daysAgo(1)}');`,
      `INSERT INTO elements VALUES (1, 1), (2, 2), (3, 3);`
    ].join('\n');
    const dbPath = await createDb(root, sql);

    const framesBefore = await countRows(dbPath, 'frames');
    expect(framesBefore).toBe(3);

    await runTrimOnce(dbPath, { budgetBytes: 1, retentionDays: 7 });

    // Old rows should be gone; recent row should remain
    const framesAfter = await countRows(dbPath, 'frames');
    expect(framesAfter).toBeLessThan(framesBefore);

    const { stdout } = await execFileAsync('sqlite3', [dbPath, `SELECT id FROM frames WHERE id = 3;`]);
    expect(stdout.trim()).toBe('3');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: budget set, no rows older than retention-days → reachedFloor
// ---------------------------------------------------------------------------

describe('runRetentionIfOverBudget – floor reached (no rows older than retention-days)', () => {
  it('returns reachedFloor=true and deletes nothing when all rows are within retention window', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'retention-floor-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const sql = [
      buildSchema(),
      // All rows are recent (within 7-day retention window)
      `INSERT INTO frames VALUES (1, 1, NULL, '${daysAgo(1)}');`,
      `INSERT INTO frames VALUES (2, 2, NULL, '${daysAgo(2)}');`,
      `INSERT INTO elements VALUES (1, 1), (2, 2);`
    ].join('\n');
    const dbPath = await createDb(root, sql);

    // Budget of 1 byte → db is always "over budget", but no rows are old enough to delete
    const result = await runRetentionIfOverBudget(dbPath, 1, 7);

    expect(result.reachedFloor).toBe(true);
    expect(result.framesDeleted).toBe(0);
    expect(result.elementsDeleted).toBe(0);

    // All rows must still be present
    expect(await countRows(dbPath, 'frames')).toBe(2);
    expect(await countRows(dbPath, 'elements')).toBe(2);
  });

  it('runTrimOnce with budgetBytes=1 and only recent rows leaves all rows intact', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'trim-floor-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const sql = [
      buildSchema(),
      `INSERT INTO frames VALUES (1, 1, NULL, '${daysAgo(1)}');`,
      `INSERT INTO frames VALUES (2, 2, NULL, '${daysAgo(2)}');`,
      `INSERT INTO elements VALUES (1, 1), (2, 2);`
    ].join('\n');
    const dbPath = await createDb(root, sql);

    await runTrimOnce(dbPath, { budgetBytes: 1, retentionDays: 7 });

    // No rows should have been deleted (floor reached)
    expect(await countRows(dbPath, 'frames')).toBe(2);
    expect(await countRows(dbPath, 'elements')).toBe(2);
  });
});
