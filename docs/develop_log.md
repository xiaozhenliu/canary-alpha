---
doc_version: 2
doc_status: active
last_updated: 2026-06-01
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
