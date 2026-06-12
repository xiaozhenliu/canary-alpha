---
doc_version: 2
doc_status: active
last_updated: 2026-05-27
---

# canary-alpha-mcp Crimson Engineering Standards

## Purpose and scope

This document captures the current Crimson engineering standards that are already visible in the repository. It is meant to anchor audit and implementation work to the real codebase shape, not to a generic TypeScript handbook.

Applies to:
- `src/**`
- `tests/**`
- runtime-facing scripts and bootstrap paths that affect stdio or Streamable HTTP behavior

This repo must remain an independent MCP server with both local stdio and Streamable HTTP entry paths, local-first storage, and tool-only access surfaces. Standards in this file therefore preserve explicit wiring, local-only runtime assumptions, and acceptance-first verification.

## Core architectural boundaries

### `src/bootstrap` is the composition root

`src/bootstrap/create-app.ts` is the composition root. It loads config, creates the logger, builds stores and providers, wires domain services, and returns a typed `AppContext`.

Standards:
- new cross-cutting dependencies should be wired in the composition root
- tools should consume dependencies from `AppContext` instead of constructing them ad hoc
- bootstrap may assemble infrastructure and enforce startup invariants
- bootstrap should not absorb domain-specific behavior that belongs in `services`

Current anchor:
- `createApp()` builds memory, privacy, retrieval, indexing, provider, and vector-store dependencies, then returns an object that `satisfies AppContext`

### `src/mcp/tools` are thin MCP tools

`src/mcp/tools/**` is an adapter boundary, not a business-logic layer. Each tool file should stay thin: define schema, register the MCP tool, delegate to a service, and format the result.

Standards:
- keep tool files focused on MCP registration, zod-backed validation, and result formatting
- do not move retrieval, privacy, persistence, or orchestration logic into tool handlers
- prefer one exported `registerXTool` function per tool file
- shared tool result formatting belongs in `src/mcp/tools/shared.ts` when multiple tools need the same result-shaping conventions

Current anchors:
- `src/mcp/register-tools.ts` is a thin registry that wires tool registrars into the server
- `src/mcp/tools/shared.ts` centralizes MCP result-shaping helpers
- `find`, `recall`, `inspect`, `memory-write`, and similar tool files follow the thin MCP tools pattern

### `src/services/**` own domain behavior

`src/services/**` is the main behavior layer. Retrieval, memory, privacy, bootstrap status, runtime process checks, and file-analysis rules should live here, not in transports or tool registration.

Standards:
- request/result contracts belong near the domain in `types.ts`
- service methods should return named result objects rather than unstructured tuples or raw primitives
- concrete implementations should stay close to their domain contracts
- service code may depend on stores, providers, and clients that were assembled in the composition root

Current anchors:
- retrieval request/result contracts live in `src/services/retrieval/types.ts`
- memory and privacy flows are implemented behind service/store abstractions
- retrieval services own freshness, evidence shaping, degraded behavior, and actionable error semantics

### `src/transports/**` are ingress-only adapters

`src/transports/**` starts runtime ingress surfaces for stdio and Streamable HTTP. These files should remain runtime adapters, not alternate service layers.

Standards:
- transport code may translate runtime startup concerns into MCP server lifecycle calls
- transport code should not duplicate domain logic, provider logic, or privacy logic
- transport-specific concerns stay at the edge; tool and service behavior should stay transport-agnostic
- local-only HTTP safety must be preserved because the server is intended to bind to `127.0.0.1`

### `src/index.ts` is orchestration, not a second service layer

`src/index.ts` is allowed to orchestrate CLI parsing, runtime checks, and startup flows, but it should not become a second home for reusable domain logic.

Standards:
- entrypoint-only command parsing and runtime coordination may live here
- reusable helpers that outgrow entrypoint-specific use should move into focused modules
- do not let `src/index.ts` become the owner of retrieval, privacy, or transport behavior
- when new operational flows are added, prefer extracting focused modules before the entrypoint accumulates another embedded subsystem

This is a current drift point. The audit should watch entrypoint growth closely.

## Naming and file-shape conventions already used in v1

These standards should describe the naming already present in the repo:

- tool registrars use `registerXTool`
- service constructors or factories use `createXService` or `DefaultXService`
- persistence implementations commonly use `FileXStore`
- domain contracts live in nearby `types.ts`
- common formatting or utility glue often lives in `shared.ts`
- source files in `src/` trend toward kebab-case file names
- local helpers are usually small functions above the main export

Examples grounded in the codebase:
- `registerTools(server, app)` in `src/mcp/register-tools.ts`
- `registerFindTool`, `registerRecallTool`, `registerInspectTool`, `createIndexingService`
- `DefaultMemoryService`, `FileMemoryStore`, `FilePrivacyStore`
- retrieval result contracts in `src/services/retrieval/types.ts`

## Schema and boundary validation standards

This repo already relies on zod at important boundaries. Future work should preserve that pattern.

Standards:
- use zod for MCP tool input schemas
- use zod for config and environment-backed runtime schema validation
- keep schema definitions close to the boundary they protect unless a schema is intentionally shared
- avoid replacing schema-backed boundaries with scattered manual validation branches

Rationale:
- zod is already the repo standard for tool/config boundaries
- schema-backed boundaries keep stdio and HTTP behavior deterministic for both agents and acceptance tests

## MCP result-shaping standards

Agent-facing MCP responses must remain both human-readable and machine-readable.

