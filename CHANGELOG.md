---
doc_version: 7
doc_status: active
last_updated: 2026-06-14
---

# Changelog

All notable user-facing changes to `canary-alpha-mcp` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
  `~/.canary-alpha-mcp/logs/recorder.log` and the PID to
  `~/.canary-alpha-mcp/recorder.pid`.
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
  `~/.canary-alpha-mcp/logs/screenpipe-maintenance.jsonl`, with 7-day pruning
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
