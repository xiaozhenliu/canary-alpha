# Changelog

## [Unreleased]

### Added

- **`find` MCP tool** (`src/mcp/tools/find.ts`) — keyword-, semantic-, and hybrid-mode retrieval over the derived `extracted_content` table and the embedding hash index. Supports optional `appName` filter, ISO-8601 `from` / `to` window, `limit` (≤100), and optional `groupBy: 'session'`. Always emits `narrativeText` in the structured payload, and surfaces fallback paths through an explicit `degraded` block.
- **`recall` MCP tool** (`src/mcp/tools/recall.ts`) — open-session aggregation for a `from` / `to` window. `granularity="session"` returns per-session items (`sessionId`, `appName`, `contextLabel`, `startedAt`, `endedAt`, `activeSeconds`, `evidenceFrameIds`, `sourceTypes`, optional `summary`); `hour` / `day` returns time-bucketed `blocks` (`start`, `end`, `sessionCount`, `totalActiveSeconds`, `byApp`, `narrativeText`). `includeSummary` defaults to `true`.
- **`inspect` MCP tool** (`src/mcp/tools/inspect.ts`) — per-session and per-frame evidence drill-down. `target.sessionId` returns the session row plus its evidence; `target.frameId` returns the raw `accessibilityTreeJson` plus the derived `extractedContent` row (or `null` when extraction has not run for that frame).
- **Derived database** (`derived.sqlite`) under `paths.derivedDatabase` (defaults next to the existing app-home store) with the `extracted_content`, `sessions`, and `embedding_hash_index` tables, owned by `src/services/work-activity/derived-database.ts`.
- **Session aggregator** (`src/services/work-activity/sessions/`) with idle-threshold flushing tied to `analysis.sessions.idleThresholdSeconds`.
- **Summary worker** (`src/services/work-activity/summary/`) with both `template` and `remote-llm` providers; the `remote-llm` provider talks to any DeepSeek-compatible chat-completion endpoint configured under `llm.{base_url, api_key, model}`.
- **Embedding service with hash-index dedupe** (`src/services/work-activity/embedding-service.ts` + `src/services/work-activity/hash-index.ts`) so identical extractions share embedding rows instead of paying the provider twice.
- **Cascade delete coordinator** (`src/services/work-activity/cascade-delete-coordinator.ts`) unifying retention deletes and `privacy-control delete-range` against the derived store, including transactional `sessions` + `extracted_content` removal and post-commit vector-store cleanup.
- **Work-activity observability** surfaced via `internal-status`'s `workActivity` block (session counts, summary worker state, embedding hash index size) and via `IngestionObservabilityService`.
- **Config block `analysis.{sessions, summary, embeddings}`** plus optional `paths.derivedDatabase` and `llm.{base_url, api_key, model}` for the `remote-llm` provider. All new fields ship with defaults; existing configs continue to load unchanged.
- **Privacy cascade-failure tombstone**: `privacy_control` now persists a `cascade-failure` suppressed range when `delete-range` succeeds upstream but the derived-data cascade fails. `find` and `recall` filter out evidence/sessions whose timestamps fall inside an active tombstone until reconciliation clears it.
- **`reconcileCascadeFailures()` entry point** on `DefaultPrivacyControlService` retries unresolved cascade-failure ranges and marks each row `resolvedAt` on success.
- **`getPackageVersion()` helper** in `src/lib/version.ts` (and a sibling JS mirror in `scripts/version.js`) reading the runtime version from `package.json`. Used by `createMcpServer`, the `rebuild-index` MCP client, and the `service:start` / `service:status` / `onboard` / `privacy-control` scripts.
- **`deleteDerivedByFrameIds()`** transactional helper in `derived-database.ts` runs the `sessions` and `extracted_content` deletes inside a single `BEGIN IMMEDIATE` / `COMMIT`, preventing orphan rows on mid-cascade failure.
- **Targeted unit and integration tests** (21 new suites) covering: version helper, `last_1h` boundary correctness, custom-range SQL injection safety, retention id-set determinism under tied timestamps, cascade-failure tombstone propagation, find/recall suppression filtering, cascade transactional rollback, and retention cascade tombstone wiring.

