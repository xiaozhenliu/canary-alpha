import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ScreenpipeTrimResult } from '../../types/app-config.js';

const execFileAsync = promisify(execFile);
const SQLITE3_BINARY = 'sqlite3';
const TRIM_BATCH_SIZE = 100;
const TRIM_BATCH_TIMEOUT_MS = 10_000;
const TRIM_NULL_TIMEOUT_MS = 30_000;

const ENSURE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_frames_content_hash ON frames(content_hash) WHERE content_hash IS NOT NULL;`;

const DUPLICATE_FRAME_IDS_SQL = `
SELECT id FROM frames
WHERE content_hash IS NOT NULL
  AND id NOT IN (SELECT MIN(id) FROM frames WHERE content_hash IS NOT NULL GROUP BY content_hash)
LIMIT ${TRIM_BATCH_SIZE};`.trim();

function buildBatchDeleteSql(batchSize: number): string {
  return `
DELETE FROM elements WHERE frame_id IN (
  SELECT id FROM frames
  WHERE content_hash IS NOT NULL
    AND id NOT IN (SELECT MIN(id) FROM frames WHERE content_hash IS NOT NULL GROUP BY content_hash)
  LIMIT ${batchSize}
);
SELECT changes();
DELETE FROM frames WHERE id IN (
  SELECT id FROM frames
  WHERE content_hash IS NOT NULL
    AND id NOT IN (SELECT MIN(id) FROM frames WHERE content_hash IS NOT NULL GROUP BY content_hash)
  LIMIT ${batchSize}
);
SELECT changes();`.trim();
}

const NULL_JSON_SQL = `
UPDATE frames SET accessibility_tree_json = NULL
WHERE accessibility_tree_json IS NOT NULL
  AND EXISTS (SELECT 1 FROM elements WHERE elements.frame_id = frames.id);
SELECT changes();`.trim();

async function countDuplicates(databasePath: string): Promise<number> {
  const { stdout } = await execFileAsync(SQLITE3_BINARY, [databasePath, DUPLICATE_FRAME_IDS_SQL], {
    timeout: TRIM_BATCH_TIMEOUT_MS
  });
  return stdout.trim() ? stdout.trim().split('\n').length : 0;
}

export async function runTrimOnce(databasePath: string): Promise<ScreenpipeTrimResult> {
  const start = Date.now();
  let duplicatesRemoved = 0;
  let elementsRemoved = 0;
  let accessibilityJsonNulled = 0;

  try {
    await execFileAsync(SQLITE3_BINARY, [databasePath, ENSURE_INDEX_SQL], { timeout: TRIM_BATCH_TIMEOUT_MS });

    // Batch-delete duplicates until none remain
    while (true) {
      const remaining = await countDuplicates(databasePath);
      if (remaining === 0) break;

      const { stdout } = await execFileAsync(
        SQLITE3_BINARY,
        [databasePath, buildBatchDeleteSql(TRIM_BATCH_SIZE)],
        { timeout: TRIM_BATCH_TIMEOUT_MS }
      );
      const counts = stdout.trim().split('\n').map(Number).filter((n) => !Number.isNaN(n));
      elementsRemoved += counts[0] ?? 0;
      duplicatesRemoved += counts[1] ?? 0;

      if ((counts[1] ?? 0) === 0) break;
    }

    // Null accessibility_tree_json on kept frames that have elements
    const { stdout: nullOut } = await execFileAsync(
      SQLITE3_BINARY,
      [databasePath, NULL_JSON_SQL],
      { timeout: TRIM_NULL_TIMEOUT_MS }
    );
    const nullCounts = nullOut.trim().split('\n').map(Number).filter((n) => !Number.isNaN(n));
    accessibilityJsonNulled = nullCounts[0] ?? 0;
  } catch {
    // Degrade gracefully — return whatever was accumulated
  }

  return { duplicatesRemoved, elementsRemoved, accessibilityJsonNulled, durationMs: Date.now() - start };
}

