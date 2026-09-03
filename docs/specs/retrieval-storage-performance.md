---
doc_version: 6
doc_status: deprecated
last_updated: 2026-06-22
---

# Spec: Retrieval & Storage Performance Overhaul

> **状态：已完成（2026-06-15）。** 本 spec 范围内的 BUG-004 Problems 1/2/4/5（时间戳标准化、向量存储 SQLite 增量迁移、读路径索引化、相关收敛）已随 `feat(perf): retrieval & storage performance overhaul (BUG-004)`（commit `cb321c1`）交付。Problem 3（关键词 FTS）按本 spec 设计**明确 deferred**，作为 BUG-004 报告中的已知问题保留，不在本 spec 完成判定内。frontmatter 此前误留为 `active`，于 2026-06-22 收口为 `deprecated`。

## Background & Motivation

BUG-004 (`docs/engineering/bug-reports/BUG-004-retrieval-storage-performance-degradation.md`) documents five interrelated performance problems in the retrieval and storage subsystems. These problems compound each other and degrade all three work-activity MCP tools (`find`, `recall`, `inspect`) as data volume grows.

The overarching goal is: **all time-windowed queries on derived storage must be index-served, and vector storage must support incremental writes instead of full-file rewrites.**

This spec is scoped exclusively to Direction 1 (retrieval & storage performance). It does not cover LLM interface unification or knowledge-layer architecture (deferred directions).

### Scope relative to BUG-004

BUG-004 identifies five problems. This spec addresses four of them (Problems 1, 2, 4, 5). **Problem 3 (no FTS for keyword mode) is explicitly deferred** — it requires evaluating FTS5 tokenization for CJK content, which is a separate effort with its own trade-offs. The bug report retains Problem 3 as a documented known issue; this spec does not claim to resolve it. Once Phase 0 restores index-served time filtering, the keyword path's main bottleneck shifts from "every page is a full table scan" to "JS-side string matching," which is adequate for the current data scale.

## Constraints

- No new external dependencies (no Chroma, Pinecone, etc.) — stay within Node.js built-ins + existing deps.
- Single-writer invariant on derived storage must be preserved.
- All existing MCP tool contracts (input/output schemas) remain unchanged.
- Privacy controls (exclude-app, pause, delete-range, cascade-delete) must continue to work correctly.
- Existing test suites must pass after migration (with necessary test updates for the new storage format).

## Phase 0: Timestamp Normalization (prerequisite for all subsequent work)

### Goal

