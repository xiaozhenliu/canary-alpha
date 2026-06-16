import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  initDerivedSchema,
  getDerivedSchemaVersion
} from '../../src/services/work-activity/derived-database.js';

function createRawDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

describe('derived schema migration', () => {
  describe('V1 — timestamp normalization', () => {
    it('normalizes +08:00 timestamps in extracted_content to UTC', () => {
      const db = createRawDb();

      // Manually create the table without migration
      db.exec(`
        CREATE TABLE extracted_content (
          frame_id INTEGER PRIMARY KEY,
          frame_timestamp TEXT NOT NULL,
          app_name TEXT,
          context_label TEXT NOT NULL,
          context_key TEXT NOT NULL,
          extracted_text TEXT NOT NULL,
          extracted_text_hash TEXT,
          extraction_rule_kind TEXT NOT NULL,
          source_types TEXT NOT NULL,
          inserted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          app_name TEXT NOT NULL,
          context_key TEXT NOT NULL,
          context_label TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT NOT NULL,
          active_seconds INTEGER NOT NULL DEFAULT 0,
          source_types TEXT NOT NULL,
          evidence_frame_ids TEXT NOT NULL,
          is_open INTEGER NOT NULL DEFAULT 1,
          summary_text TEXT,
          summary_status TEXT,
          summary_provider_kind TEXT,
          summary_generated_at TEXT,
          embedding_id TEXT,
          closed_at TEXT
        );
        CREATE TABLE embedding_hash_index (
          extracted_text_hash TEXT PRIMARY KEY,
          embedding BLOB NOT NULL,
          inserted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);

      // Insert rows with +08:00 offset
      db.prepare(
        `INSERT INTO extracted_content (frame_id, frame_timestamp, context_label, context_key, extracted_text, extraction_rule_kind, source_types)
         VALUES (1, '2026-06-15T18:30:00.000+08:00', 'label', 'key', 'text', 'heuristic', '["ocr"]')`
      ).run();

      db.prepare(
        `INSERT INTO sessions (session_id, app_name, context_key, context_label, started_at, ended_at, source_types, evidence_frame_ids)
         VALUES ('s1', 'App', 'key', 'label', '2026-06-15T18:00:00.000+08:00', '2026-06-15T18:30:00.000+08:00', '["ocr"]', '[1]')`
      ).run();

      // Run initDerivedSchema which triggers migration
      initDerivedSchema(db);

      expect(getDerivedSchemaVersion(db)).toBe(1);

      const ecRow = db.prepare('SELECT frame_timestamp FROM extracted_content WHERE frame_id = 1').get() as { frame_timestamp: string };
      expect(ecRow.frame_timestamp).toBe('2026-06-15T10:30:00.000Z');

      const sessRow = db.prepare('SELECT started_at, ended_at FROM sessions WHERE session_id = ?').get('s1') as { started_at: string; ended_at: string };
      expect(sessRow.started_at).toBe('2026-06-15T10:00:00.000Z');
      expect(sessRow.ended_at).toBe('2026-06-15T10:30:00.000Z');
    });

    it('leaves already-normalized UTC timestamps unchanged', () => {
      const db = createRawDb();
      db.exec(`
        CREATE TABLE extracted_content (
          frame_id INTEGER PRIMARY KEY,
          frame_timestamp TEXT NOT NULL,
          app_name TEXT,
          context_label TEXT NOT NULL,
          context_key TEXT NOT NULL,
          extracted_text TEXT NOT NULL,
          extracted_text_hash TEXT,
          extraction_rule_kind TEXT NOT NULL,
          source_types TEXT NOT NULL,
          inserted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          app_name TEXT NOT NULL,
          context_key TEXT NOT NULL,
          context_label TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT NOT NULL,
          active_seconds INTEGER NOT NULL DEFAULT 0,
          source_types TEXT NOT NULL,
          evidence_frame_ids TEXT NOT NULL,
          is_open INTEGER NOT NULL DEFAULT 1,
          summary_text TEXT, summary_status TEXT, summary_provider_kind TEXT,
          summary_generated_at TEXT, embedding_id TEXT, closed_at TEXT
        );
        CREATE TABLE embedding_hash_index (
          extracted_text_hash TEXT PRIMARY KEY,
          embedding BLOB NOT NULL,
          inserted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);

      db.prepare(
        `INSERT INTO extracted_content (frame_id, frame_timestamp, context_label, context_key, extracted_text, extraction_rule_kind, source_types)
         VALUES (1, '2026-06-15T10:30:00.000Z', 'label', 'key', 'text', 'heuristic', '["ocr"]')`
      ).run();

      initDerivedSchema(db);

      const row = db.prepare('SELECT frame_timestamp FROM extracted_content WHERE frame_id = 1').get() as { frame_timestamp: string };
      expect(row.frame_timestamp).toBe('2026-06-15T10:30:00.000Z');
    });

    it('skips migration if user_version >= 1', () => {
      const db = createRawDb();
      db.exec('PRAGMA user_version = 1');
      initDerivedSchema(db);
      expect(getDerivedSchemaVersion(db)).toBe(1);
    });
  });

  describe('EXPLAIN QUERY PLAN — index usage', () => {
    it('find keyword first-page uses idx_extracted_content_timestamp', () => {
      const db = createRawDb();
      initDerivedSchema(db);

      const plan = db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT frame_id, frame_timestamp, app_name, context_label, extracted_text, source_types
         FROM extracted_content
         WHERE extracted_text != ''
           AND frame_timestamp BETWEEN ? AND ?
           AND (? IS NULL OR app_name = ?)
         ORDER BY frame_timestamp DESC, frame_id DESC
         LIMIT ?`
      ).all('2026-06-15T00:00:00.000Z', '2026-06-15T23:59:59.999Z', null, null, 20) as Array<{ detail: string }>;

      const planStr = plan.map(r => r.detail).join(' ');
      expect(planStr).toMatch(/SEARCH/i);
      expect(planStr).not.toMatch(/SCAN TABLE extracted_content(?!\s+USING)/i);
    });

    it('recall session query uses idx_sessions_started_at', () => {
      const db = createRawDb();
      initDerivedSchema(db);

      const plan = db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT session_id FROM sessions
         WHERE started_at >= ? AND started_at <= ?
         ORDER BY started_at DESC`
      ).all('2026-06-15T00:00:00.000Z', '2026-06-15T23:59:59.999Z') as Array<{ detail: string }>;

      const planStr = plan.map(r => r.detail).join(' ');
      expect(planStr).toMatch(/SEARCH|USING INDEX/i);
    });

    it('vectors time filter uses covering index idx_vectors_ts_id', () => {
      const db = createRawDb();
      initDerivedSchema(db);

      const plan = db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM vectors
         WHERE timestamp BETWEEN ? AND ?`
      ).all('2026-06-15T00:00:00.000Z', '2026-06-15T23:59:59.999Z') as Array<{ detail: string }>;

      const planStr = plan.map(r => r.detail).join(' ');
      expect(planStr).toMatch(/COVERING INDEX.*idx_vectors_ts_id/i);
    });

    it('vectors app+time filter uses covering index idx_vectors_app_ts_id', () => {
      const db = createRawDb();
      initDerivedSchema(db);

      const plan = db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM vectors
         WHERE app_name = ? AND timestamp BETWEEN ? AND ?`
      ).all('TestApp', '2026-06-15T00:00:00.000Z', '2026-06-15T23:59:59.999Z') as Array<{ detail: string }>;

      const planStr = plan.map(r => r.detail).join(' ');
      expect(planStr).toMatch(/COVERING INDEX.*idx_vectors_app_ts_id/i);
    });
  });
});
