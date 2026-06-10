import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mapVacuumError, runVacuumInit } from '../../../src/services/maintenance/vacuum-init.js';
import { addSpeakerEmbeddingsTable, createFixtureDb } from '../../helpers/maintenance-fixture.js';

describe('runVacuumInit', () => {
  let dir: string;
  let dbPath: string;
  let backupDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ax-init-'));
    dbPath = join(dir, 'db.sqlite');
    backupDir = join(dir, 'backup');
    const db = createFixtureDb(dbPath);
    db.function('vec_length', (blob: unknown) => (blob instanceof Uint8Array ? blob.byteLength / 4 : null));
    addSpeakerEmbeddingsTable(db);
    db.prepare('INSERT INTO speaker_embeddings (embedding) VALUES (?)').run(new Uint8Array(2048));
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('initializes incremental auto_vacuum on a database with vec_length CHECK constraints', () => {
    const result = runVacuumInit({ databasePath: dbPath, backupDir, probeScreenpipeRunning: () => false });
    expect(result.ok).toBe(true);
    const db = new DatabaseSync(dbPath);
    const mode = Number((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum);
    db.close();
    expect(mode).toBe(2);
  });

  it('creates a backup and keeps only one backup file', () => {
    runVacuumInit({ databasePath: dbPath, backupDir, probeScreenpipeRunning: () => false });
    runVacuumInit({ databasePath: dbPath, backupDir, probeScreenpipeRunning: () => false });
    expect(existsSync(backupDir)).toBe(true);
    expect(readdirSync(backupDir).filter((file) => file.endsWith('.sqlite'))).toHaveLength(1);
  });

  it('does not delete non-maintenance sqlite files from the backup directory', () => {
    runVacuumInit({ databasePath: dbPath, backupDir, probeScreenpipeRunning: () => false });
    const other = join(backupDir, 'manual.sqlite');
    new DatabaseSync(other).close();
    const prefixedOther = join(backupDir, 'db-backup-manual.sqlite');
    new DatabaseSync(prefixedOther).close();
    runVacuumInit({ databasePath: dbPath, backupDir, probeScreenpipeRunning: () => false });
    expect(existsSync(other)).toBe(true);
    expect(existsSync(prefixedOther)).toBe(true);
    expect(
      readdirSync(backupDir).filter((file) =>
        /^db-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/.test(file)
      )
    ).toHaveLength(1);
  });

  it('refuses to run while screenpipe appears active', () => {
    const result = runVacuumInit({ databasePath: dbPath, backupDir, probeScreenpipeRunning: () => true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/screenpipe/i);
  });

  it('maps VACUUM failures to actionable messages', () => {
    expect(mapVacuumError(new Error('database disk image is malformed'))).toMatch(/vec_length|CHECK/);
    expect(mapVacuumError(new Error('no such function: vec_length'))).toMatch(/vec_length/);
  });
});