Eliminate all `datetime()` SQL wrapping on derived database queries by ensuring every timestamp written to derived storage is canonical UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`).

### Scope

#### 0.1 Normalization utility

Create a single `normalizeToUtc(timestamp: string): string` function in `src/lib/time.ts`:
- Input: ISO-8601 string with explicit offset (e.g. `+08:00`, `Z`, `-05:00`)
- Output: UTC `Z`-suffix string, preserving millisecond precision
- Implementation: `new Date(timestamp).toISOString()` (leverages V8's ISO-8601 parser which handles all offset formats)
- **Offset-less input handling**: Timestamps without an offset (e.g. `2026-06-15T10:30:00.000`) are ambiguous — JS `Date` interprets them as local time, which would produce different UTC values on machines in different timezones. `normalizeToUtc` must **reject** offset-less input by checking for `Z`, `+`, or `-` after the time portion before calling `new Date()`. Throw a descriptive error: `"Timestamp lacks timezone offset: ${timestamp}"`. In practice, Screenpipe always provides offset timestamps, so this is a defense against future provider changes.
- If `Date.parse` returns `NaN` after the offset check passes, throw: `"Invalid timestamp: ${timestamp}"`.

#### 0.2 Write-path normalization

Apply `normalizeToUtc` at every write site that stores timestamps from upstream capture records:

| Write site | Column(s) | Current source |
|---|---|---|
| `extracted-content-store.ts` upsert | `frame_timestamp` | `ExtractionResult.frameTimestamp` |
| `session-store.ts` insert (new session) | `started_at`, `ended_at` | `extraction.frameTimestamp` |
| `session-store.ts` update (extend session) | `ended_at` | `extraction.frameTimestamp` |
| `vector-store.ts` upsert | `record.timestamp` | `ExtractionResult.frameTimestamp` |
| `embedding-service.ts` toRecord | `metadata.frameTimestamp` | `ExtractionResult.frameTimestamp` |

The normalization should be applied in the `toExtractionInput` function in `indexing-service.ts` (line 235) — normalize `record.timestamp` before it enters the extraction pipeline. This way all downstream consumers (extraction store, session aggregator, embedding service) receive pre-normalized timestamps without each needing to call `normalizeToUtc` independently.

Additionally, `SessionAggregator.handleExtraction` should normalize `extraction.frameTimestamp` before using it as `started_at` / `ended_at` values, as a defense-in-depth measure.

#### 0.3 Existing data migration

Add a one-time migration function `migrateDerivedSchemaV1(db)` called after `initDerivedSchema`.

**Migration approach**: SQL-based LIKE patterns cannot reliably distinguish timezone offset hyphens from date hyphens (e.g. `LIKE '%-%:%'` matches all ISO-8601 strings). Instead, the migration runs in TypeScript: read all rows, apply `normalizeToUtc()` to each timestamp, and batch-update only the rows whose value changed. This reuses the same normalization function that the write path uses, guaranteeing identical semantics and rejecting any offset-less or unparseable values.

```typescript
function migrateDerivedSchemaV1(db: DerivedDatabase): void {
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version >= 1) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    // Migrate extracted_content.frame_timestamp
    const ecRows = db.prepare(
      `SELECT frame_id, frame_timestamp FROM extracted_content WHERE frame_timestamp NOT LIKE '%Z'`
    ).all() as Array<{ frame_id: number; frame_timestamp: string }>;
    const ecUpdate = db.prepare('UPDATE extracted_content SET frame_timestamp = ? WHERE frame_id = ?');
    for (const row of ecRows) {
      ecUpdate.run(normalizeToUtc(row.frame_timestamp), row.frame_id);
    }

    // Migrate sessions.started_at and ended_at
    const sessRows = db.prepare(
      `SELECT session_id, started_at, ended_at FROM sessions
       WHERE started_at NOT LIKE '%Z' OR ended_at NOT LIKE '%Z'`
    ).all() as Array<{ session_id: string; started_at: string; ended_at: string }>;
    const sessUpdate = db.prepare('UPDATE sessions SET started_at = ?, ended_at = ? WHERE session_id = ?');
    for (const row of sessRows) {
      sessUpdate.run(normalizeToUtc(row.started_at), normalizeToUtc(row.ended_at), row.session_id);
    }

    db.exec('PRAGMA user_version = 1');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

The `NOT LIKE '%Z'` pre-filter in SELECT is a coarse optimization to avoid loading already-normalized rows. The authoritative normalization logic lives in `normalizeToUtc()` — any row that passes the filter but is already valid UTC will be re-normalized to the same value (idempotent). Any row with an offset-less or unparseable timestamp will cause `normalizeToUtc()` to throw, rolling back the transaction and surfacing the bad data for investigation.

**Schema versioning**: Use SQLite `PRAGMA user_version`:
- On startup, read `PRAGMA user_version`
- If `user_version < 1`: run migration inside a transaction, then `PRAGMA user_version = 1`
- Subsequent startups skip the migration

#### 0.4 Remove `datetime()` wrapping from derived-database query sites

After migration, the `datetime()` calls in the 5 derived-database files revert to direct string comparison:

| Before | After |
|---|---|
| `datetime(frame_timestamp) BETWEEN datetime(?) AND datetime(?)` | `frame_timestamp BETWEEN ? AND ?` |
| `datetime(started_at) >= datetime(?)` | `started_at >= ?` |
| `datetime(started_at) <= datetime(?)` | `started_at <= ?` |

The `find-service.ts` pagination cursor comparison (line 758, already raw) becomes consistent with the window bound comparison — both are now raw string comparisons on normalized UTC strings.

**Files to modify** (derived-database sites only):
- `src/services/work-activity/find/find-service.ts`
- `src/services/work-activity/sessions/session-store.ts`
- `src/services/work-activity/extraction/extracted-content-store.ts`

**Files NOT modified** (upstream Screenpipe DB — timestamps outside our control):
- `src/services/capture/providers/screenpipe/trim-service.ts`
- `src/services/capture/providers/screenpipe/maintenance-adapter.ts`
- `src/services/privacy/privacy-control-service.ts`

#### 0.5 Vector store timestamps

