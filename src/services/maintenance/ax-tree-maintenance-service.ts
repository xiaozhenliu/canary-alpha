import { DatabaseSync } from 'node:sqlite';

import { convertTreeJson } from './ax-tree-converter.js';

const DEFAULT_MIN_FRAME_AGE_MS = 15 * 60_000;
const DEFAULT_BATCH_SIZE = 100;

export interface SweepResult {
  jsonNulledViaExisting: number;
  converted: number;
  convertFailures: number;
  skippedSchemaGuard: boolean;
}

export interface ReclaimResult {
  pagesBefore: number;
  pagesAfter: number;
  skippedSchemaGuard: boolean;
}

export interface MaintenanceStatus {
  framesWithTreeJson: number;
  danglingRefs: number;
  pageCount: number;
  freelistCount: number;
  autoVacuumMode: number;
}

export interface MaintenanceServiceOptions {
  databasePath: string;
  minFrameAgeMs?: number;
  batchSize?: number;
  now?: () => Date;
  logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => void };
  beforeConvertTxn?: () => void;
}

interface CandidateRow {
  id: number;
  tree: string;
  ref: number | null;
}

function schemaIsCompatible(db: DatabaseSync): boolean {
  try {
    const frameCols = new Set(
      (db.prepare('PRAGMA table_info(frames)').all() as Array<{ name: string }>).map((col) => col.name)
    );
    const elementCols = new Set(
      (db.prepare('PRAGMA table_info(elements)').all() as Array<{ name: string }>).map((col) => col.name)
    );
    return (
      ['accessibility_tree_json', 'elements_ref_frame_id', 'timestamp'].every((col) => frameCols.has(col)) &&
      ['frame_id', 'source', 'role', 'depth', 'sort_order', 'properties', 'parent_id'].every((col) =>
        elementCols.has(col)
      )
    );
  } catch {
    return false;
  }
}

function hasElementsForFrame(db: DatabaseSync, frameId: number, ref: number | null): boolean {
  const targetFrameId = ref ?? frameId;
  return db.prepare('SELECT 1 AS one FROM elements WHERE frame_id = ? LIMIT 1').get(targetFrameId) !== undefined;
}

function readFirstNumber(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return Number(Object.values(row ?? { value: 0 })[0]);
}

export function createAxTreeMaintenanceService(options: MaintenanceServiceOptions) {
  const minAge = options.minFrameAgeMs ?? DEFAULT_MIN_FRAME_AGE_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const now = options.now ?? (() => new Date());

  function sweepOnce(): SweepResult {
    const result: SweepResult = {
      jsonNulledViaExisting: 0,
      converted: 0,
      convertFailures: 0,
      skippedSchemaGuard: false
    };
    const db = new DatabaseSync(options.databasePath);
    try {
      db.exec('PRAGMA busy_timeout = 5000;');
      if (!schemaIsCompatible(db)) {
        result.skippedSchemaGuard = true;
        options.logger?.warn?.('maintenance sweep skipped: schema drift detected');
        return result;
      }

      const cutoffIso = new Date(now().getTime() - minAge).toISOString();
      const candidates = db
        .prepare(
          `SELECT id, accessibility_tree_json AS tree, elements_ref_frame_id AS ref
           FROM frames
           WHERE accessibility_tree_json IS NOT NULL
             AND accessibility_tree_json != ''
             AND datetime(timestamp) < datetime(?)
           ORDER BY id ASC
           LIMIT ?`
        )
        .all(cutoffIso, batchSize) as unknown as CandidateRow[];

      for (const candidate of candidates) {
        const frameId = Number(candidate.id);
        const ref = candidate.ref === null ? null : Number(candidate.ref);

        if (hasElementsForFrame(db, frameId, ref)) {
          db.prepare('UPDATE frames SET accessibility_tree_json = NULL WHERE id = ?').run(frameId);
          result.jsonNulledViaExisting += 1;
          continue;
        }

        let rows;
        try {
          rows = convertTreeJson(candidate.tree);
        } catch {
          result.convertFailures += 1;
          continue;
        }

        options.beforeConvertTxn?.();

        db.exec('BEGIN IMMEDIATE');
        try {
          if (hasElementsForFrame(db, frameId, ref)) {
            db.prepare('UPDATE frames SET accessibility_tree_json = NULL WHERE id = ?').run(frameId);
            result.jsonNulledViaExisting += 1;
            db.exec('COMMIT');
            continue;
          }

          const insert = db.prepare(
            `INSERT INTO elements
               (frame_id, source, role, text, parent_id, depth,
                left_bound, top_bound, width_bound, height_bound,
                sort_order, properties, on_screen)
             VALUES (?, 'accessibility', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          );
          const indexToElementId = new Map<number, number>();
          for (const row of rows) {
            const parentId = row.parentIndex === null ? null : (indexToElementId.get(row.parentIndex) ?? null);
            const insertResult = insert.run(
              frameId,
              row.role,
              row.text,
              parentId,
              row.depth,
              row.bounds?.left ?? null,
              row.bounds?.top ?? null,
              row.bounds?.width ?? null,
              row.bounds?.height ?? null,
              row.sortOrder,
              row.properties,
              row.onScreen
            );
            indexToElementId.set(row.sortOrder, Number(insertResult.lastInsertRowid));
          }
          db.prepare('UPDATE frames SET accessibility_tree_json = NULL, elements_ref_frame_id = ? WHERE id = ?').run(
            frameId,
            frameId
          );
          db.exec('COMMIT');
          result.converted += 1;
        } catch (error) {
          db.exec('ROLLBACK');
          result.convertFailures += 1;
          options.logger?.warn?.('maintenance convert txn failed', {
            frameId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return result;
    } finally {
      db.close();
    }
  }

  function reclaimOnce(opts: { maxPages?: number } = {}): ReclaimResult {
    const maxPages = opts.maxPages ?? 2_000;
    const db = new DatabaseSync(options.databasePath);
    try {
      db.exec('PRAGMA busy_timeout = 5000;');
      if (!schemaIsCompatible(db)) {
        return { pagesBefore: 0, pagesAfter: 0, skippedSchemaGuard: true };
      }
      const before = readFirstNumber(db, 'PRAGMA page_count');
      db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(maxPages))});`);
      const after = readFirstNumber(db, 'PRAGMA page_count');
      return { pagesBefore: before, pagesAfter: after, skippedSchemaGuard: false };
    } finally {
      db.close();
    }
  }

  function status(): MaintenanceStatus {
    const db = new DatabaseSync(options.databasePath, { readOnly: true });
    try {
      return {
        framesWithTreeJson: readFirstNumber(
          db,
          `SELECT COUNT(*) FROM frames
           WHERE accessibility_tree_json IS NOT NULL
             AND accessibility_tree_json != ''`
        ),
        danglingRefs: readFirstNumber(
          db,
          `SELECT COUNT(*) FROM frames f
           WHERE f.elements_ref_frame_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM elements e WHERE e.frame_id = f.elements_ref_frame_id
             )`
        ),
        pageCount: readFirstNumber(db, 'PRAGMA page_count'),
        freelistCount: readFirstNumber(db, 'PRAGMA freelist_count'),
        autoVacuumMode: readFirstNumber(db, 'PRAGMA auto_vacuum')
      };
    } finally {
      db.close();
    }
  }

  return { sweepOnce, reclaimOnce, status };
}