Standards:
- MCP tools should return human-readable `content`
- MCP tools should also return machine-readable `structuredContent`
- `structuredContent` should carry the stable fields agents and tests inspect
- `isError` should reflect whether the agent-facing outcome is an error state
- shared formatting helpers should live in `src/mcp/tools/shared.ts` when multiple tools need the same output contract

Current anchors from `src/mcp/tools/shared.ts`:
- retrieval tools return summaries in `content` and richer objects in `structuredContent`
- memory and privacy tools expose structured fields for scope, mode, state, and errors
- retrieval formatting keeps freshness, evidence, degraded state, and error payloads visible to agents

For retrieval-specific shapes, preserve the current result style from `src/services/retrieval/types.ts`:
- `summary` for concise agent-facing interpretation
- `evidence` for machine-usable records
- `degraded` when fallback behavior occurs
- `freshness` when temporal reliability matters
- `error` when a structured actionable error must reach the caller

## Error-boundary standards

This repo intentionally uses different error channels at different layers. Future work should keep those boundaries explicit.

### Boundaries that may throw

Config, bootstrap, and transport startup paths may throw when the runtime cannot start correctly.

Examples:
- invalid mode or command parsing in `src/index.ts`
- managed HTTP bind safety checks in `src/bootstrap/create-app.ts`
- infrastructure setup failures that should stop server startup

### Boundaries that should prefer structured actionable errors

Agent-facing service and tool paths should prefer structured actionable errors when the goal is to preserve stable MCP behavior for callers.

Standards:
- retrieval and similar agent-facing paths should return structured actionable errors instead of leaking raw exceptions into transport behavior
- MCP tools should format those errors into both readable `content` and stable `structuredContent`
- only throw from a service path when the failure is truly infrastructure-fatal and cannot be represented safely for the caller

Current anchors:
- retrieval result types include `RetrievalActionableError`
- tool formatters in `src/mcp/tools/shared.ts` convert result errors into deterministic MCP output

This split matters to audit work: bootstrap and transports can fail loudly; agent-facing behavior should fail in a structured way.

## Testing standards: acceptance first, then the matching boundary

The repo already treats Vitest acceptance and integration coverage as first-class correctness infrastructure. Future changes should preserve that quality bar.

Standards:
- changes to transports, bootstrap wiring, or end-to-end MCP behavior need acceptance coverage
- changes to provider wiring, retrieval behavior, privacy behavior, or cross-module service interactions need integration or acceptance coverage matching the modified boundary
- `tests/helpers/**` is first-class infrastructure, not disposable test glue
- acceptance tests should continue to exercise the real server process and real MCP flows where practical
- do not rely only on mock-heavy unit tests for changes that affect runtime behavior, degraded behavior, config switching, or interoperability

Current anchors:
- `tests/acceptance/http-init.test.ts` verifies structured content over Streamable HTTP
- the acceptance harness starts the real server and talks to it through MCP client helpers
- helper modules under `tests/helpers/**` support realistic transport/bootstrap/provider test flows

Audit implication:
- if a change modifies MCP shape, bootstrap behavior, local-only HTTP behavior, provider selection, retrieval degradation, or privacy enforcement, expect acceptance or integration verification at that same boundary

## Explicit Crimson constraints that the standards must preserve

These are not optional style choices; they are part of the current repo contract.

- keep the project as an independent MCP server
- preserve both stdio and Streamable HTTP runtime support
- keep HTTP local-only and bound to `127.0.0.1`
- keep provider switching configuration-driven instead of scattering provider-specific branches across services
- preserve explicit wiring over heavy framework abstraction
- keep the document and future audit scope focused on current Crimson MCP-server reality
- keep `tests/helpers/**` and end-to-end harnesses as first-class infrastructure whenever boundary-level behavior changes

## Active cleanup targets for the audit

This section is intentionally short. It identifies real drift points in the current Crimson codebase without turning this document into a speculative refactor manifesto.

### 1. Duplicated retrieval/privacy helpers

The audit should watch for duplicated retrieval/privacy helpers across retrieval services, especially timestamp normalization, privacy-state shaping, exclusion checks, and related helper logic. New work should avoid adding another copy when the logic already exists nearby.

### 2. Version metadata drift

The audit should check version metadata drift between package metadata and runtime-reported metadata. A single canonical source or release-sync rule should eventually replace duplicated version values.

### 3. Entrypoint growth in `src/index.ts`

`src/index.ts` already coordinates many operational concerns. Keep it as orchestration, and extract reusable logic before it becomes a hidden second service layer.

## Practical review checklist

Use this checklist when reviewing changes against the current Crimson standards:

- Does the change keep the composition root in `src/bootstrap/create-app.ts` as the place where shared dependencies are assembled?
- Are MCP tools still thin MCP tools rather than new homes for domain logic?
- Does the behavior live in `services` if it is part of the product contract?
- Are `transports` still ingress-only adapters?
- Is `src/index.ts` still orchestration rather than a second service layer?
- Are tool/config boundaries backed by zod?
- Does the MCP response include both `content` and `structuredContent` where agents or tests need stable fields?
- Does the code use structured actionable errors on agent-facing paths instead of transport-breaking exceptions?
- Did the change add acceptance or integration coverage at the boundary it modified?
- Did the change avoid widening scope beyond the Crimson MCP server surface?

## What this document is not

This is not a generic TypeScript formatting guide and not a v2 roadmap. It exists to describe the current Crimson standards surface that future audit and implementation work should follow in this repository.