`FileBackedVectorStore.filterRecords` uses `compareTimestamps()` (JS-side lexicographic with `Date.parse` fallback) for time filtering. After Phase 0, all new vector store records will have UTC timestamps. Existing in-memory records are already loaded; they will be normalized during the Phase 1 JSON→SQLite migration (see 1.3). No code change needed in `compareTimestamps` for the transition period — it already handles mixed formats via `Date.parse` fallback.

### Acceptance criteria

- `datetime()` calls removed from all derived-database query sites (3 files: find-service, session-store, extracted-content-store)
- `datetime()` calls retained in Screenpipe-database sites (3 files: trim-service, maintenance-adapter, privacy-control-service)
- Contract test: `EXPLAIN QUERY PLAN` for `find` keyword first-page query shows `SEARCH` using `idx_extracted_content_timestamp` (not `SCAN TABLE`)
- Contract test: `EXPLAIN QUERY PLAN` for `recall` session query shows `SEARCH` using `idx_sessions_started_at` (not `SCAN TABLE`)
- Migration test: insert rows with `+08:00` offset, run migration, verify `frame_timestamp` ends with `Z` and represents the same instant
- Migration test: insert rows already ending in `Z`, run migration, verify values unchanged
- All existing test suites pass
- `PRAGMA user_version` reads `1` after successful migration

## Phase 1: Vector Store Migration to SQLite

### Goal

Replace `vector-store.json` with a `vectors` table in `derived.sqlite`, eliminating full-file I/O and enabling incremental writes and SQL-served time/app filtering.

### Scope

#### 1.1 Schema

Add to derived schema DDL (gated by `user_version < 2`):

```sql
CREATE TABLE IF NOT EXISTS vectors (
  id              TEXT PRIMARY KEY,
  text            TEXT NOT NULL,
  timestamp       TEXT NOT NULL,
  app_name        TEXT,
  window_name     TEXT,
  embedding       BLOB NOT NULL,
  source_types    TEXT NOT NULL,
  metadata        TEXT
);

CREATE INDEX IF NOT EXISTS idx_vectors_ts_id ON vectors(timestamp, id);
CREATE INDEX IF NOT EXISTS idx_vectors_app_ts_id ON vectors(app_name, timestamp, id);
```

**Index design** (addressing covering index requirement): The primary use case is `SELECT id FROM vectors WHERE timestamp BETWEEN ? AND ?` for the two-phase query in 1.2. Since `id` is `TEXT PRIMARY KEY` (not the SQLite rowid), a plain `(timestamp)` index would still require table lookups to retrieve `id`. The composite indexes `(timestamp, id)` and `(app_name, timestamp, id)` are **covering** for the filter-only phase — SQLite can satisfy the query entirely from the index without touching the main table pages (and critically, without reading BLOB data).

Embedding storage: `Float32Array` serialized as raw binary `BLOB` (not JSON). This reduces storage by ~4× compared to JSON number arrays and eliminates parse overhead.

`metadata` remains a JSON `TEXT` column for extensibility (frameId, captureId, extractedTextHash, etc.).

#### 1.2 `SqliteVectorStore` implementation

New class `SqliteVectorStore` in `src/services/retrieval/sqlite-vector-store.ts` implementing the existing `VectorStore` interface. The class receives the shared `DerivedDatabase` handle via constructor injection.

- **`upsert(records)`**: `INSERT OR REPLACE` in batches of 500 (matching existing `MAX_BIND_PARAMS`). Embedding serialized via `embeddingToBlob()` (see 1.5).
- **`query(request)`**: Two-phase query with **separate SQL for app-filtered vs non-app-filtered** (required for covering index usage — SQLite cannot use `idx_vectors_app_ts_id` when the `app_name` predicate is `IS NULL`):
  1. **Filter phase** (index-served, no BLOB read) — returns **all** candidate IDs within the time/app window, not a pre-truncated subset. No `LIMIT` in this phase: every record matching the time/app filter is a candidate for scoring. This preserves the current semantic contract where all records in the window compete on similarity score.
     - Without appName: `SELECT id FROM vectors WHERE timestamp BETWEEN ? AND ?` — uses covering index `idx_vectors_ts_id`.
     - With appName: `SELECT id FROM vectors WHERE app_name = ? AND timestamp BETWEEN ? AND ?` — uses covering index `idx_vectors_app_ts_id`.
  2. **Score phase**: Load embeddings for all candidate IDs in batched `SELECT id, embedding FROM vectors WHERE id IN (...)`, compute dot product in JS, sort by score descending, return top-K (respecting `request.limit` and the over-fetch multiplier from `findSemantic`).
  This replaces the current "load all records → filter in JS → score all" pattern with "filter in SQL (index-served) → load+score only matching records". The improvement is that records outside the time/app window are never loaded into memory — their BLOBs are never read. Within the window, all candidates are scored, preserving result quality.
