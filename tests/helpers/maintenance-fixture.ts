import { DatabaseSync } from 'node:sqlite';

/**
 * Minimal schema subset of the screenpipe db touched by maintenance tests.
 * Fixtures must stay synthetic: real accessibility trees can contain private screen content.
 */
export function createFixtureDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TIMESTAMP NOT NULL,
      app_name TEXT,
      window_name TEXT,
      accessibility_tree_json TEXT,
      elements_ref_frame_id INTEGER,
      snapshot_path TEXT,
      content_hash INTEGER
    );
    CREATE TABLE elements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      frame_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT,
      parent_id INTEGER,
      depth INTEGER NOT NULL DEFAULT 0,
      left_bound REAL,
      top_bound REAL,
      width_bound REAL,
      height_bound REAL,
      confidence REAL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      properties TEXT,
      on_screen INTEGER
    );
    CREATE INDEX idx_elements_frame_id ON elements(frame_id);
  `);
  return db;
}

export function addSpeakerEmbeddingsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE speaker_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      embedding FLOAT[512] NOT NULL
        CHECK (typeof(embedding) == 'blob' AND vec_length(embedding) == 512)
    );
  `);
}

export interface SyntheticNode {
  role: string;
  text?: string;
  depth: number;
  bounds?: { left: number; top: number; width: number; height: number };
  on_screen?: boolean;
  role_description?: string;
  is_enabled?: boolean;
  is_focused?: boolean;
  is_selected?: boolean;
  is_expanded?: boolean;
}

export function syntheticTree(): SyntheticNode[] {
  return [
    { role: 'AXWindow', text: 'Demo Window', depth: 0, on_screen: true },
    {
      role: 'AXHeading',
      text: 'Section A',
      depth: 1,
      on_screen: true,
      bounds: { left: 0.1, top: 0.1, width: 0.5, height: 0.05 },
      role_description: 'heading',
      is_enabled: true,
      is_focused: false
    },
    {
      role: 'AXStaticText',
      text: 'hello',
      depth: 2,
      on_screen: true,
      bounds: { left: 0.1, top: 0.2, width: 0.2, height: 0.03 }
    },
    {
      role: 'AXButton',
      text: 'OK',
      depth: 2,
      on_screen: true,
      role_description: 'button',
      is_enabled: true,
      is_selected: false
    },
    { role: 'AXLink', text: 'More', depth: 1, role_description: 'link' }
  ];
}

export function insertFrame(
  db: DatabaseSync,
  opts: {
    timestamp: string;
    treeJson?: string | null;
    elementsRefFrameId?: number | null;
    snapshotPath?: string | null;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO frames (timestamp, accessibility_tree_json, elements_ref_frame_id, snapshot_path)
       VALUES (?, ?, ?, ?)`
    )
    .run(opts.timestamp, opts.treeJson ?? null, opts.elementsRefFrameId ?? null, opts.snapshotPath ?? null);
  return Number(result.lastInsertRowid);
}

export function insertWorkerElement(db: DatabaseSync, frameId: number, text: string): void {
  db.prepare(
    `INSERT INTO elements (frame_id, source, role, text, depth, sort_order)
     VALUES (?, 'accessibility', 'AXStaticText', ?, 0, 0)`
  ).run(frameId, text);
}

export function isoMinutesAgo(minutes: number, now: Date = new Date()): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}