### Changed

- **DeepSeek-only LLM defaults**: `DEFAULT_LLM_MODEL` is now `deepseek-chat`; `config.yaml.example` and `tests/evaluations/work-activity/README.md` document `https://api.deepseek.com` + `${DEEPSEEK_API_KEY}`. The hosted-embeddings onboarding default base URL switched to `https://api.deepseek.com` so no `api.openai.com` literal remains in `src/`, `scripts/`, or `tests/evaluations/`.
- **Privacy `delete-range` upstream deletion** now uses `node:sqlite` with prepared statements and `WHERE datetime(timestamp) >= datetime(?)`, replacing the previous `sqlite3` CLI subprocess and string-interpolated SQL. Custom-range strings can no longer smuggle SQL.
- **Privacy result envelope** now carries a structured `cascade: { upstreamDeleted, cascade: 'ok'|'partial'|'failed', failedFrameIds?, reason? }` block so callers can distinguish a successful upstream delete from a partially failed cascade.
- **Cascade-delete coordinator** runs both derived-table deletes in one transaction and only invokes the vector-store delete after the SQL transaction commits.
- **Retention pass** (`runRetentionIfOverBudget`) now SELECTs candidate frame ids via `WHERE datetime(timestamp) < datetime(?)` and DELETEs by an exact parameterised `id IN (?, ?, ...) RETURNING id` list inside a single transaction, so the cascade coordinator and the tombstone writer receive the precise set of ids actually removed (verified by SQLite's `RETURNING` clause) even under tied timestamps and concurrent-writer races. The retention pass also moved off the `sqlite3` CLI subprocess to `node:sqlite`.
- **Onboarding first-run validation** (`scripts/onboard.js`) now probes the live MCP service through `internal-status`, `recall` (last 10 minutes, sessions, no summaries), and `find` (keyword `screenpipe`, 10-minute window) instead of the removed `recent-activity` / `search-screen` tools.
- **Tool manifest** (`src/mcp/tool-manifest.ts`) replaces the `retrieval` tools with the new `work-activity` category covering `find`, `recall`, and `inspect`.

### Removed

- **`search-screen` MCP tool** and `SearchScreenService` (`src/services/retrieval/search-screen-service.ts`). The replacement is `find` with `mode="keyword"` (or `semantic` / `hybrid`).
- **`recent-activity` MCP tool** and `RecentActivityService` (`src/services/retrieval/recent-activity-service.ts`). The replacement is `recall` over a `from` / `to` window.
- Companion test files anchored on the removed tools (`tests/acceptance/http-tool-flow.test.ts`, `tests/acceptance/http-smoke.test.ts`, `tests/acceptance/mcp-smoke.test.ts`, `tests/acceptance/retrieval-core.test.ts`, `tests/acceptance/degraded-retrieval.test.ts`, `tests/integration/retrieval/recent-activity.test.ts`, `tests/integration/retrieval/search-screen.test.ts`, `tests/integration/retrieval/degraded-behavior.test.ts`).

### Fixed

- **P0 — Privacy delete-range correctness**: timestamp comparison no longer relies on lexicographic string ordering; `+HH:MM`-offset and pre-1970 timestamps now compare correctly via `datetime()` coercion. Range strings are bound parameters, not interpolated.
- **P0 — Cascade silent swallow**: cascade failure is no longer hidden behind `.catch(() => null)`; failures are logged, surfaced through the result envelope, and persisted so retrieval tools hide the affected window until reconciliation. The retention pass (`runRetentionIfOverBudget`) follows the same discipline — cascade failures during retention now write a `cascade-failure` tombstone via the wired `PrivacyStore` and log at `warn` level instead of being silently swallowed.
- **P1 — DeepSeek-only steering compliance** (`api.openai.com` / `OPENAI_API_KEY` / `gpt-4o-mini` removed from `src/`, `scripts/`, `config.yaml.example`, `tests/evaluations/`).
- **P1 — Hardcoded `'0.1.0'`** runtime version replaced with `getPackageVersion()` reading `package.json` everywhere it surfaces (`createMcpServer`, `rebuild-index` client, `service:start` / `service:status` / `onboard` / `privacy-control` scripts, plus the test client helper).
- **P1 — Cascade not transactional**: `sessions` + `extracted_content` deletes share a single `BEGIN IMMEDIATE` / `COMMIT` so a mid-cascade failure cannot leave one table half-cleaned.
- **P2 — Retention id drift under tied timestamps**: deterministic `IN (?, ?, ...)` delete keyed by the same id set the SELECT returned, so `cascadeByFrameIds()` sees the exact set actually removed. Retention timestamp predicate also switched to `datetime(timestamp) < datetime(?)` to avoid the same lexicographic pitfall.

## [1.1.0] - 2026-05-26

### Added

- **AX primary retrieval path**: `buildSearchUrl` now uses `content_type=accessibility` as the primary path, with `content_type=ocr` as fallback, fixing the PRD §7.3 main path that was never implemented (#accessibility-capture-ingestion spec)
- **Dual-query merge**: `HttpScreenpipeClient.search()` and `recent()` now issue parallel AX + OCR requests and merge results via `mergeByFrameId` (AX wins on shared `frame_id`)
- **`sourceTypes` field**: every `RetrievalEvidenceItem` and `ScreenpipeRecord` now carries a `sourceTypes: string[]` field indicating capture source (`["accessibility"]` or `["ocr"]`)
- **`windowName` and `frameId` fields**: added to `ScreenpipeRecord` and `RetrievalEvidenceItem` for cross-source deduplication and Noise_Window filtering
- **Secure_AX_Field subtree filtering**: `stripSecureAxSubtrees` in `IndexingService` removes `kAXSecureTextFieldRole` nodes and their descendants before embedding
- **Noise_Window post-filter**: `filterNoiseWindows` in `SearchScreenService` and `RecentActivityService` removes Control Center / Notification Center records from evidence
- **Retention pass**: `runRetentionIfOverBudget` in `Trim_Service` deletes oldest rows when `db.sqlite` exceeds `storage.diskBudgetBytes`
- **`IngestionObservabilityService`**: new service computing capture liveness state, ingestion source mix (AX/OCR ratio), and disk budget snapshot
- **`internal-status` new blocks**: `capture`, `ingestionMix`, `diskBudget` added to `internal-status` tool output schema (existing `screenpipeStorage` paths unchanged)
- **New config fields** (all with defaults, backward-compatible):
  - `capture.livenessThresholdSeconds` (default: 120)
  - `capture.permissionsGracePeriodSeconds` (default: 60)
  - `storage.diskBudgetBytes` (default: null)
  - `storage.retentionDays` (default: 7)
  - `privacy.secureAxRoles` (default: `["AXSecureTextField"]`)
- **`eval:coverage` npm script**: `npm run eval:coverage` runs the Coverage_Evaluation_Scenario against fixed fixtures; exits 0 when `effectiveCoverage >= 0.80`
- **`fast-check`** added to `devDependencies` for property-based testing
- **Troubleshooting docs**: `docs/troubleshooting.md` now lists five capture/ingestion failure modes with corresponding `internal-status` field names

### Changed

- `screenpipe-stub` test helper now filters by `content_type` query parameter (backward-compatible: records with empty `sourceTypes` are returned for any content type)
- `VectorStoreRecord.metadata` now includes `sourceTypes`, `windowName`, and `frameId` for observability aggregation
- `BootstrapStatusService.getStatus()` now calls `IngestionObservabilityService.collect()` and merges the three new blocks into the response