- **`querySnapshot(request)`**: Same as `query` (the snapshot vs. live distinction was only meaningful for file-backed lazy loading).
- **`reset()`**: `DELETE FROM vectors`.
- **`inspect()`**: `SELECT COUNT(*) FROM vectors` + check table existence.
- **`listByTimeWindow(from, to)`**: `SELECT ... WHERE timestamp BETWEEN ? AND ?` — index-served.
- **`deleteByFrameIds(frameIds)`**: Must preserve the dual-key matching semantics from `FileBackedVectorStore` (TD-004 compatibility window). The stored record `id` is `extracted:${frameId}` (not the raw frame ID). Implementation:
  1. Build target IDs as `extracted:${frameId}` for each input frame ID.
  2. `DELETE FROM vectors WHERE id IN (...targetIds...)` — covers records written with the current `extracted:N` convention.
  3. For legacy records that may have been migrated from JSON with only `metadata.frameId`: `DELETE FROM vectors WHERE json_extract(metadata, '$.frameId') IN (...frameIds...) AND id NOT LIKE 'extracted:%'` — catches any edge-case records that don't follow the `extracted:N` convention.
  4. For captureId-keyed records: `DELETE FROM vectors WHERE json_extract(metadata, '$.captureId') LIKE ? AND id NOT LIKE 'extracted:%'` with pattern matching. This mirrors `parseCaptureId` logic in the current `deleteByFrameIds`.
  Returns the total number of deleted rows across all statements.
- **`deleteByTimestampRange(from, to)`**: `DELETE FROM vectors WHERE timestamp BETWEEN ? AND ?` — index-served. Also checks `json_extract(metadata, '$.frameTimestamp')` as fallback, mirroring current `FileBackedVectorStore` behavior.
- **`close()`**: No-op (SQLite handle lifecycle managed by `create-app.ts`).

#### 1.3 Data migration from JSON to SQLite

On startup, if `user_version < 2` and `vector-store.json` exists:

1. Parse the existing JSON file
2. **Normalize timestamps**: Apply `normalizeToUtc()` to each record's `timestamp` and `metadata.frameTimestamp` during migration. This ensures legacy vector records with `+08:00` timestamps are stored as UTC in the new SQLite table, consistent with Phase 0's derived-database normalization.
3. Batch-insert all records into the new `vectors` table (embeddings converted to Float32 BLOBs)
4. Set `user_version = 2`
5. Rename `vector-store.json` to `vector-store.json.migrated` (keep as backup, do not delete)

The migration runs once and is idempotent (checked by `user_version`).

#### 1.4 Factory and bootstrap wiring update

Current state in `create-app.ts`: `createVectorStore(config)` is called at line 191, before `derivedDb` is opened. The new `SqliteVectorStore` needs the `DerivedDatabase` handle.

Required changes:
1. Move `createVectorStore` call to after `openDerivedDatabase` + `initDerivedSchema`.
2. Change `createVectorStore(config)` signature to `createVectorStore(config, db: DerivedDatabase)`.
3. Return `SqliteVectorStore` as the default.
4. The `vectorStore.kind` config field (currently decorative, defaulting to `'chroma'`) must handle backward compatibility: existing configs may contain `kind: 'chroma'`. The factory treats any value other than `'file'` as `'sqlite'` (the new default). Only `kind: 'file'` explicitly opts into the legacy `FileBackedVectorStore`. Update the schema default from `'chroma'` to `'sqlite'`.

**rebuild-index impact**: The current `rebuild-index` path in `src/index.ts` (lines 583–680) creates a temporary `vector-store.json` in a rebuild directory, replays the full backlog into it, then atomically swaps it into the production location. With `SqliteVectorStore`, this flow must change because the one-time JSON→SQLite migration (1.3) is gated by `user_version < 2` — once the database is at version 2, a later rebuild-index JSON artifact would never be imported.

The rebuild-index path must be updated to work directly with `SqliteVectorStore`:

