import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { DefaultPrivacyControlService } from '../../../src/services/privacy/privacy-control-service.js';
import type { PrivacyState, PrivacyStore } from '../../../src/services/privacy/types.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

class InMemoryPrivacyStore implements PrivacyStore {
  constructor(private state: PrivacyState = { paused: false, excludedApps: [] }) {}
  async read(): Promise<PrivacyState> { return this.state; }
  async write(state: PrivacyState): Promise<void> { this.state = state; }
}

async function createFixtureDb(dir: string): Promise<string> {
  const dbPath = join(dir, 'db.sqlite');
  const sql = [
    'PRAGMA journal_mode = WAL;',
    `CREATE TABLE frames(id INTEGER PRIMARY KEY, timestamp TIMESTAMP NOT NULL);`,
    `CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL);`,
    `INSERT INTO frames VALUES
      (1, datetime('now', '-2 hours')),
      (2, datetime('now', '-30 minutes')),
      (3, datetime('now', '-2 days')),
      (4, datetime('now', '-10 minutes'));`,
    `INSERT INTO elements VALUES (1,1),(2,2),(3,3),(4,4);`
  ].join('\n');
  await mkdir(dir, { recursive: true });
  await execFileAsync('sqlite3', [dbPath, sql]);
  return dbPath;
}

describe('privacy delete-range semantics', () => {
  it('fails when range is missing', async () => {
    const service = new DefaultPrivacyControlService(new InMemoryPrivacyStore());
    const result = await service.execute({ action: 'delete-range', confirm: true });
    expect(result.error).toMatchObject({ code: 'PRIVACY_RANGE_REQUIRED' });
  });

  it('fails when confirm is not true', async () => {
    const service = new DefaultPrivacyControlService(new InMemoryPrivacyStore());
    const result = await service.execute({ action: 'delete-range', range: 'last_1d' });
    expect(result.error).toMatchObject({ code: 'PRIVACY_CONFIRM_REQUIRED' });
    expect(result.confirmed).toBe(false);
  });

  it('returns allowed delete ranges on status responses', async () => {
    const service = new DefaultPrivacyControlService(new InMemoryPrivacyStore());
    const result = await service.execute({ action: 'status' });
    expect(result.allowedDeleteRanges).toEqual(['last_1h', 'last_1d', 'all']);
  });

  it('supports confirmed last_1h by appending a suppressed range', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'privacy-delete-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await createFixtureDb(root);
    const store = new InMemoryPrivacyStore({
      paused: false,
      excludedApps: ['Claude'],
      suppressedRanges: [{ from: '2026-04-13T09:00:00.000Z', to: '2026-04-13T09:30:00.000Z' }]
    });
    const now = new Date('2026-04-13T12:05:00.000Z');
    const service = new DefaultPrivacyControlService(store, () => now, { screenpipeDirectory: root });
    const result = await service.execute({ action: 'delete-range', range: 'last_1h', confirm: true });

    expect(result.confirmed).toBe(true);
    expect(result.requestedRange).toBe('last_1h');
    expect(result.error).toBeUndefined();
    expect(result.deletedFrames).toBeGreaterThanOrEqual(0);
    const state = await store.read();
    expect(state.suppressedRanges).toHaveLength(2);
  });

  it('deletes frames within last_1h from SQLite', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'privacy-delete-1h-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const dbPath = await createFixtureDb(root);
    const service = new DefaultPrivacyControlService(new InMemoryPrivacyStore(), undefined, { screenpipeDirectory: root });
    const result = await service.execute({ action: 'delete-range', range: 'last_1h', confirm: true });

    expect(result.confirmed).toBe(true);
    expect(result.deletedFrames).toBe(2); // frames 2 and 4 are within last hour
    const { stdout } = await execFileAsync('sqlite3', [dbPath, 'SELECT COUNT(*) FROM frames;']);
    expect(stdout.trim()).toBe('2');
  });

  it('deletes all frames for range=all', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'privacy-delete-all-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const dbPath = await createFixtureDb(root);
    const service = new DefaultPrivacyControlService(new InMemoryPrivacyStore(), undefined, { screenpipeDirectory: root });
    const result = await service.execute({ action: 'delete-range', range: 'all', confirm: true });

    expect(result.confirmed).toBe(true);
    expect(result.deletedFrames).toBe(4);
    const { stdout } = await execFileAsync('sqlite3', [dbPath, 'SELECT COUNT(*) FROM frames;']);
    expect(stdout.trim()).toBe('0');
  });

  it('degrades gracefully when db path is missing', async () => {
    const service = new DefaultPrivacyControlService(new InMemoryPrivacyStore(), undefined, { screenpipeDirectory: '/nonexistent/path' });
    const result = await service.execute({ action: 'delete-range', range: 'last_1d', confirm: true });
    expect(result.confirmed).toBe(true);
    expect(result.error).toMatchObject({ code: 'PRIVACY_DELETE_UNAVAILABLE' });
  });
});
