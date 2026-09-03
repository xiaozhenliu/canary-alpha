---
doc_version: 34
doc_status: active
last_updated: 2026-09-04
---

# Changelog

All notable user-facing changes to `computer-history-mcp` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Version numbers follow [Semantic Versioning](https://semver.org/).

## Unreleased

## [2.8.0](docs/releases/v2.8.0.md) — 2026-09-04

### Added
- Automatic migration from `~/.canary-alpha-mcp` to `~/.computer-history-mcp` with a recoverable backup when only the legacy app home exists.
- Filtered public release flow driven by `scripts/public-release-manifest.txt`, replacing the unsafe `dev` merge publish path.
- Local clean-root public history rewrite candidate generator (`scripts/prepare-public-history-rewrite.sh`).
- Configurable Screenpipe executable and data directory (`screenpipe.binaryPath`, `screenpipe.dataDirectory`) so stable and development recorder builds can coexist without replacing the global command or sharing a mutable capture database.
- **Universal AXTree Structured Extraction Engine** (`UniversalStructuredExtractor`): Replaces generic single-node heuristic with full-window 4-domain semantic tagging (`[Window]`, `[Nav]`, `[Action]`, `[Body]`), capturing active chat partners/topics, IDE file paths & tabs, popover menus, and modal dialogs while gracefully degrading for shallow/GPUI trees.
- **Session Label Enrichment** (`deriveEnrichedWindowTitle`): Automatically incorporates top navigation contexts into coarse window titles (e.g. WeChat, Slack, Discord) for precise session grouping and naming.
- **Session-Scoped Line-Level Delta Deduplication** (`LineDeltaDeduplicator`): Deduplicates structured lines within active session contexts, emitting 0 bytes on identical frames and only incremental delta lines on changes, with automatic reset across idle thresholds.

### Changed
- Project identity, public GitHub repository, documentation site base, repository links, and launchd plist template now use `computer-history-mcp`.
- Public repository default branch rewritten to a clean-root filtered snapshot, preventing development-only files from being reachable in public history.
- Managed service scripts stop and remove the legacy `com.canary-alpha-mcp` launchd label before installing the renamed service.
- Project license changed from Apache-2.0 to MIT.
- Installation documentation now pins the tested MIT release `screenpipe@0.3.282` and warns against substituting the unvalidated, differently licensed latest release.
- README positioning now describes the project as a local computer-history and persistent agent-memory layer and clarifies how it differs from and complements Codex Computer Use.

### Improved
- Documentation site content now reflects the current `npm start` and `npm run refresh:hermes` lifecycle, the full ten-tool Hermes onboarding allowlist, configurable Chinese-first OCR, custom Screenpipe paths, Routines v2 behavior, and Universal AXTree semantic extraction with session-scoped delta deduplication. English and Simplified Chinese pages are synchronized.
- Universal AXTree indexing now carries the complete per-frame tree from the capture provider when the search response omits it, reconstructing sweep-normalized `elements` rows through `elements_ref_frame_id` when needed; it restores deduplication state for open sessions after restart and guards retries against losing structured content after embedding failures.
- Complete AX trees are filtered for configured secure AX roles before extraction and embedding, including the restart path where uncheckpointed extraction rows are deliberately excluded from deduplication recovery.
- Empty AX payloads retain the existing OCR/text fallback, while semantic root nodes are included in structured extraction.
- Durable extraction rows preserve the original capture cursor so same-timestamp checkpoint retries remain ordered and lossless.
- Extracted keyword and semantic query pipelines from `find-service.ts` (1061→612 lines) into `keyword-queries.ts` and `semantic-queries.ts`; removed dead `FindModeNotImplementedError` class (GRO-171)
- Extracted shared suppression utility (`collectActiveCascadeFailureIntervals`) into `work-activity/suppression.ts`, breaking the false `recall → find` cross-module dependency (GRO-167, refactor series 1/4)
- Split `storage-diagnostics.ts` (1639 lines) into 7 domain sub-modules under `diagnostics/screenpipe/`, with 29 new parser unit tests (GRO-168, refactor series 2/4)
- Extracted `stripSecureAxSubtrees` and `hashStringToNumericId` from `indexing-service.ts` into dedicated modules (GRO-169, refactor series 3/4)

## 2.7.3 — 2026-06-22

### Added
- Configurable OCR recognition languages via `capture.ocrLanguages` (config CLI + schema). The recorder reads the configured language names and passes them to Screenpipe as repeated `screenpipe record --language <name>` flags, so Apple Vision can recognize Chinese (and other non-English scripts) instead of English-only. Defaults to `['english']` (existing behavior unchanged); set `[chinese, english]` to enable Chinese-primary capture. **Order is priority** — on macOS the first language becomes Apple Vision's primary OCR mode. Values are validated against an allowlist (a subset of Screenpipe's ~76 `Language` names); any invalid value makes the recorder fall back wholesale to English rather than passing an unknown language downstream. The dashboard displays the field read-only in this release. See [Configuration › capture](https://xiaozhenliu.github.io/computer-history-mcp/reference/configuration).

## 2.7.2 — 2026-06-22

### Added
- OCR engine comparison experiment (`experiments/ocr-compare/`) — compares macOS Vision, PP-OCRv6, PaddleOCR-VL-1.6, and Doubao 2.0 Pro on Zed GPUI screenshots, with Qwen 3.7 Plus as independent judge. Final results: Doubao 10/10, Vision 2-3/10, PP-OCRv6 0.5/10, PaddleOCR-VL 1/10. Conclusion: single-pass local OCR cannot read GPUI-rendered content; only cloud multimodal LLMs do well.
- Local two-stage OCR pipeline (`experiments/ocr-compare/local/`) — ONNX PP-DocLayoutV2 layout split → MLX-quantized PaddleOCR-VL-1.5 per-block greedy recognition → reuse of the shared `axtree` assembler, emitting the same `screen→panel→region` tree and Custom OCR contract (`{text, structured_data, confidence}`) as the Baidu path. Registered as `OCR_ENGINE=local` in `ocr_server.py`. Benchmarked on three Zed GPUI screenshots against the Baidu cloud anchor with a two-way blind Qwen judge: local vs Baidu = 6/7, 7/5, 8/6 (local wins 2 of 3). Greedy decoding is deterministic (K=3 → `distinct_text_hashes == 1`), 0 degraded crops, ~1.95 GiB peak RSS / ~1.17 GiB model resident footprint (fits 16 GB Macs), recognition ~44–47 s/image (≈106 sequential per-block MLX calls dominate). **This qualifies the prior "all local OCR fails" conclusion: a two-stage layout-split + per-block VL pipeline matches the cloud anchor on quality locally; latency is the only blocker to real-time integration.** Each module is independently runnable; see `experiments/ocr-compare/local/RESULTS.md`.

## 2.7.1

### Improved
- Rewrote MCP tool descriptions for `memory-read`, `memory-write`, `file-analyze`, `privacy-control`, `screenpipe-control`, and `internal-status` to include data boundaries, key parameters, and usage guidance
- Expanded onboarding tool whitelist from 7 to 10 tools — added `inspect`, `routine-list`, `routine-history`
- `npm run refresh:hermes` now syncs `tools.include` in Hermes config with the current whitelist

### Fixed
- `internal-status` outputSchema missing `recentHeavyGrowth` field in `screenpipeStorage` — caused schema validation warnings in strict MCP clients
- `screenpipe-control` missing from `tool-manifest.ts` registry (11 vs 12 tool count mismatch)

### Documentation
- Added tool whitelist explanation to Hermes client guide (EN + ZH)
- Added "Onboarding" column to MCP tools reference table (EN + ZH)
- Added exclusion rationale comments to `hermes-tool-includes.js`

## [2.7.0] — 2026-06-16

### Added

- **Routines v2 — Prompt-Driven LLM Execution**: Routine prompts now drive actual
  content retrieval and LLM analysis. The executor retrieves relevant screen evidence
  via `FindService` (keyword search) and activity overview via `RecallService` in
  parallel, deduplicates and truncates evidence, redacts secrets, and calls the
  configured LLM endpoint to produce tailored briefings. When no LLM is configured,
  the executor falls back to deterministic template formatting.
- **Shared LlmClient module** (`src/services/llm/llm-client.ts`): Extracted generic
  OpenAI-compatible `chat/completions` HTTP wrapper with structured error codes
  (`NOT_CONFIGURED`, `TIMEOUT`, `PROVIDER_UNAVAILABLE`, `PARSE_FAILED`),
  `AbortController` timeout, and API-key redaction. Both `RemoteLlmSummaryProvider`
  and `PromptDrivenExecutor` consume this module.
- **Schedule-aware `recentActivityMinutes` inference**: When `recentActivityMinutes`
  is omitted from `routine-create`, the tool infers a look-back window from the cron
  schedule (hourly→60, daily→1440, weekly→10080, monthly→43200). Explicit values
  always override inference.
- **Privacy guard for routine execution**: When privacy pause is active, the executor
  does not send screen evidence to external endpoints and falls back to template
  formatting.

### Changed

- **`RoutineKind` removed**: The `kind: 'daily_summary'` type constraint and field
  are removed from `RoutineDefinition`, tool schemas, and all output. Existing
  persisted definitions containing `kind` are tolerated on read (field is silently
  discarded).
- **`RemoteLlmSummaryProvider` refactored**: HTTP transport, timeout, and error
  mapping delegated to shared `LlmClient`. Domain-specific payload construction
  (system/user messages, token cap) remains in the provider.

### Fixed

- `routine-create` input schema: `recentActivityMinutes` changed from
  `.default(60)` to `.optional()` so omission vs explicit `60` is distinguishable.

### Added

- Added `npm run resume`, an idempotent no-build startup path that checks the
  managed MCP service and Screenpipe in parallel, reuses healthy components,
  starts only missing components, and waits for both to become ready.
- Added `npm start` as the single state-aware user entry point. It automatically
  chooses first-time onboarding, one-time build recovery, or the fast resume
  path, so users and agents no longer need to diagnose local startup state. An
  explicit completion marker distinguishes a setup-created config from completed
  onboarding, with compatibility detection for existing launchd installations.
- Added `npm run refresh:hermes` as the source-update entry point. It rebuilds
  current source, reinstalls and restarts the managed MCP service, restores the
  shared Screenpipe stack, and requires a real Hermes `internal-status` tool
  call before reporting success.

### Performance

- **Retrieval & storage performance overhaul** (BUG-004): All time-windowed queries
  on derived storage are now index-served. Timestamps in `extracted_content` and
  `sessions` tables are normalized to canonical UTC (`Z`-suffix) on write and
  migrated once on startup (`PRAGMA user_version = 1`), eliminating the
  `datetime()` SQL wrapping that defeated B-tree indexes on every read path.
- **Vector store migrated from JSON to SQLite**: `vector-store.json` is replaced
  by a `vectors` table in `derived.sqlite` with covering indexes
  `(timestamp, id)` and `(app_name, timestamp, id)`. Embeddings are stored as
  raw `Float32Array` BLOBs (4× smaller than JSON). Two-phase query: filter phase
  uses covering index (no BLOB read), score phase loads only matching embeddings.
  One-time JSON→SQLite migration runs automatically; the original file is renamed
  to `vector-store.json.migrated` as backup.
- **Recall batch frame query**: The per-session `getByFrameIds` loop in
  `recall-service.ts` is replaced with a single batch call, reducing SQL
  round-trips from N to 1 for time-block granularity.
- `FileBackedVectorStore.persist()` no longer pretty-prints JSON (removes
  indentation overhead from the legacy code path).
- `rebuild-index` simplified: operates directly on `SqliteVectorStore`
  (reset + replay), eliminating the temp-directory / atomic-file-swap dance.

### Changed

- Default `vectorStore.kind` changed from `'chroma'` to `'sqlite'`. Existing
  configs with `kind: 'chroma'` are treated as `'sqlite'` (any non-`'file'`
  value maps to the SQLite backend). Use `kind: 'file'` to opt into the legacy
  `FileBackedVectorStore` JSON path.
- Shared BLOB alignment utility (`src/lib/blob.ts`) extracted from
  `hash-index.ts` — reused by both the embedding hash cache and the new
  `SqliteVectorStore`.

### Security

- Dashboard `GET /api/config/effective` and `GET /api/config` no longer accept
  `?reveal=true` — bulk secret reveal is removed. Use the new
  `GET /api/config/get?path=<field>&reveal=true` endpoint to reveal a single
  named field at a time, limiting the blast radius if the authToken is
  compromised (GRO-162).

### Fixed

- Concurrent Dashboard API requests to config write endpoints (`set`, `unset`,
  `add`, `remove`) no longer lose updates. A process-internal promise-queue
  mutex in `ConfigCliService` serializes all read-modify-write cycles, ensuring
  every write is applied to the latest on-disk state (GRO-164).
- Concurrent indexing no longer permanently skips frames whose embedding
  failed when a later frame succeeded. The checkpoint advancement logic now
  computes a failure ceiling (the earliest failed record) and refuses to advance
  past it, ensuring every failed frame is retried on the next tick (GRO-163).
- Dashboard `GET /api/logs` no longer reads the entire log file into memory.
  A bounded backward tail reader (10 MiB cap) replaces the previous
  `readFile` + `split('\n')` pattern, eliminating OOM risk on large production
  log files (GRO-161).

### Added

- `privacy-control` tool now supports `remove-excluded-app` action to remove an
  app from the exclusion list. Uses the same case-insensitive matching as
  `exclude-app`. Returns `PRIVACY_APP_NOT_EXCLUDED` error when the app is not
  in the list, and `PRIVACY_APP_NAME_REQUIRED` when no app name is provided.
  The `scripts/privacy-control.js` CLI also exposes the new action via
  `npm run privacy-control -- remove-excluded-app --app <name>` (GRO-165).
- New Dashboard API endpoint `GET /api/config/get?path=<field>[&reveal=true]`
  returns a single config field value (masked by default, revealed only when
  `reveal=true` is explicitly requested). The field path must be a valid leaf
  path in the config schema; object paths are rejected with 400 (GRO-162).
- Dashboard reference documentation (`docs/reference/dashboard.md`) covering
  access, authentication, all six page modules, REST API endpoints, and the
  relationship between dashboard, CLI, and MCP tools. Available in English and
  Simplified Chinese on the documentation site.

### Changed

- `privacy-control` tool structured output now includes `deletedFrames`,
  `deletedElements`, `deletedExtractedContent`, `deletedSessions`,
  `deletedEmbeddings`, and `cascade` fields when a `delete-range` action
  completes, giving callers visibility into the full upstream + cascade outcome.

### Tests

- Restored the `delete-range last_1h` acceptance test in
  `tests/acceptance/privacy-control.test.ts` (GRO-44). The test now exercises
  the full end-to-end path via real MCP stdio: startup catch-up indexing,
  confirmed `privacy-control delete-range last_1h`, cascade coordinator
  cleanup, and post-delete `find` verification. Frame ID alignment between the
  Screenpipe HTTP stub and the SQLite fixture is verified directly.
- Added HTTP runtime marker lifecycle acceptance test in
  `tests/acceptance/http-init.test.ts` (GRO-46). The test verifies that an HTTP
  server creates a runtime marker file in `~/.computer-history-mcp/runtime-processes/`
  on startup and removes it after SIGTERM shutdown, using an isolated temp HOME
  directory consistent with the existing stdio marker test pattern.

## [2.5.0] - 2026-06-15

### Added

- Dashboard Web UI: a browser-based management panel embedded in the existing
  HTTP server, accessible at `http://127.0.0.1:<port>/`.
  - **Status Dashboard**: real-time display of server, capture, retrieval,
    ingestion, disk budget, work activity, and providers status with auto-refresh
    and degraded-state indicators.
  - **Configuration Manager**: schema-driven form UI auto-generated from the Zod
    config schema. Supports editing scalar fields, viewing array fields, secret
    masking/reveal, and environment-variable override annotations.
  - **Routines Manager**: list, create, edit, enable/disable toggle, and view
    execution history for background routines with cron validation.
  - **Activity Browser**: time-range session timeline and keyword/semantic/hybrid
    search panel with result timestamps.
  - **Privacy Controls**: pause/resume collection, manage excluded apps (add-only;
    backend limitation documented), and delete data ranges with confirmation.
  - **Log Viewer**: structured JSON log display with level filtering.
  - **Token Gate**: auth token entry screen on first visit with 401 re-auth.
- Dashboard REST API (`/api/*`): 15 endpoints for status, config (effective
  values + schema + mutations), routines (CRUD + history), activity (sessions +
  search), privacy (status + actions), and logs.
- Shared Bearer token auth helper (`verifyBearerToken`) extracted from the
  HTTP transport for reuse by both `/mcp` and `/api/*` routes.
- API route registry pattern: `ApiRouter` with path-param matching, 1 MB body
  limit, and automatic 401/404/500 handling.
- SPA static file server with extension-aware fallback (HTML-only SPA routing;
  missing `.js`/`.css` assets correctly return 404).
- Zod 4 → JSON Schema converter (`schema-export.ts`) for dynamic form generation.
- Frontend: React 19 + Vite 6 + Tailwind CSS v4 SPA with module-registry
  architecture. Bundle size ~85 KB gzip (well under 150 KB target).
- Build integration: `npm run build` now produces both server TypeScript and
  dashboard frontend; `npm run typecheck:all` covers both.
- Dashboard unit tests (API router + schema export) and acceptance tests
  (HTTP integration with proper server cleanup).

### Changed

- `StartedHttpTransport` now includes a `server` reference for test cleanup.
- HTTP transport request handler restructured: `/mcp` → `/api/*` → SPA static →
  404 (previously non-`/mcp` paths returned 404 immediately).

## [2.4.0] - 2026-06-14

### Added

- Routines MVP: three new MCP tools for managing background automation workflows:
  - `routine-list` — list configured local routines with schedule, enabled state,
    prompt, recent-activity window, timestamps, and latest run summary.
  - `routine-create` — create or update a local routine by providing a name,
    prompt, and cron schedule.
  - `routine-history` — retrieve recent execution history for a named routine,
    returned newest-first with structured status and summary fields.
- Cron scheduler (`RoutineSchedulerService`): enabled routines execute in the
  background on their configured cron schedule; concurrent runs of the same
  routine are skipped (recorded as `skipped`) to prevent overlap.
- Built-in `daily_summary` routine: produces a deterministic activity report
  from recent screen-activity data without requiring a new LLM provider.
- Delivery documentation: `docs/delivery/routines.md` describing routine tools,
  config defaults (`routines.enabled`, `routines.storagePath`), storage paths,
  and MVP scope boundaries.

### Changed

- `captureFramesReader` replaces the previous internal alias `screenpipeFramesReader`
  in the retrieval service layer (TD-007). The rename aligns with the
  capture-provider abstraction; no observable behavior change.

### Fixed

- `AxTreeMaintenanceService` ported to use `CaptureMaintenancePort` internally
  (TD-005), removing the last direct Screenpipe service reference from the
  maintenance layer. No behavior change.

## [2.3.0] - 2026-06-14

### Added

- Concurrent embedding in the indexing pipeline: `runOnce()` now splits into
  serial extraction + concurrent embedding (sliding-window promise pool) +
  batch vector-store upsert. Controlled by `providers.embeddings.concurrency`
  (default 2). Significantly reduces catch-up time after prolonged offline
  periods.
- `EmbeddingService.computeEmbedding()` method for computing embeddings without
  vector-store persistence, enabling the concurrent pipeline.
- Startup priority catch-up: the first indexing poll runs up to 10 consecutive
  `runOnce()` rounds to aggressively clear any backlog before switching to the
  normal polling interval.

### Changed

- `maxCatchUpRecords` default raised from 500 to 1500 per batch, reducing the
  number of poll cycles needed to clear a large backlog.

### Fixed

- Removed the `stable-count` false-positive signal from the e2e
  `evaluateIndexReadiness` harness. The signal indicated "Screenpipe stopped
  producing frames" but did not confirm "MCP finished embedding those frames",
  causing premature readiness and `empty-recall` test failures.

## [2.2.0] - 2026-06-14

### Added

- Concurrent-connection cap for the HTTP transport (`server.maxConnections`,
  default 10). Returns `503 Service Unavailable` with `Retry-After: 1` when the
  cap is reached.
- Config file permission check on load: warns when the config file is
  group-readable or world-readable, since it may contain secrets.
- Audit logging for `screenpipe-control` tool `start`/`stop` actions at `warn`
  level, capturing action lifecycle and outcome.
- Pre-send secret redaction for remote-LLM evidence fragments. Common patterns
  (Bearer tokens, API keys for OpenAI/GitHub/AWS/Slack/Google) are replaced with
  `[REDACTED_*]` placeholders before the payload leaves the process.

### Changed

- HTTP auth token comparison now uses `crypto.timingSafeEqual` for
  constant-time comparison, preventing timing-based token guessing.
- HTTP 500 error responses no longer expose internal error messages to clients.
  Detailed errors are logged server-side; clients receive a generic
  `Internal server error` message.
- HTTP mode now logs a prominent warning at startup when no `authToken` is
  configured, explaining that all requests will be rejected with 401.
- The `memory-write` tool content field is now capped at 64 KB (`max(65536)`).

## [2.1.0] - 2026-06-14

### Added

- Background Screenpipe recorder so the launching terminal can be closed:
  `npm run recorder:start` / `recorder:stop` / `recorder:status` /
  `recorder:logs`, plus `npm run up -- --detach` to bring the stack up with the
  recorder detached. Output is written to
  `~/.computer-history-mcp/logs/recorder.log` and the PID to
  `~/.computer-history-mcp/recorder.pid`.
- `npm run down:all` for a one-command graceful teardown that stops the recorder
  (SIGTERM with a final maintenance pass) and then the managed MCP service.

### Changed

- `npm run up` is unchanged by default — the recorder still runs in the
  foreground unless `--detach` is passed.

## [2.0.2] - 2026-06-11

### Added

- English-first and Simplified Chinese project README files.
- Apache License 2.0.
- Community contribution guidelines, Contributor Covenant 2.1, a security
  policy, structured GitHub issue forms, and a pull-request template.
- Screenpipe safe-record maintenance run logging under
  `~/.computer-history-mcp/logs/screenpipe-maintenance.jsonl`, with 7-day pruning
  and 1 MB rotation.

### Changed

- Public release snapshots now exclude development-only planning artifacts.

## [2.0.1] - 2026-05-29

### Added

- `npm run hermes:verify` for real end-to-end Hermes validation against the
  local MCP service.
- A Hermes onboarding guide with actionable failure-mode reference.
- Shared Hermes CLI detection in setup, onboarding, smoke, evaluation, and
  verification flows.

### Changed

- Onboarding now recommends `npm run hermes:verify` as the canonical
  post-install Hermes smoke check.

### Fixed

- Updated Hermes configuration and evaluation helpers to use the registered
  `find` and `recall` MCP tools instead of retired tool names.
- Anchored Hermes evaluation fixtures to stable frame IDs and explicit time
  windows to prevent drift.

## [2.0.0] - 2026-05-27

### Added

- Work-activity MCP tools:
  - `find` for keyword, semantic, and hybrid retrieval.
  - `recall` for bounded session and time-block recall.
  - `inspect` for session and frame evidence drill-down.
- A local derived SQLite database for extracted content, sessions, and
  embedding hash-index records.
- Session aggregation, summary workers, embedding deduplication, and
  work-activity observability.
- Cascade deletion across Screenpipe data, derived data, and vector records.
- Configurable analysis, summary, embeddings, LLM, and derived-database
  settings with backward-compatible defaults.

### Changed

- Onboarding validation now exercises `internal-status`, `recall`, and `find`.
- Runtime version reporting now reads from `package.json`.
- Privacy deletion and retention use parameterized SQLite operations and
  deterministic frame ID sets.

### Removed

- Retired `search-screen` and `recent-activity`. Use `find` and `recall`
  instead.

### Fixed

- Corrected privacy range deletion for offset timestamps and pre-1970 data.
- Preserved privacy suppression when downstream cascade deletion fails.
- Made derived-data cascade deletion transactional.

## [1.1.0] - 2026-05-26

### Added

- Accessibility-first capture retrieval with OCR fallback and cross-source
  frame merging.
- Capture source metadata, secure accessibility-field filtering, noise-window
  filtering, retention controls, and storage diagnostics.
- Capture liveness, ingestion-mix, and disk-budget blocks in
  `internal-status`.
- Property-based and coverage-evaluation tests for retrieval, privacy, and
  retention behavior.

## [1.0.0] - 2026-05-02

### Added

- Initial public release of the local-first Screenpipe memory MCP server.
- stdio and loopback-only Streamable HTTP transports.
- Core memory, privacy, local file analysis, retrieval, diagnostics, setup,
  and managed-service workflows.