1. `rebuild-index` calls `createApp(...)` which now returns a `SqliteVectorStore` backed by the production `derived.sqlite`.
2. `vectorStore.reset()` clears the `vectors` table (equivalent to the current `vector-store.json` reset).
3. The backlog replay loop calls `indexing.runOnce()` as before — each cycle upserts into the `vectors` table via `SqliteVectorStore.upsert()`.
4. No temp file swap is needed for the vector store — writes go directly to `derived.sqlite`. The checkpoint file swap remains unchanged.
5. The existing `replaceRecoveryArtifact` calls for `vector-store.json` are removed (or become no-ops when the file does not exist).

This is simpler than the current flow (no temp directory, no atomic file swap for vectors) because SQLite transactions provide the atomicity guarantee. The `ensureRecoveryTargetIsOffline` check still prevents concurrent writers.

The rebuild-index path should also skip the JSON→SQLite migration check (it operates directly on `SqliteVectorStore`), so there is no dependency on the one-time migration gate.

#### 1.5 Embedding binary format and BLOB alignment

`Float32Array` is chosen over `Float64Array` because:
- Halves storage (4 bytes/dim vs 8 bytes/dim): 768-dim × 4 bytes = 3,072 bytes per record
- Dot product precision at float32 is sufficient for ranking (no model outputs more than float32 precision)
- 20K records × 3 KB = ~60 MB in SQLite vs ~360 MB in JSON

**BLOB alignment handling**: The `node:sqlite` driver may return `Uint8Array` BLOBs with non-4-byte-aligned `byteOffset` (documented in `hash-index.ts:140–170`). The same `blobToEmbedding` pattern from `src/services/work-activity/hash-index.ts` must be reused:

```typescript
// Extract from hash-index.ts and export as a shared utility in src/lib/blob.ts
export function blobToFloat32Array(blob: Uint8Array): number[] {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(`BLOB length ${blob.byteLength} is not a multiple of 4`);
  }
  const length = blob.byteLength / 4;
  if (blob.byteOffset % 4 === 0) {
    return Array.from(new Float32Array(blob.buffer, blob.byteOffset, length));
  }
  // Misaligned: copy to fresh aligned buffer
  const aligned = new ArrayBuffer(blob.byteLength);
  new Uint8Array(aligned).set(blob);
  return Array.from(new Float32Array(aligned));
}

export function float32ArrayToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}
```

The existing `blobToEmbedding` in `hash-index.ts` should be refactored to call this shared utility, avoiding duplication.

### Acceptance criteria

- `vector-store.json` is no longer written in production mode (verified: no file creation after startup with `kind: 'sqlite'`)
- Upsert of 50 records does not trigger a full-table rewrite (verified: no JSON serialization; SQLite WAL log shows incremental writes)
- `query()` filter phase uses covering index in both branches (verified: `EXPLAIN QUERY PLAN` shows `SEARCH vectors USING COVERING INDEX idx_vectors_ts_id` for non-app query AND `SEARCH vectors USING COVERING INDEX idx_vectors_app_ts_id` for app-filtered query)
- `query()` with a 1-hour time window on 20K records only loads embeddings for records within the window (verified: row count assertion in test)
- `deleteByFrameIds()` correctly deletes records by `extracted:N` id convention AND by legacy `metadata.frameId` AND by `metadata.captureId` (verified: cascade-delete integration test)
- `deleteByTimestampRange()` does not touch records outside the range (verified: row count assertion)
- JSON→SQLite migration: records are losslessly migrated (verified: embedding dot product against known vectors matches pre-migration values within Float32 tolerance)
- JSON→SQLite migration: legacy `+08:00` timestamps in vector records are normalized to UTC during migration
- `vector-store.json.migrated` backup file exists after migration
- `rebuild-index` works directly with `SqliteVectorStore` (reset → replay → no temp file swap needed for vectors; checkpoint swap unchanged)
- All existing vector-store and cascade-delete tests pass with `SqliteVectorStore`

## Phase 2: Read-Path Optimizations (incremental, after Phase 0 and 1)

### 2.1 Recall time-block batch query

Replace the per-session `getByFrameIds` loop in `recall-service.ts` with a single batch query that fetches all frames for all sessions in one SQL call:

