---
doc_version: 41
doc_status: active
last_updated: 2026-09-04
---

# Development Log

This log records maintainer-facing milestones for `computer-history-mcp`. It is a
compact narrative of important implementation decisions and verification
outcomes, not a duplicate of the Git commit history.

For user-visible release notes, read the [changelog](../CHANGELOG.md).

## 2026-09-04: Documentation Site Synchronization Published

**Result**

- Synchronized the English and Simplified Chinese documentation site with the state-aware `npm start` lifecycle, `npm run refresh:hermes`, all ten Hermes onboarding tools, Universal AXTree semantic tags and session-scoped delta deduplication, Routines v2, Chinese-priority OCR, and custom Screenpipe paths.
- Updated the Dashboard Routines form so an empty look-back field invokes server-side cron inference and listed routines show their prompt and resolved look-back window.
- Published filtered public release `89640aa4f55da08f322a411770a5e83aabc09d3e` from source `622777d5c845fcb06c8923ea71c1ba572293cdea`; the public tree matched the already deployed Pages tree, so its path-filtered workflow did not require a second run.
- Resolved BUG-006 after live English and Simplified Chinese smoke assertions confirmed the updated lifecycle, AXTree, and OCR content.

**Verification**

- `npm run docs:build`, `npm run typecheck:all`, `npm run build:dashboard`, and `npm run test:contract` passed.
- `npm run release:public:dry-run` validated the filtered candidate, fresh checkout, and Gitleaks allowlist; `npm run release:public` pushed the recorded candidate.
- Independent Codex review (`gpt-5.6-sol`, medium) findings were corrected before publication.

## 2026-09-04: Public Positioning, Screenpipe Prerequisite, and MIT License

**Result**

- Updated the English and Simplified Chinese project entry points to position `computer-history-mcp` as a local computer-history and persistent agent-memory layer, with a factual comparison to Codex Computer Use.
- Pinned installation guidance to the live-tested, MIT-licensed `screenpipe@0.3.282`; untested Screenpipe `0.4.15` development builds remain outside the public prerequisite.
- Changed the project license and package metadata from Apache-2.0 to MIT and synchronized the governed quickstart documentation.

**Verification**

- `npm run docs:build` and `git diff --check` passed.
- Independent Codex review (`gpt-5.6-sol`, medium) approved the scoped documentation and metadata changes with no blocking or substantive findings.

## 2026-09-03: Filtered Public History Rewrite Published

**Result**

- Published clean-root filtered snapshot candidate `87b292e05bfc027c7d0736032c8d965d45dbde68`
  (built from reviewed `dev` source `a8f68364dd8ed5fc394cde04d51d833e1dcc952d`) to remote
  `public/main` via lease `689a526f4634e3a100ffbcf3b3f235243c280474`.
- Verified clean-root commit graph, complete omission of non-allowlisted development and private paths
  (`.scratch/`, `.agents/`, `.kiro/`, etc.), full test suite (149 files / 1427 tests), and clean Gitleaks scan.
- Transitioned `docs/specs/project-rename-computer-history-mcp.md` to deprecated (completed).

## 2026-09-02: Project Rename + Filtered Public Release

**Result**

- Finished the local rename to `computer-history-mcp`, including app-home migration,
  legacy launchd teardown, config CLI migration, VitePress/Pages base, and repository links.
- Replaced the unsafe `git merge dev` publish path with a fail-closed filtered release that
  binds the source SHA to HEAD, requires an independent public manifest, and refuses local
  `public-main` parents that diverge from remote `public/main`.
- Generated a clean-root public history rewrite candidate and recorded remaining
  non-credential exposure for forks, clones, mirrors, and caches.

**Verification**

- `npm run typecheck`, full Vitest suite (148 files / 1426 tests), `npm run docs:build`,
  Gitleaks on the public candidate, `npm run release:public:dry-run`, and
  `scripts/prepare-public-history-rewrite.sh` all passed.
- Independent Codex review (`gpt-5.6-sol`, medium) found no blocking defects on the final
  local commit set; GitHub rename and remote push remain human-only.

## 2026-09-02: Versioned Screenpipe Runtime Selection

**Result**

- Added `screenpipe.binaryPath` and `screenpipe.dataDirectory` as the single runtime selection interface for recorder startup and every direct SQLite consumer.
- Removed recorder and onboarding dependence on `screenpipe@latest`; the default executable now resolves from PATH, while versioned development builds can use an explicit absolute path.
- Installed the locally built `0.4.15` ARM64 artifact beside the global `0.3.282` build without replacing it.

**Verification**

- Targeted configuration, recorder, onboarding, and control tests pass.
- Independent Codex review approved the runtime path propagation after its four findings were fixed.

## 2026-09-02: Universal AXTree Structured Extraction & Session-Scoped Delta Deduplication

**Result**

- Implemented `UniversalStructuredExtractor` (`universal.ts`): replaced generic single-node heuristic with full-window 4-domain semantic taxonomy (`[Window]`, `[Nav]`, `[Action]`, `[Body]`), capturing chat contacts/channels, IDE breadcrumbs & active tabs, menu popups, and modal dialogs while gracefully degrading for shallow/GPUI trees.
- Implemented `deriveEnrichedWindowTitle`: automatically enriches coarse window titles (WeChat, Slack, Discord, Untitled) with active top navigation context to ensure accurate session grouping and naming.
- Implemented `LineDeltaDeduplicator`: session-scoped line-level delta deduplication tracking multi-context active sessions (A -> B -> A) and resetting across idle timeouts, suppressing 100% redundant frames to 0 bytes while indexing only incremental changes.
- Wired `UniversalStructuredExtractor` as canonical production fallback in `ExtractionRegistry` and wired `LineDeltaDeduplicator` into `IndexingService` production pipeline.
- Wired the production indexer to recover complete AX trees through the capture provider's frame-detail port, including reconstruction from sweep-normalized `elements` rows, restore deduplication state from open sessions after restart, and commit preview state only after checkpoint persistence succeeds.
- Applied the configured secure AX-role filter to nested trees before extraction and kept uncheckpointed rows out of restart hydration so failed embeddings are retried with full context.
- Added regression coverage for provider retries, configured idle thresholds, frame-detail AX loading, navigation-noise filtering, invisible roots, cache eviction, and restart recovery.
- Preserved the original capture cursor in derived extraction rows and verified same-timestamp checkpoint recovery plus frame-local duplicate-line preservation.

