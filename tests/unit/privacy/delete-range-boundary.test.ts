/**
 * Unit-level coverage for the P0 fix to
 * `DefaultPrivacyControlService.deleteScreenpipeRange`:
 *
 *   1. last_1h boundary correctness — a frame at "now - 59 minutes"
 *      is deleted while a frame at "now - 61 minutes" survives.
 *   2. SQL injection safety — passing a forged `range` string as if
 *      it were a custom range cannot smuggle SQL into the upstream
 *      delete because every value flows through a bound parameter
 *      and `rangeToIsoFrom` only honours the closed enum.
 *   3. Frames outside the window are not touched.
 *
 * The test wires a real (in-memory) ScreenPipe-style db.sqlite so
 * the prepared-statement path exercises the full code path.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DefaultPrivacyControlService,
  rangeToIsoFrom
} from '../../../src/services/privacy/privacy-control-service.js';
import { testTempRoot } from '../../helpers/test-tmp.js';
import type { PrivacyState, PrivacyStore } from '../../../src/services/privacy/types.js';

class InMemoryPrivacyStore implements PrivacyStore {
  constructor(private state: PrivacyState = { paused: false, excludedApps: [] }) {}
  async read(): Promise<PrivacyState> {
    return this.state;
  }
  async write(state: PrivacyState): Promise<void> {
    this.state = state;
  }
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

interface ScreenpipeFrame {
  id: number;
  timestamp: string; // ISO-8601 (offset-aware)
}

async function setupScreenpipeFixture(frames: ScreenpipeFrame[]): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(join(testTempRoot(), 'privacy-delete-range-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE frames (id INTEGER PRIMARY KEY, timestamp TIMESTAMP NOT NULL);
     CREATE TABLE elements (id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL);`
  );
  const insertFrame = db.prepare('INSERT INTO frames(id, timestamp) VALUES (?, ?)');
  const insertElement = db.prepare('INSERT INTO elements(id, frame_id) VALUES (?, ?)');
  for (const frame of frames) {
    insertFrame.run(frame.id, frame.timestamp);
    insertElement.run(frame.id, frame.id);
  }
  db.close();
  return { dir, dbPath };
}

function readFrames(dbPath: string): number[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare('SELECT id FROM frames ORDER BY id ASC').all() as Array<{ id: number | bigint }>;
    return rows.map((row) => Number(row.id));
  } finally {
    db.close();
  }
}

describe('rangeToIsoFrom', () => {
  it('returns now - 1h for last_1h', () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    expect(rangeToIsoFrom('last_1h', now)).toBe('2026-04-13T11:00:00.000Z');
  });

  it('returns now - 24h for last_1d', () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    expect(rangeToIsoFrom('last_1d', now)).toBe('2026-04-12T12:00:00.000Z');
  });

  it('returns the epoch ISO floor for range="all"', () => {
    expect(rangeToIsoFrom('all', new Date('2026-04-13T12:00:00.000Z'))).toBe(
      '1970-01-01T00:00:00.000Z'
    );
  });
});

describe('deleteScreenpipeRange — last_1h boundary', () => {
  it('deletes a frame at now-59 minutes but keeps a frame at now-61 minutes', async () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    const frames: ScreenpipeFrame[] = [
      { id: 1, timestamp: new Date(now.getTime() - 61 * 60 * 1000).toISOString() }, // outside
      { id: 2, timestamp: new Date(now.getTime() - 59 * 60 * 1000).toISOString() }, // inside
      { id: 3, timestamp: new Date(now.getTime() - 1 * 60 * 1000).toISOString() }, // inside
      { id: 4, timestamp: new Date(now.getTime() + 5 * 60 * 1000).toISOString() } // future, outside
    ];
    const { dir, dbPath } = await setupScreenpipeFixture(frames);

    const service = new DefaultPrivacyControlService(
      new InMemoryPrivacyStore(),
      () => now,
      { screenpipeDirectory: dir }
    );
    const result = await service.execute({ action: 'delete-range', range: 'last_1h', confirm: true });

    expect(result.error).toBeUndefined();
    expect(result.deletedFrames).toBe(2);
    expect(readFrames(dbPath)).toEqual([1, 4]);
  });

  it('handles offset-aware timestamps via datetime() coercion', async () => {
    // The boundary frame is 30 minutes ago in Asia/Shanghai (+08:00).
    // The previous lexicographic comparison would have considered
    // the offset string ("+08:00") as part of the "<" sort, missing
    // the row. With `datetime()` coercion both sides normalise to
    // UTC and the row is correctly deleted.
    const now = new Date('2026-04-13T12:00:00.000Z');
    const frames: ScreenpipeFrame[] = [
      { id: 10, timestamp: '2026-04-13T19:30:00+08:00' }, // == 11:30 UTC, inside last_1h
      { id: 11, timestamp: '2026-04-13T18:30:00+08:00' } // == 10:30 UTC, outside last_1h
    ];
    const { dir, dbPath } = await setupScreenpipeFixture(frames);

    const service = new DefaultPrivacyControlService(
      new InMemoryPrivacyStore(),
      () => now,
      { screenpipeDirectory: dir }
    );
    const result = await service.execute({ action: 'delete-range', range: 'last_1h', confirm: true });

    expect(result.deletedFrames).toBe(1);
    expect(readFrames(dbPath)).toEqual([11]);
  });
});

describe('deleteScreenpipeRange — parameterization safety', () => {
  it('rejects unknown ranges via the allow-list before touching SQL', async () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    const { dir, dbPath } = await setupScreenpipeFixture([
      { id: 1, timestamp: now.toISOString() }
    ]);
    const service = new DefaultPrivacyControlService(
      new InMemoryPrivacyStore(),
      () => now,
      { screenpipeDirectory: dir }
    );

    // Cast keeps the compiler honest about the public API while
    // proving the runtime guard rejects forged values without
    // running SQL. The frames table MUST remain untouched.
    const malicious = "all'; DROP TABLE frames; --" as unknown as 'last_1h';
    const result = await service.execute({ action: 'delete-range', range: malicious, confirm: true });

    expect(result.error?.code).toBe('PRIVACY_UNSUPPORTED_RANGE');
    expect(readFrames(dbPath)).toEqual([1]);
  });
});

describe('deleteScreenpipeRange — rows outside window', () => {
  it('range=last_1d leaves rows older than 24h untouched', async () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    const frames: ScreenpipeFrame[] = [
      { id: 1, timestamp: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString() },
      { id: 2, timestamp: new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString() }
    ];
    const { dir, dbPath } = await setupScreenpipeFixture(frames);

    const service = new DefaultPrivacyControlService(
      new InMemoryPrivacyStore(),
      () => now,
      { screenpipeDirectory: dir }
    );
    const result = await service.execute({ action: 'delete-range', range: 'last_1d', confirm: true });

    expect(result.deletedFrames).toBe(1);
    expect(readFrames(dbPath)).toEqual([1]);
  });

  it('range=all deletes every row including rows back to 1970', async () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    const frames: ScreenpipeFrame[] = [
      { id: 1, timestamp: '1970-01-02T00:00:00.000Z' },
      { id: 2, timestamp: '2025-01-01T00:00:00.000Z' },
      { id: 3, timestamp: now.toISOString() }
    ];
    const { dir, dbPath } = await setupScreenpipeFixture(frames);

    const service = new DefaultPrivacyControlService(
      new InMemoryPrivacyStore(),
      () => now,
      { screenpipeDirectory: dir }
    );
    const result = await service.execute({ action: 'delete-range', range: 'all', confirm: true });

    expect(result.deletedFrames).toBe(3);
    expect(readFrames(dbPath)).toEqual([]);
  });
});