```typescript
// Before: N queries
for (const session of sessions) {
  const frames = await store.getByFrameIds(session.evidence_frame_ids);
}

// After: 1 query (chunked if > 500 IDs)
const allFrameIds = sessions.flatMap(s => s.evidence_frame_ids);
const allFrames = await store.getByFrameIds(allFrameIds);
const framesBySession = groupFramesBySession(sessions, allFrames);
```

The `getByFrameIds` implementation already handles batched `IN (...)` queries with chunking. The change is in the caller, not the store. The `groupFramesBySession` helper builds a `Map<sessionId, ExtractionResult[]>` by cross-referencing each session's `evidence_frame_ids` array with the flat result set.

### 2.2 Pretty-print removal (immediate, zero-risk)

Change `vector-store.ts:239` from:
```typescript
JSON.stringify({ records: this.records }, null, 2)
```
to:
```typescript
JSON.stringify({ records: this.records })
```

This is applicable to the file-backed store's remaining usage (tests, rebuild-index temp path). In production after Phase 1, the JSON path is no longer used for steady-state writes.

### Acceptance criteria

- Recall time-block query for 24-hour window with 100 sessions uses ≤ 2 SQL round-trips for frame data (1 chunked `getByFrameIds` call, not 100 individual calls) — verified by spy/mock on store method
- Pretty-print removal: `FileBackedVectorStore.persist()` output does not contain `\n  ` (indentation) — verified by reading the file in test

## Implementation Order & Dependencies

```
Phase 0 (prerequisite)
  ├── 0.1 normalizeToUtc utility + offset-less rejection
  ├── 0.2 Write-path normalization (depends on 0.1)
  ├── 0.3 Data migration script + PRAGMA user_version (depends on 0.1)
  ├── 0.4 Remove datetime() wrapping on derived DB (depends on 0.3)
  └── 0.5 (no change — vector store benefits passively from 0.2)

Phase 1 (after Phase 0 merged)
  ├── 1.1 Schema DDL with covering indexes
  ├── 1.2 SqliteVectorStore implementation + shared BLOB utility (depends on 1.1)
  ├── 1.3 JSON→SQLite migration with timestamp normalization (depends on 1.2)
  ├── 1.4 Factory + bootstrap wiring + rebuild-index compatibility (depends on 1.2)
  └── 1.5 Binary embedding format (part of 1.2)

Phase 2 (after Phase 1 merged, can be individual commits)
  ├── 2.1 Recall batch query (independent)
  └── 2.2 Pretty-print removal (independent, can ship anytime)
```

Phase 0 and Phase 1 should be separate PRs. Phase 2 items can be individual commits.

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Data migration corrupts timestamps | Low | Positive-match guard (`LIKE '%+%'`); `PRAGMA user_version` prevents re-run; dedicated migration test with `+08:00`, `Z`, and edge-case inputs |
| Offset-less timestamps in future providers | Low | `normalizeToUtc` rejects offset-less input with descriptive error; Screenpipe always provides offsets |
| Float32 precision loss in embeddings | Negligible | Models output float32 natively; dot product ranking is order-preserving at float32 |
| BLOB alignment issue on `node:sqlite` | Known | Reuse proven `blobToEmbedding` pattern from `hash-index.ts`; shared utility with alignment guard |
| Regression in privacy cascade-delete | Medium | `deleteByFrameIds` preserves dual-key matching (id convention + metadata.frameId + metadata.captureId); cascade-delete integration tests updated |
| `vectorStore.kind: 'chroma'` in existing configs | Medium | Factory treats any non-`'file'` value as `'sqlite'`; no user-visible breakage |
| `rebuild-index` incompatibility | Low | rebuild-index updated to use `SqliteVectorStore` directly (reset + replay); no temp JSON file; dedicated rebuild-index test verifies end-to-end |
| `vector-store.json` backup file grows stale | Low | `.migrated` suffix signals one-time backup; can be manually deleted |

## Out of Scope

- Full-text search (FTS5) for keyword mode — BUG-004 Problem 3 is documented but deferred. Requires evaluating FTS5 CJK tokenization trade-offs. The keyword path's main bottleneck (full table scan per page) is resolved by Phase 0; JS-side matching remains adequate at current scale.
- HNSW or other ANN indexes for vector search — unnecessary at current data scale (< 100K records)
- LLM interface unification (deferred direction)
- Knowledge layer architecture (deferred direction)
- Screenpipe upstream database timestamp normalization (outside our control)
