---
doc_version: 15
doc_status: active
last_updated: 2026-06-12
---

# Governed Documents

## Purpose

This document defines the formal reader-facing documentation set for `canary-alpha-mcp`.

It is the canonical inventory for documentation governance. Each governed document listed here must stay discoverable, must keep the approved metadata contract, and must have a clear coverage boundary.

## Governance Scope

Included in governance:

- `README.md`
- reader-facing maintained documents under `docs/**`
- future long-lived reader-facing documents added to the maintained documentation set

Excluded from governance:

- `docs/superpowers/**`
- `.planning/**`
- execution logs, research notes, and phase artifacts outside `docs/`
- transient working notes and scratch files

`docs/superpowers/**` is treated as superpowers-generated process output rather than part of the public maintained documentation set.

## Document Inventory

### Repo root and meta documents

| Path | Audience | Coverage | Core Content | Current State | Governance Action |
|------|----------|----------|--------------|---------------|-------------------|
| `README.md` | New users, evaluators, maintainers | Project entry point and navigation | Project purpose, quick start, primary docs links, official runtime path, public doc map | adequate | none |
| `README.zh-CN.md` | Chinese-speaking new users, evaluators, maintainers | Simplified Chinese project entry point and navigation | Project purpose, quick start, primary docs links, official runtime path, public doc map | adequate | none |
| `CONTRIBUTING.md` | Contributors | Contribution workflow and quality expectations | Issue guidance, setup, engineering constraints, verification, documentation governance, PR expectations | adequate | none |
| `CODE_OF_CONDUCT.md` | Contributors and maintainers | Community participation standards | Contributor Covenant 2.1, enforcement scope, private reporting path | adequate | none |
| `SECURITY.md` | Security reporters and maintainers | Private vulnerability reporting policy | Supported versions, GitHub Security Advisory path, disclosure constraints | adequate | none |
| `CHANGELOG.md` | Users, evaluators, and maintainers | User-facing release history | Notable changes organized by semantic version and release date | adequate | none |

### Documentation site — English (docs site pages)

| Path | Audience | Coverage | Core Content | Current State | Governance Action |
|------|----------|----------|--------------|---------------|-------------------|
| `docs/index.md` | All users | Site homepage | Hero intro, three feature highlights, quickstart CTA | adequate | none |
| `docs/guide/introduction.md` | New users | What it is and how it works | Purpose, data flow, what it is not, next steps | adequate | none |
| `docs/guide/quickstart.md` | New users | First-run path | Screenpipe install → onboard → verify → connect | adequate | none |
| `docs/guide/clients/claude-code.md` | Claude Code / Desktop users | Client setup | HTTP transport (Claude Code), stdio config (Claude Desktop), verification | adequate | none |
| `docs/guide/clients/cursor.md` | Cursor users | Client setup | HTTP and stdio config via Cursor settings and JSON file | adequate | none |
| `docs/guide/clients/hermes.md` | Hermes users | Hermes-specific walkthrough | Prerequisites, verify, hermes:verify, failure modes | adequate | none |
| `docs/guide/clients/generic-mcp.md` | Any MCP client integrators | Generic client setup | Transport expectations, checklist, first calls, common mistakes | adequate | none |
| `docs/guide/operations.md` | Operators | Day-to-day management | Service management, diagnostics, index maintenance, e2e check, disk layout | adequate | none |
| `docs/guide/troubleshooting.md` | Operators and maintainers | Operational diagnosis and recovery | Service unreachable, provider errors, rebuild path, log inspection, capture observability | adequate | none |
| `docs/reference/tools.md` | MCP client integrators | Tool surface area and contracts | Tool purpose, input schema, output expectations | adequate | none |
| `docs/reference/configuration.md` | Users configuring the server | Configuration contract | Config file location, fields, defaults, provider examples, config CLI commands, validation rules | adequate | none |
| `docs/reference/privacy.md` | All users | Privacy and data locality | Data storage, capture defaults, runtime controls, log rotation | adequate | none |

### Documentation site — Simplified Chinese (docs/zh/)

| Path | Audience | Coverage |
|------|----------|----------|
| `docs/zh/index.md` | Chinese-speaking users | Site homepage (ZH) |
| `docs/zh/guide/introduction.md` | Chinese-speaking new users | Introduction (ZH) |
| `docs/zh/guide/quickstart.md` | Chinese-speaking new users | Quickstart (ZH) |
| `docs/zh/guide/clients/claude-code.md` | Claude Code / Desktop users | Claude Code & Desktop setup (ZH) |
| `docs/zh/guide/clients/cursor.md` | Cursor users | Cursor setup (ZH) |
| `docs/zh/guide/clients/hermes.md` | Hermes users | Hermes walkthrough (ZH) |
| `docs/zh/guide/clients/generic-mcp.md` | Any MCP client integrators | Generic client setup (ZH) |
| `docs/zh/guide/operations.md` | Operators | Operations (ZH) |
| `docs/zh/guide/troubleshooting.md` | Operators and maintainers | Troubleshooting (ZH) |
| `docs/zh/reference/tools.md` | MCP client integrators | MCP Tools reference (ZH) |
| `docs/zh/reference/configuration.md` | Users configuring the server | Configuration reference (ZH) |
| `docs/zh/reference/privacy.md` | All users | Privacy & Data (ZH) |

### Internal / repo-only documents (not part of docs site)

| Path | Audience | Coverage | Current State | Governance Action |
|------|----------|----------|---------------|-------------------|
| `docs/documentation/governed-documents.md` | Maintainers and contributors | Canonical documentation governance inventory and scope definition | adequate | none |
| `docs/engineering/code-standards.md` | Maintainers and contributors | Engineering rules for the v1 codebase | adequate | none |
| `docs/engineering/bug-reports/README.md` | Maintainers | Open defect register index (per-defect records under `docs/engineering/bug-reports/`) | adequate | none |
| `docs/engineering/tech-debt.md` | Maintainers | Structural technical debt register | adequate | none |
| `docs/delivery/http-service.md` | Operators and integrators | Local HTTP service lifecycle and runtime contract | adequate | none |
| `docs/delivery/hermes.md` | Operators validating Hermes interoperability | Hermes-specific verification boundary | adequate | none |
| `docs/architecture.md` | Maintainers and advanced integrators | Runtime architecture and implementation boundaries | adequate | none |
| `docs/develop_log.md` | Maintainers | Milestone-oriented development history | adequate | none |

## State Vocabulary

`Current State` values:

- `adequate`
- `needs-expansion`
- `needs-rewrite`
- `missing`

`Governance Action` values:

- `add-metadata`
- `revise`
- `rewrite`
- `create`
- `merge`
- `deprecate`
- `none`

## Maintenance Rule

When a new formal reader-facing document is added under the governed set, add it to this inventory in the same change.
