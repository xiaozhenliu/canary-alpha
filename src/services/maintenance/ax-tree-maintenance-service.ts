import { DatabaseSync } from 'node:sqlite';

import { convertTreeJson } from './ax-tree-converter.js';

const DEFAULT_MIN_FRAME_AGE_MS = 15 * 60_000;
// Per-run sweep ceiling. Each captured frame can carry a ~1 MB accessibility
// tree JSON blob, and event-driven capture (one snapshot per keypress /
// visual change) can emit several hundred frames per 10-minute maintenance
// cycle. A batch of 100 could not keep up with that inflow, let alone drain a
// backlog, so tree JSON accumulated unbounded. 500 out-paces typical inflow
// and clears a multi-thousand-frame backlog within a few cycles.
const DEFAULT_BATCH_SIZE = 500;
// Per-run incremental_vacuum page ceiling (auto_vacuum=INCREMENTAL). 2_000
// pages (~8 MB) returned far too little to the OS to offset the space freed by
// nulling 1 MB blobs, so the file never shrank. 20_000 (~80 MB) steadily
// returns the slowly-accumulating freelist surplus without holding the write
// lock long enough to starve the live recorder.
const DEFAULT_RECLAIM_MAX_PAGES = 20_000;

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
  skippedBusy: boolean;
}

export interface MaintenanceStatus {
  framesWithTreeJson: number;
  /** Ref-linked AX backlog that still has tree JSON to repair, not a count of historical stale refs. */
  danglingRefs: number;
  pageCount: number;
  freelistCount: number;
  autoVacuumMode: number;
  skippedSchemaGuard: boolean;
}

export interface MaintenanceServiceOptions {
  databasePath: string;
  minFrameAgeMs?: number;
  batchSize?: number;
  now?: () => Date;
  logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => void };
  beforeConvertTxn?: () => void;
  busyTimeoutMs?: number;
}

interface CandidateRow {
  id: number;
  tree: string;
  ref: number | null;
}

interface TableColumn {
  name: string;
  type: string;
  pk: number;
}

type SchemaCompatibility = 'compatible' | 'drift' | 'busy';

function checkSchemaCompatibility(db: DatabaseSync): SchemaCompatibility {
  try {
    const frameInfo = db.prepare('PRAGMA table_info(frames)').all() as unknown as TableColumn[];
    const elementInfo = db.prepare('PRAGMA table_info(elements)').all() as unknown as TableColumn[];
    const frameCols = new Set(frameInfo.map((col) => col.name));
    const elementCols = new Set(elementInfo.map((col) => col.name));
    const elementId = elementInfo.find((col) => col.name === 'id');
    const compatible =
      ['id', 'accessibility_tree_json', 'elements_ref_frame_id', 'timestamp'].every((col) => frameCols.has(col)) &&
      elementId !== undefined &&
      elementId.pk > 0 &&
      /\bINTEGER\b/i.test(elementId.type) &&
      [
        'frame_id',
        'source',
        'role',
        'text',
        'parent_id',
        'depth',
        'left_bound',
        'top_bound',
        'width_bound',
        'height_bound',
        'sort_order',
        'properties',
        'on_screen'
      ].every((col) => elementCols.has(col));
    return compatible ? 'compatible' : 'drift';
  } catch (error) {
    return isSqliteBusy(error) ? 'busy' : 'drift';
  }
}

function hasElementsForFrame(db: DatabaseSync, frameId: number, ref: number | null): boolean {
  const targetFrameId = ref ?? frameId;
  return (
    db
      .prepare("SELECT 1 AS one FROM elements WHERE frame_id = ? AND source = 'accessibility' LIMIT 1")
      .get(targetFrameId) !== undefined
  );
}

function readFirstNumber(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return Number(Object.values(row ?? { value: 0 })[0]);
}

function isSqliteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked/i.test(message);
}

function safeReadFirstNumber(db: DatabaseSync, sql: string): number {
  try {
    return readFirstNumber(db, sql);
  } catch {
    return 0;
  }
}

export function createAxTreeMaintenanceService(options: MaintenanceServiceOptions) {
  const minAge = options.minFrameAgeMs ?? DEFAULT_MIN_FRAME_AGE_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
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
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))};`);
      const schemaStatus = checkSchemaCompatibility(db);
      if (schemaStatus !== 'compatible') {
        result.skippedSchemaGuard = true;
        options.logger?.warn?.(
          schemaStatus === 'busy'
            ? 'maintenance sweep skipped: database is busy'
            : 'maintenance sweep skipped: schema drift detected'
        );
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

        let transactionStarted = false;
        try {
          db.exec('BEGIN IMMEDIATE');
          transactionStarted = true;
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
          if (transactionStarted) {
            db.exec('ROLLBACK');
          }
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
    const maxPages = opts.maxPages ?? DEFAULT_RECLAIM_MAX_PAGES;
    const db = new DatabaseSync(options.databasePath);
    let before = 0;
    try {
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))};`);
      const schemaStatus = checkSchemaCompatibility(db);
      if (schemaStatus === 'busy') {
        options.logger?.warn?.('maintenance reclaim skipped: database is busy');
        return { pagesBefore: 0, pagesAfter: 0, skippedSchemaGuard: false, skippedBusy: true };
      }
      if (schemaStatus === 'drift') {
        return { pagesBefore: 0, pagesAfter: 0, skippedSchemaGuard: true, skippedBusy: false };
      }
      try {
        before = readFirstNumber(db, 'PRAGMA page_count');
        db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(maxPages))});`);
        const after = readFirstNumber(db, 'PRAGMA page_count');
        return { pagesBefore: before, pagesAfter: after, skippedSchemaGuard: false, skippedBusy: false };
      } catch (error) {
        if (!isSqliteBusy(error)) {
          throw error;
        }
        options.logger?.warn?.('maintenance reclaim skipped: database is busy', {
          message: error instanceof Error ? error.message : String(error)
        });
        return { pagesBefore: before, pagesAfter: before, skippedSchemaGuard: false, skippedBusy: true };
      }
    } finally {
      db.close();
    }
  }

  function status(): MaintenanceStatus {
    const db = new DatabaseSync(options.databasePath, { readOnly: true });
    try {
      if (checkSchemaCompatibility(db) !== 'compatible') {
        return {
          framesWithTreeJson: 0,
          danglingRefs: 0,
          pageCount: safeReadFirstNumber(db, 'PRAGMA page_count'),
          freelistCount: safeReadFirstNumber(db, 'PRAGMA freelist_count'),
          autoVacuumMode: safeReadFirstNumber(db, 'PRAGMA auto_vacuum'),
          skippedSchemaGuard: true
        };
      }
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
             AND f.accessibility_tree_json IS NOT NULL
             AND f.accessibility_tree_json != ''
             AND NOT EXISTS (
               SELECT 1 FROM elements e
               WHERE e.frame_id = f.elements_ref_frame_id
                 AND e.source = 'accessibility'
             )`
        ),
        pageCount: readFirstNumber(db, 'PRAGMA page_count'),
        freelistCount: readFirstNumber(db, 'PRAGMA freelist_count'),
        autoVacuumMode: readFirstNumber(db, 'PRAGMA auto_vacuum'),
        skippedSchemaGuard: false
      };
    } finally {
      db.close();
    }
  }

  return { sweepOnce, reclaimOnce, status };
}
