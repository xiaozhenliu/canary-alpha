import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  throw new Error(
    `vacuum-init requires Node >= 22.13 (current ${process.versions.node}) for node:sqlite user functions.`
  );
}

const BACKUP_FILE_RE = /^db-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/;

export interface VacuumInitOptions {
  databasePath: string;
  backupDir: string;
  probeScreenpipeRunning: () => boolean;
}

export interface VacuumInitResult {
  ok: boolean;
  error?: string;
  sizeBeforeBytes?: number;
  sizeAfterBytes?: number;
}

export function mapVacuumError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/disk image is malformed/i.test(message)) {
    return (
      `VACUUM failed: "${message}". This usually is not database corruption: VACUUM re-evaluates CHECK ` +
      'constraints row-by-row, so an incompatible vec_length shim or invalid vector row can trigger this.'
    );
  }
  if (/no such function: vec_length/i.test(message)) {
    return 'VACUUM failed: vec_length is not registered, but a CHECK constraint requires it.';
  }
  return `VACUUM failed: ${message}`;
}

function backupDatabase(databasePath: string, backupDir: string): void {
  mkdirSync(backupDir, { recursive: true });
  const oldBackups = readdirSync(backupDir).filter((entry) => BACKUP_FILE_RE.test(entry));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = `db-backup-${stamp}.sqlite`;
  const backupPath = join(backupDir, backupFile);
  copyFileSync(databasePath, backupPath);
  for (const old of oldBackups) {
    if (old === backupFile) {
      continue;
    }
    rmSync(join(backupDir, old), { force: true });
  }
}

export function runVacuumInit(options: VacuumInitOptions): VacuumInitResult {
  if (options.probeScreenpipeRunning()) {
    return { ok: false, error: 'screenpipe is still running; init is an offline operation.' };
  }

  const sizeBefore = statSync(options.databasePath).size;
  try {
    const fs = statfsSync(options.databasePath);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    if (freeBytes < sizeBefore * 2.5) {
      return { ok: false, error: `not enough disk space: need about ${Math.ceil((sizeBefore * 2.5) / 1e6)}MB free.` };
    }
  } catch {
    // Some filesystems do not support statfs for the path shape used in tests.
  }

  const db = new DatabaseSync(options.databasePath, { allowExtension: false });
  try {
    db.function('vec_length', (blob: unknown) => (blob instanceof Uint8Array ? blob.byteLength / 4 : null));
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch (error) {
    db.close();
    return {
      ok: false,
      error: `database exclusive lock is unavailable; screenpipe may still be writing: ${(error as Error).message}`
    };
  }

  try {
    backupDatabase(options.databasePath, options.backupDir);
    db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
    db.exec('VACUUM;');
  } catch (error) {
    db.close();
    return { ok: false, error: mapVacuumError(error) };
  }
  db.close();

  if (options.probeScreenpipeRunning()) {
    return { ok: false, error: 'VACUUM completed but screenpipe appears to have restarted; rerun status.' };
  }

  return { ok: true, sizeBeforeBytes: sizeBefore, sizeAfterBytes: statSync(options.databasePath).size };
}