**Verification**

- `npm run typecheck` 100% clean.
- `npm test` all 140 test files and 1394 tests pass cleanly.
- Codex review gate (gpt-5.6-sol, medium reasoning) passed with no P0/P1 findings; P2/P3 follow-ups are deferred by review policy.

## 2026-07-03: Refactor — Extract find-service Query Pipelines (GRO-171)

**Result**

- Extracted SQL keyword query pipeline (`collectKeywordMatches`, `fetchPage`,
  `normaliseForKeyword`, `RawExtractedContentRow`, `rowToEvidenceItem`,
  SQL constants) into `src/services/work-activity/find/keyword-queries.ts`
  (282 lines).
- Extracted semantic vector query pipeline (`executeSemanticQuery`,
  `extractFrameId`, `rowToSemanticEvidenceItem`) into
  `src/services/work-activity/find/semantic-queries.ts` (152 lines).
- `find-service.ts` reduced from 1061 to 612 lines; `findSemantic` and
  `findKeyword` methods retained as thin orchestration wrappers.
- Removed dead `FindModeNotImplementedError` class and its catch branch in
  the MCP tool handler (`find.ts`).
- `executeSemanticQuery` returns `null` (fallback to keyword needed) vs `[]`
  (semantic ran successfully, no matches) — preserving R7.6/R7.7 degradation
  semantics.

**Verification**

- `npm run typecheck` clean; 889 unit tests pass (2 new: vector-store query
  throw path for semantic and hybrid modes).
- Codex MCP review (gpt-5.5, xhigh): first round identified vector-store
  query throw coverage gap; second round confirmed all issues resolved.

## 2026-07-02: Refactor 3/4 — Extract indexing-service Pure Functions (GRO-169)

**Result**

- Moved `hashStringToNumericId` (FNV-1a 32-bit hash) to `src/lib/hash.ts` —
  generic utility with no indexing-service dependency.
- Moved `stripSecureAxSubtrees` (~120 lines, R4.4 privacy filter) to
  `src/services/retrieval/strip-secure-ax-subtrees.ts` — security-auditable
  as a standalone module.
- `indexing-service.ts` reduced by ~150 lines; no re-exports from old path.

**Verification**

- `npm run typecheck` clean; 888 unit tests pass; 54 integration tests pass.
- Codex MCP review (gpt-5.5, xhigh): no issues found.

## 2026-07-02: Refactor 2/4 — Split storage-diagnostics.ts (GRO-168)

**Result**

- Split `storage-diagnostics.ts` (1639 lines, largest file in repo) into 7
  domain sub-modules under `src/services/diagnostics/screenpipe/`:
  sqlite-cli, path-usage, hotspots, heavy-growth, duplication, capture-reuse,
  inspection. Original file retained as barrel + collection + formatting
  (376 lines).
- Consumer imports (privacy-control-service, bootstrap-status-service,
  scripts/storage-diagnostics.js) remain zero-change — all original exports
  preserved through barrel re-exports.
- Added 29 parser characterization unit tests covering all 14 parser pure
  functions. Test total: 859 → 888.

**Verification**

- `npm run typecheck` clean; 888 unit tests pass; integration test
  (storage-diagnostics.test.ts) passes.
- Codex MCP review (gpt-5.5, xhigh): no issues found.

## 2026-07-02: Refactor 1/4 — Extract Suppression Utility (GRO-167)

**Result**

- Moved `collectActiveCascadeFailureIntervals` from `find-service.ts` to a new
  shared module `src/services/work-activity/suppression.ts`. This breaks the
  false dependency `recall-service → find-service` — both are peer services that
  should not import from each other.
- Placement decision: the function uses duck typing (inline `{ from, to,
  reason?, resolvedAt? }`) rather than importing `PrivacySuppressedRange` from
  the privacy module, so it naturally sits at the `work-activity/` shared level
  where both consumers live.
- Two-commit split: (1) pure code move with re-export for `git diff
  --color-moved` verification; (2) import path updates removing the re-export.

**Verification**

- `npm run typecheck` clean; 859 unit tests pass (baseline unchanged); 55
  acceptance tests pass.
- `grep -rn "from '../find/find-service" src/services/work-activity/recall/`
  returns no results — the cross-module dependency is fully severed.
- Codex MCP review (gpt-5.5, xhigh): no issues found.

## 2026-06-22: Configurable OCR Recognition Languages

**Result**

- Added `capture.ocrLanguages` (default `['english']`) so the recorder can drive
  Screenpipe's per-language OCR. `scripts/screenpipe-safe-record.js` reads the
  config and emits repeated `--language <name>` flags; explicit `--language`/`-l`
  on the recorder CLI still wins.
- Default semantics are deliberately split: a *missing* field resolves to the
  schema default `['english']`, while an unreadable / corrupt / oversized config
  fail-opens to `[]` (no `--language` injected). This keeps the single source of
  truth on the TS side (`DEFAULT_OCR_LANGUAGES`, `ocrLanguageSchema` in
  `src/config/schema.ts`) with a synced copy in the pure-JS recorder script, since
  the script cannot import TS.
