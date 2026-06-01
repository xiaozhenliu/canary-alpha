---
doc_version: 8
doc_status: active
last_updated: 2026-06-01
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

| Path | Audience | Coverage | Core Content | Current State | Governance Action |
|------|----------|----------|--------------|---------------|-------------------|
| `README.md` | New users, evaluators, maintainers | Project entry point and navigation | Project purpose, quick start, primary docs links, official runtime path, public doc map | adequate | none |
| `README.zh-CN.md` | Chinese-speaking new users, evaluators, maintainers | Simplified Chinese project entry point and navigation | Project purpose, quick start, primary docs links, official runtime path, public doc map | adequate | none |
| `docs/quickstart.md` | New users | Normal macOS install/start path | Install Screenpipe, verify `localhost:3030`, run `npm run onboard`, confirm Hermes and the MCP endpoint | adequate | none |
| `docs/delivery/http-service.md` | Operators and integrators | Local HTTP service lifecycle and runtime contract | Setup, launchd lifecycle, recovery, verification commands | adequate | none |
| `docs/delivery/hermes.md` | Operators validating Hermes interoperability | Hermes-specific verification boundary | Hermes smoke flow, evidence files, failure modes | adequate | none |
| `docs/documentation/governed-documents.md` | Maintainers and contributors | Canonical documentation governance inventory and scope definition | Governed set, metadata scope, state vocabulary, maintenance rule | adequate | none |
| `docs/engineering/code-standards.md` | Maintainers and contributors | Engineering rules for the v1 codebase | Layering boundaries, testing standards, result-shaping rules | adequate | none |
| `docs/documentation/configuration.md` | Users configuring the server | Configuration contract | Config file location, fields, defaults, provider examples, validation rules | adequate | none |
| `docs/documentation/mcp-tools.md` | MCP client integrators | Tool surface area and contracts | Tool purpose, input shape, output expectations, usage notes | adequate | none |
| `docs/clients/generic-mcp.md` | Client integrators | Generic MCP client setup | HTTP endpoint usage, transport expectations, onboarding and verification path | adequate | none |
| `docs/clients/hermes.md` | New Hermes users | Hermes-specific end-to-end walkthrough | Step-by-step path from onboarding to first real tool call; failure mode reference | adequate | none |
| `docs/troubleshooting.md` | Operators and maintainers | Operational diagnosis and recovery | Service unreachable, provider errors, rebuild path, log inspection | adequate | none |
| `docs/architecture.md` | Maintainers and advanced integrators | Runtime architecture and implementation boundaries | Runtime layers, data flows, storage layout, constraints, and deferred capabilities | adequate | none |

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
