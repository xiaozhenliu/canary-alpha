---
doc_version: 6
doc_status: active
last_updated: 2026-06-14
---

# Development Log

This log records maintainer-facing milestones for `canary-alpha-mcp`. It is a
compact narrative of important implementation decisions and verification
outcomes, not a duplicate of the Git commit history.

For user-visible release notes, read the [changelog](../CHANGELOG.md).

## Maintenance Format

Add an entry only when a change materially affects architecture, delivery,
quality gates, or public project maintenance. Use the actual completion date
from Git history and keep each entry scoped to:

- **Result**: what became true after the milestone;
- **Decisions**: constraints or trade-offs future maintainers should preserve;
- **Verification**: the evidence used to close the milestone.

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

- Keep maintenance logs under `~/.canary-alpha-mcp/logs/` with private directory and file permissions.
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

- Unified the active project name as `canary-alpha-mcp` across scripts and
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

人工确认：Hermes 回答准确描述了录制窗口内的真实屏幕内容（终端中的 canary-alpha-mcp 工作、Firefox/Chrome 浏览页面）。

冒烟过程中发现并修复的集成问题：MCP probe 缺 Bearer/Accept 头、service:start 子进程缺 token env、Screenpipe API auth 未透传、零帧判定过早（落库延迟）、Hermes --quiet 吞掉工具 marker。

遗留 follow-up（未修）：
- recall 工具全天窗口查询时输出校验报错：`activeSeconds` schema 为 int 但实际值为小数（src/mcp/tools recall 输出 schema bug）
- hermes chat 调 internal-status 报 `MCP call failed: RuntimeError: Invalid struct...`（Hermes 侧结构解析，待排查）
- scripts/hermes-e2e.js 仍使用 --quiet + marker 检测，在 Hermes v0.16 下会与本次相同方式误判，需要同样的修复