- Validation is whole-array fail-safe: any value outside the allowlist (a subset
  of Screenpipe's ~76 `Language` names) makes the recorder fall back to English
  and log a warning rather than forwarding an unknown language. The config CLI
  rejects invalid values before they reach disk via the existing schema re-validation.
- The capture type was tightened from `string[]` to `OcrLanguage[]` (derived from
  the schema enum), which surfaced — and required updating — ~12 inline `AppConfig`
  test fixtures.

**Verification**

- `npm run typecheck` clean; full `vitest run` green (1299 tests), including new
  pure-function arg-builder assertions (`toEqual` order), `readOcrLanguagesFromConfig`
  boundary cases (absent → english, invalid → english+warning, missing/corrupt/oversized
  → `[]`), a TS↔JS allowlist/default consistency test, and config-CLI enum rejection.
- The live end-to-end OCR-recall check (start recorder, confirm `--language` in
  `recorder.log`, observe Chinese OCR text in `~/.screenpipe/db.sqlite`) is a
  hardware/permission/time-dependent manual step left to the operator; the recorder
  wiring that produces the flags is covered by automated tests.

## 2026-06-21: Source Refresh and Hermes Verification Entry Point

**Result**

- Added `npm run refresh:hermes` for the post-source-change workflow.
- The command builds current source, force-restarts the managed MCP service,
  restores the shared Screenpipe stack, and runs the real Hermes verification
  gate in a fixed fail-fast order.
- Routed agents from `AGENTS.md` to the operations guide and added task-oriented
  discovery entries in the README and Hermes guides.

**Verification**

- Added unit coverage for orchestration order and failure short-circuiting.
- Verified the full test suite, typechecks, server build, and governed docs build.

## 2026-06-21: State-Aware Local Stack Startup

**Result**

- Added `npm start` as the only normal user startup path. It selects first-time
  onboarding, missing-build recovery, or fast resume from filesystem state.
- Kept `npm run onboard` and `npm run resume` as targeted advanced commands.
- Its resume path checks the managed MCP service and Screenpipe concurrently,
  reuses healthy components, starts only missing components, and performs no
  build.
- Successful onboarding writes an explicit completion marker. A config created
  by `npm run setup` remains an incomplete installation, while a legacy launchd
  service is accepted for backward compatibility.
- Screenpipe startup remains delegated to the detached recorder lifecycle, so
  PID tracking, logs, graceful shutdown, and final maintenance stay unchanged.

**Verification**

- Added unit coverage for all four healthy/missing component combinations and
  startup failure propagation.
- Verified the full test suite, typecheck, server build, and governed docs build.

## 2026-06-16: Routines v2 — Prompt-Driven LLM Execution (v2.7.0)

**Context**

Routines MVP (v2.4.0) delivered scheduling and persistence infrastructure but the
execution layer had a critical design flaw: the user's prompt was accepted but never
consumed. All routines were hardcoded to `kind: 'daily_summary'` and the sole executor
(`DailySummaryExecutor`) ignored `definition.prompt` entirely, producing identical
session-count output regardless of the prompt.

**Architecture Decisions**

- **Shared `LlmClient` extraction (ROUT-H01)**: Rather than duplicating HTTP transport
  logic, extracted a generic OpenAI-compatible `chat/completions` client into
  `src/services/llm/llm-client.ts`. Both `RemoteLlmSummaryProvider` (session summaries)
  and `PromptDrivenExecutor` (routine execution) consume this module. The client owns
  timeout management (`AbortController`), structured error codes, and response parsing.

- **Find + Recall + LLM approach (ROUT-E03)**: Chose the two-source retrieval strategy
  (keyword evidence via `FindService` + session overview via `RecallService`) over
  recall-only. The keyword path is index-served SQL with known performance
  characteristics; semantic retrieval was deferred due to brute-force dotProduct
  limitations on large time windows.

- **`RoutineKind` removal (ROUT-G02)**: Removed the type entirely rather than adding
  new enum members. The `kind` field was a premature abstraction — all routines now
  share the same prompt-driven executor. Persisted JSON files with `kind: 'daily_summary'`
  are tolerated on read (field silently discarded) for backward compatibility.

- **Schedule-aware inference (ROUT-G01)**: `recentActivityMinutes` changed from
  `.default(60)` to `.optional()` with heuristic inference from the cron expression.
  The heuristic maps to the coarsest matching granularity (weekly/monthly/daily/sub-daily)
  — conservative overestimates that always cover at least one full cycle.

**Key Implementation Details**

- **Privacy fail-closed (ROUT-GP02)**: Codex review identified that the initial
  implementation failed open when `privacyState.read()` threw — screen evidence would
  still be sent to the LLM. Fixed to assume paused (deny by default) on read failure.

- **Secret redaction scope (ROUT-GP01)**: Codex review identified that only
  `EvidenceItem.extractedText` was redacted but activity overview fields (`contextLabel`,
  `summary.text`) were sent raw. Fixed to apply `redactSecrets()` to all text included
  in the LLM prompt.

- **6-field cron handling**: `node-cron` accepts both 5-field and 6-field (seconds
  prefix) expressions. The schedule inference heuristic now normalises to 5-field
  before parsing, preventing misclassification of daily schedules as monthly.

- **Template fallback with data**: No-LLM installs now get session statistics and
  evidence snippets in the fallback output, preserving useful output without requiring
  an external endpoint.

**Verification**

- 1274 tests passing (34 new tests: 26 LlmClient + 8 PromptDrivenExecutor)
- Independent code review via Codex MCP: 1 critical, 3 major, 1 minor, 1 nit — all
  addressed before commit
- TypeScript strict mode: zero errors
- Backward compatibility: persisted definitions with `kind: 'daily_summary'` load
  without error (integration test)

**Files Changed**: 30 files (5 new, 25 modified), +2167 / -594 lines

## 2026-06-15: Dashboard Reference Documentation and Dead Link Fixes

**Context**

Dashboard Web UI shipped in v2.5.0 but had no user-facing reference documentation.
The only written material was the deprecated design spec (`docs/specs/dashboard-web-ui.md`)
and a one-liner in README. Operators had no way to learn about authentication,
page modules, or REST API endpoints without reading source code.

**Changes**

- Created `docs/reference/dashboard.md` (EN) and `docs/zh/reference/dashboard.md` (ZH)
  covering: access, authentication (fail-closed Bearer token), all six page modules
  (Status, Config, Routines, Activity, Privacy, Logs), REST API endpoint table,
  and the relationship between dashboard / CLI / MCP tools.
- Added Dashboard entries to VitePress sidebar config (EN + ZH), both README
  doc tables, and operations guide (tip block with link).
- Registered both documents in `docs/documentation/governed-documents.md`.
- Fixed VitePress build failures caused by dead links:
  - Added `specs/**` and `security/**` to `srcExclude` (internal-only docs were
    being processed as site pages).
  - Replaced `configuration.md` links to excluded `specs/future-backlog.md` with
    inline text (EN + ZH).

**Verification**

`npx vitepress build docs` passes with zero dead links and zero warnings.
Both dashboard pages render in the build output (`docs/.vitepress/dist/`).

## 2026-06-15: Batch Bug/Safety Backlog Clearance (GRO-43 ~ GRO-166)

This session processed all 10 remaining Backlog issues (GRO-43 through GRO-166)
in priority order (Safety first, then Bug, by ascending issue number). Seven
required code changes; three were verified as already resolved by prior commits.

### Verified as already resolved (no code change)

- **GRO-43** (Bug): Fix canonical app home path regressions after computer-history
  rename. Zero references to old `screenpipe-memory-mcp` path remain in
  `src/`, `tests/`, or `scripts/`. All 1188 tests pass. Fixed by the rename
  commit (`f69cab9`).
- **GRO-45** (Bug): Fix rebuild-index acceptance regressions. All 20
  rebuild-index acceptance tests pass: artifact recovery, summary values,
  checkpoint semantics, runtime marker guards, and managed service detection.
  Fixed by v2.3.0–v2.5.0 storage and routines refactoring.
- **GRO-166** (Bug): Routine name slug empty string file overwrite. All entry
  points already validate: `routine-create` MCP tool checks
  `if (!normalizedName)` and returns `isError`; Dashboard `POST /routines`
  returns 400 when `sluggedName === ''`; `FileRoutineStore.writeDefinition` and
  `appendRun` both throw on empty name. No additional guard needed.

### Issues with code changes (individual entries below)

- **GRO-44** (Bug+Safety): Restore delete-range last_1h acceptance test
- **GRO-46** (Bug+Safety): Add HTTP runtime marker lifecycle test
- **GRO-162** (Safety): Replace bulk config reveal with single-field API
- **GRO-161** (Bug): Bounded tail reader for Logs API
- **GRO-163** (Bug): Checkpoint failure ceiling to prevent frame skipping
- **GRO-164** (Bug): Config write mutex for Dashboard concurrency
- **GRO-165** (Bug): Add remove-excluded-app privacy action

## 2026-06-15: Add remove-excluded-app Action to Privacy Control (GRO-165)

**Problem**

`PrivacyAction` only had `exclude-app` (add to exclusion list) with no reverse
operation. Users who accidentally excluded an app could not undo it through the
privacy interface.

**Fix**

Added `remove-excluded-app` action across all four layers:

- `src/services/privacy/types.ts` — added to `PrivacyAction` union; added
  `PRIVACY_APP_NOT_EXCLUDED` to `PrivacyControlError.code`
- `src/services/privacy/privacy-control-service.ts` — new `removeExcludedApp()`
  private method using the same `normalizeAppName` (lowercase) comparison as
  `exclude-app`; returns `PRIVACY_APP_NOT_EXCLUDED` when app is not in list
- `src/mcp/tools/privacy-control.ts` — added to Zod enum
- `src/dashboard/routes/privacy.ts` — added to `VALID_ACTIONS` array
- `scripts/privacy-control.js` — added to `SUPPORTED_ACTIONS`, `usage()`,
  `parseArgs()` (accepts `--app`, no `--rebuild`), `toToolArguments()`, and
  `formatResult()`

**Verification**

All 4 service-level integration tests pass. New CLI integration test
`removes an excluded app via CLI` verifies the end-to-end round-trip:
exclude + remove, confirm state file has 0 entries. All 98 existing tests
remain green (integration/privacy + acceptance + contract).

## 2026-06-15: Config Write Mutex to Prevent Dashboard Lost Updates (GRO-164)

**Problem**

`ConfigCliService` methods `set`, `unset`, `addToArray`, and `removeFromArray`
each perform a read-modify-write cycle: `readDocument() → modify → write()`.
Two concurrent Dashboard API requests (e.g. two browser tabs calling
`PUT /api/config` simultaneously) could interleave these steps — request A
reads, request B reads, A writes, B writes — causing A's changes to be silently
overwritten.

**Fix**

Added a `Mutex` class (promise-based queue, ~20 lines) directly inside
`src/config/config-cli-service.ts`. A single `writeLock` instance is held per
`ConfigCliService` instance and wraps the read-modify-write cycle of `set`,
`unset`, and `mutateArray`. Pre-write validation (schema resolution, value
coercion) remains outside the lock since it is pure computation with no I/O.
Read-only methods (`get`, `list`, `validate`) are not locked.

The mutex is deadlock-free: the `finally(() => release())` path in `run()`
releases the lock on both success and any error or noop return. The queue
chains promise gates (not the user callback itself), so a rejected write does
not poison subsequent writes.

This fix is sufficient because the Dashboard runs in the same Node.js process
as the MCP server — the single-writer architecture (docs/architecture.md §8)
means cross-process locking is not required.

**Tests added**

- `tests/unit/config-cli-service.test.ts`: new test
  "serializes concurrent set operations without lost updates (GRO-164)" fires 5
  concurrent `set()` calls on distinct paths and asserts all values survive in
  the final persisted config.

**Codex review**

Passed. No blocking findings. Confirmed: all write paths wrapped, read-only
paths unlocked, mutex is deadlock-free.

## 2026-06-15: Prevent Checkpoint from Advancing Past Failed Frames (GRO-163)

**Problem**

In `src/services/retrieval/indexing-service.ts`, the checkpoint accumulation
loop advanced to the newest record with `advanceCheckpoint: true`, ignoring
any records with `advanceCheckpoint: false` (embedding failures). If record A
(older, T1) failed and record B (newer, T2) succeeded, checkpoint advanced to
T2, permanently skipping A. The same gap-skip existed in the
blocked-records re-check loop.

**Fix**

Collect all `(record, advanceCheckpoint)` pairs from both the concurrent embed
phase and the released-blocked serial phase into a single `checkpointCandidates`
array before computing `latestCheckpoint`. After all processing, derive the
failure ceiling — the earliest record (by `compareRecords()` ordering, which
uses cursor for same-timestamp tiebreaking) with `advanceCheckpoint: false`.
Then advance `latestCheckpoint` in a single forward pass, skipping any
candidate whose position compares `>= failureCeilingRecord`.

This design avoids rollback complexity: by collecting all results first and
deriving the ceiling before any checkpoint accumulation, released-blocked
failures lower the ceiling before it is ever applied.

**Tests updated**

- `tests/integration/indexing/concurrent-embedding.test.ts`: updated the
  "advances checkpoint past failure" test (which encoded old broken behavior)
  to assert the corrected invariant; added three new `checkpoint ceiling
  (GRO-163)` tests (mixed batch, all-success, all-failure).
- `tests/integration/indexing/indexing-service.test.ts`: updated
  "continues indexing later successful records" test to expect checkpoint at
  record-1 rather than record-3.

**Codex review**

Two Codex review passes were run. First pass flagged: (1) released-blocked
rollback omitted those records from recomputation, (2) `Date.parse` vs
`compareRecords` ordering inconsistency. The design was refactored to use
the collect-then-ceiling-then-advance pattern, eliminating both issues. Second
pass confirmed no remaining blocking findings.

## 2026-06-15: Replace Full-File Log Read with Bounded Tail Reader (GRO-161)

**Result**

- Replaced `readFile(logFilePath, 'utf8')` + `.split('\n')` in
  `src/dashboard/routes/logs.ts` with a new `readTailLines()` helper that
  reads backward in 64 KiB chunks, stopping once enough non-empty lines have
  been collected or the 10 MiB byte cap is reached.
- Buffer fragments are stored as `Buffer` objects and decoded once via
  `Buffer.concat().toString('utf8')` to prevent UTF-8 multi-byte corruption
  at chunk boundaries — a real bug identified in the first Codex review pass.
- `fh.read()` actual `bytesRead` is now used to slice the buffer, guarding
  against short reads (e.g. log rotation during stat→read).
- When `?level` filter is active, `FILTER_OVERSCAN_LINES` (10,000) lines are
  requested; the 10 MiB byte cap provides the hard bound in all cases.
- `total` in the response now reflects the window count rather than full-file
  count — an intentional tradeoff documented in both code and changelog; the
  old `total` required a full-file read to compute.
- Added `tests/unit/dashboard/logs-tail-reader.test.ts` (8 unit tests covering
  empty file, ENOENT, small file, large file tail, blank-line skipping, forward
  order, multi-chunk, no trailing newline).
- All existing tests pass: 41 total (acceptance + unit/dashboard).

**Decisions**

- Codex review (first pass) flagged blank lines counting toward the stop
  condition; fixed by counting only `trim() !== ''` lines in the early-exit check.
- Codex review (second pass) flagged UTF-8 boundary corruption and ignored
  `fh.read` actual bytes — both fixed. The `total` behavior change was flagged
  as blocking by Codex but is explicitly accepted per GRO-161 task spec.

## 2026-06-15: Replace Bulk Config Reveal with Single-Field API (GRO-162)

**Result**

- Removed `?reveal=true` support from `GET /api/config/effective` and
  `GET /api/config`. Both endpoints now always return masked secret values,
  ignoring any `reveal` query parameter.
- Added `GET /api/config/get?path=<field>[&reveal=true]` — a new single-field
  reveal endpoint that only exposes the specifically requested config field.
  The implementation delegates to `cliService.get(path, { reveal })`, which
  already existed and correctly handles secret masking via `isSecretPath` /
  `maskValue`. Invalid or parent-object paths are rejected with 400.
- Updated `dashboard/src/lib/schema-form/fields/StringField.tsx` to use the
  new endpoint: `onReveal` now calls `/config/get?path=<encodeURIComponent(path)>&reveal=true`
  and reads `res.display`, replacing the bulk `/config/effective?reveal=true` call.
- Added 6 new security regression tests to `tests/acceptance/dashboard-http.test.ts`
  covering: bulk reveal endpoints always mask, single-field reveal returns unmasked,
  no-reveal path returns masked, missing path returns 400, unknown path returns 400.

**Decisions**

- `cliService.get()` already scoped reveal to a single leaf path via
  `resolveSchemaAtPath`; no new masking logic was needed — only routing changes.
- Chose to add tests to the existing `dashboard-http.test.ts` rather than a
  new file since the test suite already has the `createApp`/`startHttpTransport`
  setup and runs with the same HOME isolation.
- Codex review confirmed no remaining bulk-reveal path and correct frontend
  endpoint usage; one non-blocking suggestion (cross-asserting two secrets) noted
  for future follow-up.

## 2026-06-15: Add HTTP Runtime Marker Lifecycle Acceptance Test (GRO-46)

**Result**

- Added the `removes the runtime marker when an HTTP server shuts down` test to
  `tests/acceptance/http-init.test.ts`. The test uses an isolated temp `HOME`
  directory, starts a real HTTP server process via `startHttpServer` with that
  `HOME` in the env, asserts that a runtime marker exists in
  `<HOME>/.computer-history-mcp/runtime-processes/` immediately after startup, then
  sends SIGTERM and polls until the marker directory is empty.
- The pattern mirrors the existing `stdio` marker lifecycle test in
  `tests/acceptance/stdio-init.test.ts` (same polling loop, same isolation
  approach), completing the acceptance criterion that both transports must
  validate marker create-on-start / remove-on-shutdown behaviour.

**Decisions**

- Used port 8770 for the new test to avoid conflicts with the existing
  acceptance tests on 8765/8766/8767/8776.
- No changes to `startHttpServer` were needed: the helper already accepts an
  `env` parameter and spreads it last, so `{ HOME: homeDir }` correctly
  overrides the inherited `HOME`.

## 2026-06-15: Restore delete-range last_1h Acceptance Test (GRO-44)

**Result**

- The stub acceptance test at line 109 of
  `tests/acceptance/privacy-control.test.ts` — previously paused because it
  depended on the removed `recent-activity` / `search-screen` tools — has been
  replaced with a full end-to-end acceptance test using the `find` /
  `privacy-control` MCP tools.
- `src/mcp/tools/shared.ts`: `formatPrivacyControlToolResult` now surfaces
  `deletedFrames`, `deletedElements`, `deletedExtractedContent`,
  `deletedSessions`, `deletedEmbeddings`, and `cascade` in the structured
  output of `delete-range` responses. These were present on the service result
  but were not passed through to the MCP tool layer.

**Decisions**

- The "outside window" fixture frame (id=1) is placed at 65 minutes ago, not
  2 hours. With the default `freshnessWindowMinutes: 15` and
  `maxCatchUpBatches: 5` the startup catch-up window is 75 minutes, so a
  2-hour frame would never be indexed and the post-delete assertion that frame 1
  survives would be vacuous.
- The test polls `find` until both recent frames (id=2, id=3) appear before
  triggering the delete, ensuring the cascade operates on already-indexed rows
  rather than racing the indexing pipeline.
- After the delete the test asserts `cascade.cascade === 'ok'` to distinguish
  a genuine cascade from a tombstone-only suppression; it also queries the
  Screenpipe SQLite fixture directly to confirm frame 1 still exists and frames
  2/3 are physically gone.

**Verification**

- `npx vitest run tests/acceptance/privacy-control.test.ts` — 4/4 pass.
- `npx vitest run tests/integration/privacy/` — 22/22 pass.
- Codex MCP review passed after two iterations (fixture window fix + cascade
  assertion + SQLite direct verification).

## Maintenance Format

Add an entry only when a change materially affects architecture, delivery,
quality gates, or public project maintenance. Use the actual completion date
from Git history and keep each entry scoped to:

- **Result**: what became true after the milestone;
- **Decisions**: constraints or trade-offs future maintainers should preserve;
- **Verification**: the evidence used to close the milestone.

## 2026-06-14: Routines MVP Delivery and Tech Debt Resolution (v2.4.0)

**Result**

- Routines MVP Groups B–D delivered in full:
  - **B (Scheduling)**: `RoutineSchedulerService` runs enabled routines on their
    configured cron schedule using `node-cron`. Overlap protection is enforced —
    a trigger that arrives while the previous run is still executing is recorded
    as `skipped` rather than spawning a concurrent run. Built-in `daily_summary`
    produces a deterministic report from `recentActivity` data with no new LLM
    provider dependency.
  - **C (MCP tools)**: `routine-list`, `routine-create`, and `routine-history`
    registered and validated through the tool manifest contract.
  - **D (Delivery & verification)**: `docs/delivery/routines.md` documents tool
    schemas, config defaults (`routines.enabled`, `routines.storagePath`), storage
    paths, and MVP scope boundaries. Contract, integration, acceptance, typecheck,
    and build automation all pass end-to-end.
- **TD-007 resolved**: `screenpipeFramesReader` renamed to `captureFramesReader`
  in the retrieval service layer, completing alignment with the capture-provider
  abstraction. No observable behavior change.
- **TD-005 resolved**: `AxTreeMaintenanceService` ported to use
  `CaptureMaintenancePort` internally, removing the last direct Screenpipe
  service reference from the maintenance layer. No behavior change.
- `docs/specs/routines-mvp.md` marked deprecated (all groups A–D complete).
- Bumped version to `2.4.0`.

**Decisions**

- Scheduler bootstrap follows the config-driven provider factory pattern
  established by capture-provider-decoupling: `RoutineSchedulerService` is
  wired in `bootstrap.ts` behind the `routines.enabled` capability gate; it is
  never referenced directly in transport or tool layers.
- `daily_summary` deliberately avoids any remote LLM call: it aggregates session
  data from `recentActivity` and formats a structured local summary, keeping the
  routine execution path deterministic and offline-safe.
- TD-007 and TD-005 were resolved together in this batch because both are
  straightforward renames/ports with zero behavior change — combining them keeps
  the commit history clean without increasing review surface.

**Verification**

- `npx tsc --noEmit` clean. Full Vitest suite passes with new routine unit,
  contract, integration, and acceptance coverage added.
- Tool manifest contract updated to include `routine-list`, `routine-create`,
  `routine-history`.
- Acceptance criteria 1–12 from `docs/specs/routines-mvp.md` verified by
  automated tests and typecheck/build.

## 2026-06-14: Security Audit Remediation (v2.2.0)

**Result**

- Remediated all 9 findings from `docs/security/audit-2026-06-14.md` (2 High, 4 Medium, 2 Low, 1 informational).
- HTTP transport hardened: timing-safe auth comparison (H1), concurrent-connection cap with `server.maxConnections` (H2), startup warning when no authToken (H3), internal error redaction from 500 responses (M1).
- Config file permission check warns on group/world-readable files at load time (M3).
- Screenpipe-control `start`/`stop` actions now emit audit logs at `warn` level (M4).
- `memory-write` content capped at 64 KB via Zod schema (L2).
- Remote-LLM evidence fragments are pre-filtered through `redactSecrets()` before outbound calls (L1).
- M2 (file-analyze root scope) deferred: no `config.yaml.example` exists; existing code-level mitigations (realpath, isPathWithinRoot, extension whitelist) are sufficient.

**Decisions**

- `maxConnections` is a required field on `AppConfig.server` (not optional) to ensure all code paths are aware of the cap. The default of 10 is conservative for a localhost-only server.
- The stat()-based permission check is isolated in its own try/catch so a race between readFile and stat cannot block config loading.
- `redactSecrets()` is exported from `remote-llm.ts` for direct unit testing.

**Verification**

- TypeScript: 0 errors. Full test suite: 1064 pass, 0 fail.
- Independent code review (subagent) approved with 0 critical/important findings, 3 low-priority suggestions (2 adopted: stat isolation, warning message completeness).
- New unit tests: http-auth (6), http-connection-cap (6), config-permissions (4), memory-write-schema (4), remote-llm-redaction (7).

## 2026-06-14: Background Recorder Lifecycle, Layering Guardrail (TD-003), and internal-status Test Isolation (TD-009)

**Result**

- The Screenpipe recorder can now run detached from the terminal. Added `npm run recorder:start` / `recorder:stop` / `recorder:status` / `recorder:logs`, the `npm run up -- --detach` opt-in, and `npm run down:all` for a one-command graceful teardown. Default `npm run up` stays foreground (unchanged). Released as `2.1.0`.
- TD-003 resolved: the "service layer must not depend upward" rule is now an automated contract test (`tests/contract/layering-boundary.test.ts`) instead of a convention.
- TD-009 resolved: `BootstrapStatusService.getStatus()` no longer forces inspection of the real `~/.screenpipe`. `BootstrapStatusDependencies` gained an optional `screenpipeDirectory` injection seam, so the `internal-status` integration tests read a fixture instead of the developer's real multi-gigabyte capture database.

**Decisions**

- Recorder backgrounding uses lightweight detach (`detached` + `unref` + log redirect + PID file), not a second launchd agent — a terminal-launched process inherits the session's screen-recording (TCC) grant, which a launchd daemon may not. `down:all` stops the recorder before the service so the recorder's final maintenance pass flushes first.
- TD-003 landed as a `git`-free, resolution-based contract test rather than `dependency-cruiser`/ESLint, to match the repo's existing boundary-test convention and add zero toolchain dependencies. Path resolution (not substring matching) prevents false positives like `bootstrap-status-service.ts`.
- TD-009 used dependency injection with a `?? resolveScreenpipeDirectory()` fallback so production behaviour is byte-for-byte unchanged; only the test seam is new. The fix also removed `makeConfig`'s never-wired `screenpipeDir` parameter — the fossil of the original broken wiring.

**Verification**

- `npx tsc --noEmit` clean; targeted suites green (observability + work-activity internal-status + layering boundary, 30 tests).
- Full unit + contract + integration suite: 997 passing. One pre-existing, unrelated failure was surfaced (`tool-manifest.contract`) and then fixed as a follow-up: the live `find` tool title is `Find in Screen Memory` (its actual purpose), but the canonical contract snapshot and the runtime `TOOL_MANIFEST` still carried the unrelated legacy name `Find Evidence`. Both stale references were corrected to match the live tool (no behaviour change — the registered title was already correct).
- Recorder lifecycle verified live earlier: `up -- --detach` detaches (recorder PPID 1), real Screenpipe `/health` 200, `down:all` graceful stop with a recorded `trigger:"final"` maintenance pass, no orphan processes. The recorder graceful-stop test was hardened against a startup signal race (ready handshake) after the full parallel suite exposed flakiness.

## 2026-06-13: Retrieval Correctness and One-Command Daily Bring-Up

**Result**

- `recall` and `find` now return results for time-window queries that mix timezone representations. Time-window bounds are compared as absolute UTC instants instead of by raw string ordering, so a UTC `Z` query bound matches capture data stored with a local offset.
- `recall` no longer fails MCP output validation on real data: `activeSeconds` / `totalActiveSeconds` / `byApp` are rounded to integer whole seconds to match the tool's output schema.
- `npm run e2e:live` builds the current source before starting the service (no longer validating a stale `dist/`), runs a direct ground-truth `recall` probe over the recorded window, and fails (`build-failed` / `empty-recall`) instead of falsely passing.
- `npm run service:start` and `npm run service:status` work when the auth token lives in `config.yaml` (not the environment); their readiness/health probes previously timed out or misreported a healthy service.
- Added `npm run up` (build → start managed service → ensure Screenpipe recording) and `npm run down` as the one-command daily bring-up / teardown.
- Registered TD-008 (time-window queries depend on runtime `datetime()` normalization; canonical-UTC storage deferred).

**Decisions**

- Fix the timezone-window bug query-side with SQLite `datetime()` on both bounds (the existing `ax-tree-maintenance-service` pattern); no on-disk data migration. Accept the index-bypass cost at local-first scale; defer canonical-UTC storage to TD-008.
- Keep keyset-pagination cursor comparisons as raw string compares — their bound is a stored timestamp of the same representation, and `datetime()` would truncate the sub-second tiebreak.
- Preserve `recall`'s integer-seconds output contract by rounding at the service boundary rather than relaxing the schema.
- These were pre-existing defects, independent of the capture-provider migration; two pairs of them masked each other (the timezone bug kept `recall` empty, which hid the integer-validation bug; the auth-token env-only probe was hidden because `e2e:live` injected the token from config).

**Verification**

- Full Vitest suite green (1019 tests) with new regression coverage: cross-timezone window matching (session store + extracted-content store), `recall` fractional→integer rounding, and the `up` orchestration contract.
- Live `npm run e2e:live` end-to-end pass: `recall.sessions > 0` over a freshly recorded window, ground-truth probe satisfied.
- Live `npm run up` brings the full stack up and `npm run service:status` reports `healthy`; clean teardown via `npm run down` leaves no orphan processes.

## 2026-06-13: Screen-Memory `db.sqlite` Growth Diagnosis and Maintenance Throughput Fix

**Result**

- Diagnosed why a live `~/.screenpipe/db.sqlite` had reached 4.55 GB while captured frames spanned only ~3 days (06-10 .. 06-13) and `--retention-days 7` was working (zero rows older than 7 days). It was neither a retention bug nor un-reclaimed deleted space (freelist was ~0; the file was almost entirely live data).
- Located the cost driver via `dbstat` + per-column length sums: the `frames` table was 3.85 GB, of which the per-frame `accessibility_tree_json` blob alone was 2.6 GB across ~2,400 frames (avg 1.1 MB/frame, max 3 MB). Event-driven capture under `--use-all-monitors` snapshots a full accessibility tree on every keypress / visual change (2,034 `key_press` + 1,746 `visual_change` triggers), so the blobs accumulate quickly.
- Confirmed the reduction mechanism works but could not keep up: `AxTreeMaintenanceService.sweepOnce()` converts each frame's tree JSON into the compact `elements` table after 15 minutes and nulls the blob, then `reclaimOnce()` returns pages via `incremental_vacuum`. At `DEFAULT_BATCH_SIZE=100` and reclaim `maxPages=2000` (~8 MB/run) it fell behind the capture inflow and never drained the backlog, and the file never shrank.
- Fix (commit `897a964`): raised `DEFAULT_BATCH_SIZE` 100 → 500 and the reclaim page ceiling 2000 → 20000 (~80 MB/run). Sweep/convert logic unchanged. Because the scheduled maintenance runs via `tsx` against `src/` (spawned by `screenpipe-safe-record.js` every 10 min), the new defaults take effect on the next cycle without a rebuild.
- One-time lossless cleanup of the live database: drained the backlog (`maintain:run` ×7, ~2,257 frames swept) then `PRAGMA incremental_vacuum` + `PRAGMA wal_checkpoint(TRUNCATE)`. Result: 4.55 GB → 0.93 GB.

**Decisions**

- Use `incremental_vacuum` + a TRUNCATE checkpoint for the live reclaim rather than a full `VACUUM` / `maintain:init`. `auto_vacuum` was already INCREMENTAL, so this returns space in place with no downtime and no extra disk — important because only ~13 GB was free, and `maintain:init` would back up the DB and `VACUUM` under an exclusive lock (needs Screenpipe stopped + ~2× DB size free).
- In WAL mode `incremental_vacuum` reduces `page_count` immediately but only truncates the main file after a checkpoint; the cleanup must pair it with `wal_checkpoint(TRUNCATE)`.
- Keep routine reclaim on `incremental_vacuum` (steady, lock-friendly) instead of adding a periodic full `VACUUM` to the maintenance loop. `maintain:init` remains the manual defrag path.
- Did not change capture volume (`--use-all-monitors` / per-keypress AX snapshots) — deferred per the user; the throughput fix makes the DB self-bounding regardless.

**Verification**

- Maintenance unit tests green (33) and `tsc --noEmit` clean. Existing reclaim/sweep tests pass explicit overrides, so the new defaults do not affect them.
- Live cleanup verified: `page_count` 951,171 → 226,500, file 4.55 GB → 0.93 GB, `PRAGMA quick_check = ok`, 247,413 accessibility `elements` rows preserved, `framesWithTreeJson` down to ~180 (only the <15-min working set), and Screenpipe kept recording with `/health` OK throughout.

## 2026-06-11: Screenpipe Maintenance Observability

**Result**

- Added operator-visible JSONL logging for Screenpipe database maintenance runs started by `npm run screenpipe:safe-record`.
- Documented the maintenance log path, retention policy, rotation cap, and troubleshooting flow.
- Bumped the package version to `2.0.2`.

**Decisions**

- Keep maintenance logs under `~/.computer-history-mcp/logs/` with private directory and file permissions.
- Retain maintenance log entries for 7 days to match the safe-record default data-retention window, with 1 MB rotation as a disk-safety cap.
- Keep periodic maintenance non-blocking for the recorder, but wait for final maintenance logging before the wrapper exits.

**Verification**

- Ran focused safe-record maintenance tests, TypeScript checks, the production build, whitespace diff checks, and the full Vitest suite.

## 2026-06-01: Public Project Maintenance Surface

**Result**

- Rewrote the repository landing page as an English-first open-source README
  with a Simplified Chinese counterpart.
- Added Apache License 2.0 and standard community files: contribution
  guidelines, Contributor Covenant 2.1, security policy, GitHub issue forms,
  and a pull-request template.
- Enabled GitHub Private vulnerability reporting for the public repository.
- Published a clean `public-main` snapshot to GitHub `main`.

**Decisions**

- Keep `README.md` as the default English entry point and
  `README.zh-CN.md` as the Chinese counterpart.
- Route vulnerability and conduct-enforcement reports through private GitHub
  Security Advisories instead of publishing a maintainer email address.
- Preserve development ancestry during releases while excluding
  development-only artifacts such as `.planning/`, `.kiro/`, and
  `docs/superpowers/` from public snapshots.

**Verification**

- Validated Markdown links, governed-document metadata, GitHub issue-form
  YAML, Apache License text, `npm run typecheck`, `npm run build`, and the
  full Vitest suite.

## 2026-05-31: Release Build Repair

**Result**

- Restored the TypeScript build before the public release workflow.

**Decisions**

- Preserve existing Zod validation semantics while using the Zod 4-compatible
  `.superRefine()` API.
- Keep test helpers aligned with current summary, privacy, and vector-store
  contracts.

**Verification**

- Ran `npm run typecheck`, `npm run build`, and the full Vitest suite.

## 2026-05-29: Hermes End-to-End Integration

**Result**

- Added `npm run hermes:verify` as the real end-to-end Hermes smoke gate
  against the user's local Hermes configuration and MCP service.
- Added shared Hermes CLI detection, onboarding hints, and a dedicated Hermes
  client guide.
- Aligned Hermes evaluation helpers with the registered `find` and `recall`
  tool surface.

**Decisions**

- Treat `npm run hermes:verify` as the canonical post-onboarding Hermes check.
- Keep Hermes detection non-blocking during setup and onboarding so the core
  MCP server remains usable with other clients.

**Verification**

- Added contract and failure-mode coverage for Hermes configuration, tool
  inclusion, fixture IDs, and anchored evaluation windows.

## 2026-05-27: Work-Activity Analysis Release

**Result**

- Released `find`, `recall`, and `inspect` as the work-activity MCP surface.
- Added a local derived SQLite database, session aggregation, summaries,
  embedding deduplication, work-activity observability, and privacy-aware
  cascade deletion.
- Bumped the package version to `2.0.0`.

**Decisions**

- Keep derived work-activity data local.
- Keep MCP tools thin and place domain behavior in services.
- Use structured, privacy-aware fallback and cascade-failure states instead of
  silently swallowing errors.

**Verification**

- Added unit, integration, acceptance, property-based, and performance
  coverage for the new work-activity surface.

## 2026-05-25: Naming and Routine Persistence Foundation

**Result**

- Unified the active project name as `computer-history-mcp` across scripts and
  tests.
- Added the file-backed routine store and supporting tests.
- Hardened test harness project-root discovery and repaired acceptance-suite
  regressions.

**Decisions**

- Store routine definitions locally.
- Keep local test and review artifacts out of public snapshots.

**Verification**

- Added routine-store coverage and reran the repaired acceptance paths.

## 2026-05-02: Initial Public Release

**Result**

- Published version `1.0.0` of the standalone Screenpipe memory MCP server.
- Established stdio and loopback-only Streamable HTTP runtime paths.
- Added configuration, onboarding, local service management, and routine setup
  foundations.

**Decisions**

- Keep the product as an independent MCP server with no frontend.
- Bind managed HTTP mode to `127.0.0.1`.
- Keep storage and service operation local-first.

**Verification**

- Validated the public release path and foundational MCP workflows.

## 2026-06-10 — e2e:live first successful live smoke

`npm run e2e:live -- --duration 1m` 真机冒烟首次通过（屏幕解锁、依赖复用模式）：

```
=== Pass_Fail_Summary ===
outcome: pass
failureMode: none
hermesVersion: Hermes Agent v0.16.0 (2026.6.5) · upstream e2cc24e3
mcpEndpoint: http://127.0.0.1:18765/mcp
recordWindow: 2026-06-10T09:45:49.693Z .. 2026-06-10T09:46:49.698Z
framesInWindow: 20
=========================
```

人工确认：Hermes 回答准确描述了录制窗口内的真实屏幕内容（终端中的 computer-history-mcp 工作、Firefox/Chrome 浏览页面）。

冒烟过程中发现并修复的集成问题：MCP probe 缺 Bearer/Accept 头、service:start 子进程缺 token env、Screenpipe API auth 未透传、零帧判定过早（落库延迟）、Hermes --quiet 吞掉工具 marker。

遗留 follow-up（未修）：
- recall 工具全天窗口查询时输出校验报错：`activeSeconds` schema 为 int 但实际值为小数（src/mcp/tools recall 输出 schema bug）
- hermes chat 调 internal-status 报 `MCP call failed: RuntimeError: Invalid struct...`（Hermes 侧结构解析，待排查）
- scripts/hermes-e2e.js 仍使用 --quiet + marker 检测，在 Hermes v0.16 下会与本次相同方式误判，需要同样的修复
