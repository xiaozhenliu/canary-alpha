import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { runTrimOnce } from '../../src/services/trim/screenpipe-trim-service.js';
import { testTempRoot } from '../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function createTrimFixture(dir: string): Promise<string> {
  const dbPath = join(dir, 'db.sqlite');
  const sql = [
    'PRAGMA journal_mode = WAL;',
    `CREATE TABLE frames(
      id INTEGER PRIMARY KEY,
      content_hash INTEGER,
      accessibility_tree_json TEXT
    );`,
    `CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL);`,
    // frames 1 and 2 share content_hash 42 (duplicates); frame 3 is unique
    `INSERT INTO frames VALUES (1, 42, 'json-a'), (2, 42, 'json-b'), (3, 99, 'json-c');`,
    // elements for each frame
    `INSERT INTO elements VALUES (1, 1), (2, 2), (3, 3);`
  ].join('\n');
  await mkdir(dir, { recursive: true });
  await execFileAsync('sqlite3', [dbPath, sql]);
  return dbPath;
}

describe('runTrimOnce', () => {
  it('removes duplicate frames and their elements, keeps unique frame', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'screenpipe-trim-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const dbPath = await createTrimFixture(root);

    const result = await runTrimOnce(dbPath);

    expect(result.duplicatesRemoved).toBe(1);
    expect(result.elementsRemoved).toBe(1);

    const { stdout: frameRows } = await execFileAsync('sqlite3', [dbPath, 'SELECT id FROM frames ORDER BY id;']);
    expect(frameRows.trim().split('\n')).toEqual(['1', '3']);

    const { stdout: elemRows } = await execFileAsync('sqlite3', [dbPath, 'SELECT frame_id FROM elements ORDER BY frame_id;']);
    expect(elemRows.trim().split('\n')).toEqual(['1', '3']);
  });

  it('nulls accessibility_tree_json on frames that have elements rows', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'screenpipe-trim-null-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const dbPath = await createTrimFixture(root);

    const result = await runTrimOnce(dbPath);

    // frames 1 and 3 remain; both have elements rows so both get nulled
    expect(result.accessibilityJsonNulled).toBe(2);

    const { stdout } = await execFileAsync('sqlite3', [dbPath, 'SELECT COUNT(*) FROM frames WHERE accessibility_tree_json IS NOT NULL;']);
    expect(stdout.trim()).toBe('0');
  });

  it('returns zero counts without throwing when db path is missing', async () => {
    const result = await runTrimOnce('/nonexistent/path/db.sqlite');
    expect(result.duplicatesRemoved).toBe(0);
    expect(result.elementsRemoved).toBe(0);
    expect(result.accessibilityJsonNulled).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('skips frames with NULL content_hash', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'screenpipe-trim-null-hash-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, 'db.sqlite');
    const sql = [
      'PRAGMA journal_mode = WAL;',
      `CREATE TABLE frames(id INTEGER PRIMARY KEY, content_hash INTEGER, accessibility_tree_json TEXT);`,
      `CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL);`,
      `INSERT INTO frames VALUES (1, NULL, 'json-a'), (2, NULL, 'json-b');`,
      `INSERT INTO elements VALUES (1, 1), (2, 2);`
    ].join('\n');
    await mkdir(root, { recursive: true });
    await execFileAsync('sqlite3', [dbPath, sql]);

    const result = await runTrimOnce(dbPath);

    expect(result.duplicatesRemoved).toBe(0);
    const { stdout } = await execFileAsync('sqlite3', [dbPath, 'SELECT COUNT(*) FROM frames;']);
    expect(stdout.trim()).toBe('2');
  });
});
