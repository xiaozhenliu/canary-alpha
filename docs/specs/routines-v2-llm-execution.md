---
doc_version: 6
doc_status: deprecated
last_updated: 2026-06-21
---

# Spec: Routines v2 — Prompt-Driven LLM Execution

> Delivered in v2.7.0. This document is retained as the historical specification and acceptance record.

## Background

### Current State

Routines MVP (v2.4.0, [routines-mvp.md](./routines-mvp.md)) delivered the scheduling and persistence infrastructure: `FileRoutineStore` (definitions + history), `RoutineScheduler` (node-cron, no-overlap guard, hot-reload via `refresh()`), and three MCP tools (`routine-list` / `routine-create` / `routine-history`). The infrastructure is solid and well-tested.

However, the execution layer has a critical design flaw: **the user's prompt is accepted but never consumed**. All routines are hardcoded to `kind: 'daily_summary'`, and the sole executor (`DailySummaryExecutor`) ignores `definition.prompt` entirely — it calls `RecallService.recall()` with the configured time window and formats a fixed session-count report. A routine with prompt `"summarize my competitor research"` produces the same output as one with `"list today's meetings"`.

This means:

- `RoutineKind = 'daily_summary'` is the only enum member and is hardcoded at `routine-create.ts:105`.
- The `prompt` field on `RoutineDefinition` is stored but never read by any executor.
- `recentActivityMinutes` defaults to 60 regardless of schedule frequency — a weekly routine only looks back 1 hour.
- Every routine produces identical output: a session metadata table with counts and durations.

### Competitive Reference: Littlebird Routines

[Littlebird](https://littlebird.ai/features/routines) (raised $11M, March 2026) offers routines as a core feature of its screen-memory assistant. Key design differences:

| Dimension | Littlebird | computer-history-mcp (current) |
|---|---|---|
| **Prompt role** | The prompt IS the routine — LLM executes it against screen memory | Prompt is stored but ignored by executor |
| **Schedule UX** | User-facing presets (daily / weekly / monthly); exact UI mechanism unconfirmed | Raw cron expression (acceptable for MCP-server-to-agent use) |
| **Execution** | LLM reads relevant screen context and generates a briefing | Deterministic template — fixed session-count report |
| **Data access** | Full screen memory across all observed applications | Only session-level metadata (no screen text content) |
| **Output interaction** | Follow-up chat on each routine output | Static text record, no follow-up |
| **Templates** | Pre-built (daily briefing, weekly summary, competitor monitoring) | None — single hardcoded behavior |

Littlebird's core value: **the user writes what they want in natural language, the system retrieves relevant screen content, and the LLM produces a tailored briefing**. Our system has the retrieval infrastructure (find semantic + recall) but the routine executor doesn't use it.

### Decision Rationale

We evaluated two approaches:

**Approach 1 — Recall + LLM**: Feed session metadata to an LLM with the user's prompt. Simple to implement, but the LLM only sees metadata (app names, durations), not actual screen content. A prompt like "summarize competitor activity" would produce vague output because no original text is available.

**Approach 2 — Find + Recall + LLM**: Use `FindService.find()` (keyword or semantic) to retrieve content relevant to the prompt, combine with `RecallService.recall()` for the activity overview, and feed both to the LLM. This delivers genuine content-aware briefings.

**Decision: Approach 2**, with keyword mode as the primary retrieval path and semantic as an optional enhancement. Rationale:

1. The retrieval infrastructure already exists — `FindService` supports keyword, semantic, and hybrid modes with graceful degradation. `RecallService` supports session/hour/day granularity with optional per-session summaries.
2. Keyword retrieval is performant on large time windows (index-served SQL; a perf SLA test fixture supports up to 432k rows with a P95 ≤ 500ms target). Semantic retrieval has known performance limitations on large candidate sets (brute-force dotProduct) that make it risky for weekly routines without further optimization.
3. Adding LLM execution to routines is an incremental change to the executor, not a retrieval-layer redesign. The existing `llm` config (`base_url`, `api_key`, `model`) and the patterns from `RemoteLlmSummaryProvider` (timeout, abort, error codes, secret redaction) can be reused.
4. Systematic retrieval-layer improvements (ANN indexing, text-level dedup, topic clustering) should be driven by real usage data from this feature, not designed upfront.

## Goal

A routine's prompt determines what it reports. The executor retrieves relevant screen content and activity data for the configured time window, and an LLM produces a tailored briefing. When no LLM is configured, the executor falls back to the current deterministic behavior.

## Requirements

### E. Prompt-Driven Execution

- **ROUT-E01**: The `RoutineKind` type constraint is removed. All routines share a single executor that consumes `definition.prompt` to determine retrieval strategy and output content.
- **ROUT-E02**: The executor computes a look-back window from `definition.recentActivityMinutes`. When the user omits this field, `routine-create` infers a sensible default from the cron schedule (see §Defaults).
- **ROUT-E03**: The executor retrieves two data sources in parallel for the computed time window:
  - **Activity overview**: `RecallService.recall({ granularity: 'session', includeSummary: true })` — session-level metadata with optional summaries.
  - **Relevant evidence**: `FindService.find({ query: <keywords from prompt>, mode: 'keyword' })` — screen text fragments matching the prompt's terms, with `extractedText` included.
- **ROUT-E04**: The executor assembles a structured LLM prompt containing the user's routine prompt, the activity overview, and the relevant evidence, then calls the configured LLM endpoint (`config.llm`) via an OpenAI-compatible `chat/completions` request.
- **ROUT-E05**: The LLM response is stored as the routine run's `summary` (first line or LLM-extracted headline) and `output` (full response text).
- **ROUT-E06**: When `config.llm.base_url` or `config.llm.api_key` is not configured, the executor falls back to deterministic template formatting (current `DailySummaryExecutor` behavior). The fallback produces a run record with `summary` indicating the degraded mode.

### F. Evidence Quality

- **ROUT-F05**: The executor deduplicates evidence items by `extractedText` content before assembling the LLM prompt, so that identical adjacent frames do not consume the token budget.
- **ROUT-F06**: The assembled LLM context is truncated to a configurable character ceiling (default: 6000 characters for evidence, 2000 characters for activity overview) to keep token consumption bounded. Character-to-token ratios vary by model and language (CJK text averages ~0.5–0.7 tokens/char; Latin ~0.25 tokens/char). These defaults target a combined prompt under ~4000 tokens including system text, suitable for models with ≥8k token context windows. Operators using models with smaller context windows (e.g. 4k) should lower the ceiling via configuration.
- **ROUT-F07**: When `FindService` returns a `degraded` marker (semantic fell back to keyword, or scan truncated), the degradation reason is appended to the run record's `output` field (e.g. as a trailing `[degraded: ...]` line) but does not prevent execution. No schema change to `RoutineRunRecord` is required.

### G. Schedule-Aware Defaults

- **ROUT-G01**: When `recentActivityMinutes` is omitted from `routine-create`, the tool infers a default based on the cron schedule:
  - Hourly or more frequent → 60 minutes
  - Daily → 1440 minutes (24 hours)
  - Weekly → 10080 minutes (7 days)
  - Monthly → 43200 minutes (30 days)
  - The inference uses a heuristic on the cron expression (checking day-of-week field, day-of-month field, and hour field). The user can always override with an explicit value.
  - **Implementation note**: The current Zod schema uses `.default(60)` which prevents distinguishing "user omitted" from "user explicitly set 60". The schema must change to `.optional()` so the handler can detect omission and apply inference. When the user provides an explicit value, it is used as-is.
- **ROUT-G02**: `routine-create` no longer hardcodes `kind: 'daily_summary'`. The `kind` field is removed from `RoutineDefinition` and from the tool's input/output schemas.

### GP. Privacy & Secret Redaction

- **ROUT-GP01**: Before assembling evidence into the LLM prompt, the executor applies the same secret-redaction patterns used by `RemoteLlmSummaryProvider` (API keys, Bearer tokens, GitHub tokens, Slack tokens, etc.) to all `extractedText` content. Screen captures may contain secrets displayed in terminal output, config files, or environment variable dumps.
- **ROUT-GP02**: When privacy pause is active (the capture provider is paused via `privacy-control`), the executor must not send screen evidence to the LLM endpoint. It should fall back to template formatting and record the reason in the run output.

### H. LLM Client

- **ROUT-H01**: A shared `LlmClient` module is extracted, encapsulating: OpenAI-compatible `chat/completions` HTTP transport (request dispatch, response parsing), configurable timeout with `AbortController`, structured error codes (`NOT_CONFIGURED`, `TIMEOUT`, `PROVIDER_UNAVAILABLE`, `PARSE_FAILED`), and API-key redaction in logs. The module accepts a `messages` array and per-call options (`model`, `temperature`, `max_tokens`) so callers control prompt construction while sharing the transport. Both the routine executor and the existing `RemoteLlmSummaryProvider` consume this module.
- **ROUT-H02**: The `LlmClient` respects the existing `config.llm` configuration block (`base_url`, `api_key`, `model`) and `config.analysis.summary.remoteLlmTimeoutMs` for timeout.

### I. Bootstrap Wiring

- **ROUT-I01**: `src/bootstrap/create-app.ts` updates the executor construction site (currently lines 402–405): `DailySummaryExecutor` is replaced by `PromptDrivenExecutor`, which requires additional injected dependencies beyond the current `{ find, recall }`:
  - `LlmClient` instance (constructed from `config.llm`).
  - `PrivacyStateReader` (for ROUT-GP02 pause check; already available as `privacyState` in the bootstrap scope).
  - The `find` and `recall` dependencies remain unchanged.
- **ROUT-I02**: The import of `DailySummaryExecutor` from `../services/routines/executor.js` is replaced with the new executor import. No other bootstrap changes are required — the `RoutineScheduler` constructor and `AppContext.services.routines` shape stay the same (the scheduler accepts `RoutineExecutor` interface, not a concrete class).

### J. Delivery & Verification

- **ROUT-J01**: `docs/reference/tools.md` and `docs/zh/reference/tools.md` are updated to reflect the new `routine-create` schema (no `kind` field, `recentActivityMinutes` default inference, prompt-driven execution description).
- **ROUT-J02**: The `routine-create` output schema no longer includes `kind`. Existing persisted routine definitions that contain `kind: 'daily_summary'` continue to load without error (backward compatibility).

#### Test updates

- **ROUT-J03**: Test changes fall into three categories:

  **Category 1 — Kind fixture removal** (delete `kind` from test fixtures, no logic change):
  - `tests/unit/routines/scheduler.test.ts`
  - `tests/unit/routines/tools/routine-list.test.ts` — additionally add an assertion that the tool output does **not** contain a `kind` property (AC #11).
  - `tests/integration/routines/scheduler.test.ts`
  - `tests/integration/security/private-file-permissions.test.ts`

  **Category 2 — Schema and assertion updates** (update schemas, add new test cases):
  - `tests/unit/routines/tools/routine-create.test.ts` — remove `kind` assertion from output; add cases for schedule-aware `recentActivityMinutes` inference (AC #6–9); add case for explicit `recentActivityMinutes` override; verify `.optional()` behavior (omission vs explicit value).
  - `tests/contract/routine-tools-contract.test.ts` — remove `kind` enum from contract schemas; update `recentActivityMinutes` from required-with-default to optional in input schema; add backward-compat assertion that persisted definitions with `kind` load without error (AC #10).
  - `tests/integration/routines/routine-store.test.ts` — remove `kind` from all 6+ fixtures; add a dedicated test: store loads a definition JSON file containing `kind: 'daily_summary'` without error and the returned object has no `kind` property (AC #10).

  **Category 3 — Full rewrite / new test suites**:
  - `tests/unit/routines/executor.test.ts` — **rewrite entirely**. The current suite tests `DailySummaryExecutor` which is being replaced. The new suite tests `PromptDrivenExecutor` and must cover:
    - LLM execution path: mock `LlmClient.complete()`, verify prompt assembly includes user prompt + recall data + find evidence (AC #1).
    - Prompt differentiation: two definitions with different prompts produce different LLM calls (AC #2).
    - LLM fallback: when `LlmClient` is absent / not configured, executor falls back to template formatting (AC #3).
    - Evidence dedup: 100 identical `extractedText` items are collapsed to 1 in the assembled prompt (AC #4).
    - Context truncation: evidence exceeding the character ceiling is truncated (AC #5).
    - Degraded marker: `FindResult.degraded` info is appended to output (ROUT-F07).
    - Privacy pause: when `PrivacyStateReader` reports pause, executor falls back without sending evidence (AC #14).
    - Secret redaction: evidence containing API keys is redacted before LLM prompt assembly (AC #13).
  - **New**: `tests/unit/llm/llm-client.test.ts` (or similar path) — unit tests for the extracted `LlmClient` module:
    - Successful `chat/completions` call with response parsing.
    - `NOT_CONFIGURED` when `base_url` is missing.
    - `TIMEOUT` via `AbortController`.
    - `PROVIDER_UNAVAILABLE` on non-2xx HTTP.
    - `PARSE_FAILED` on malformed response body.
    - API-key redaction in error messages.
    - Verify `RemoteLlmSummaryProvider` and the routine executor both consume this module (AC #12 — can be a structural import check).

## Acceptance Criteria

The following must be true:

**Prompt-driven execution**

1. A routine created with `prompt: "list the apps I used most this week"` and `schedule: "0 9 * * 1"` (weekly Monday 9am) produces an output that references specific app names and usage patterns from the past 7 days, not a generic session count.
2. Two routines with different prompts but the same schedule produce different outputs when run against the same time window.
3. When `config.llm.base_url` is not set, the routine falls back to template formatting and the run record indicates the degraded mode.

**Evidence quality**

4. When the time window contains 100 consecutive frames with identical `extractedText`, the LLM prompt contains at most one copy of that text.
5. The evidence section of the LLM prompt does not exceed the configured character ceiling.

**Schedule-aware defaults**

6. `routine-create` with `schedule: "0 9 * * *"` (daily) and no explicit `recentActivityMinutes` stores `recentActivityMinutes: 1440`.
7. `routine-create` with `schedule: "*/30 * * * *"` (every 30 min) and no explicit `recentActivityMinutes` stores `recentActivityMinutes: 60`.
8. `routine-create` with `schedule: "0 9 * * 1"` (weekly) and no explicit `recentActivityMinutes` stores `recentActivityMinutes: 10080`.
9. `routine-create` with `schedule: "0 9 1 * *"` (monthly) and no explicit `recentActivityMinutes` stores `recentActivityMinutes: 43200`.

**Backward compatibility**

10. Persisted routine definitions containing `kind: 'daily_summary'` load without error after the migration.
11. The `routine-list` tool returns routine records that no longer include a `kind` field.

**Shared LLM client**

12. `RemoteLlmSummaryProvider` and the routine executor use the same `LlmClient` module for `chat/completions` calls.

**Privacy**

13. Evidence text sent to the LLM endpoint has secret patterns (API keys, tokens) redacted.
14. When privacy pause is active, the executor does not send screen evidence to any external endpoint.

**Degraded retrieval**

15. When `FindService` returns a `degraded` marker, the degradation reason appears in the run record's `output` field.

## Out of Scope

| Item | Reason |
|---|---|
| Semantic (vector) retrieval in executor | Keyword mode is sufficient for v2; semantic has performance concerns on large windows. Add after real usage data validates demand. |
| ANN indexing for vector store | Optimization for a specific bottleneck not yet hit by this feature. |
| Retrieval-layer dedup / compression abstraction | Build in-executor, extract if a second consumer emerges. |
| Follow-up chat on routine output | Requires MCP resources or conversation-state features not in scope. |
| Routine templates / presets | Can be added as a Dashboard UI feature later without backend changes — the executor is fully prompt-driven. |
| Manual trigger of routine execution (ROUT-F01) | Remains in [future-backlog.md](./future-backlog.md). |
| MCP routine resources (ROUT-F02) | Remains in future-backlog. |
| Cross-machine sync (ROUT-F04) | Remains in future-backlog. |

## Dependencies & Ordering

- **Prerequisite**: None. The retrieval services (`FindService`, `RecallService`) and LLM configuration (`config.llm`) are already in production.
- **Internal ordering**: H (LLM client extraction) → E (executor rewrite) + I (bootstrap wiring) → F (evidence quality) + G (defaults) → J (docs & tests).
- **Supersedes**: This spec absorbs `ROUT-F03` ("arbitrary LLM-backed prompt routines") from [future-backlog.md](./future-backlog.md). Upon completion, `ROUT-F03` should be marked as delivered and removed from the future-backlog pool.

## Implementation Notes (non-normative)

### Executor Architecture

```
RoutineDefinition { prompt, schedule, recentActivityMinutes }
                ↓
        PromptDrivenExecutor
                ↓
   ┌────────────┴────────────┐
   │                         │
RecallService.recall()    FindService.find()
  sessions + summaries     keyword evidence
   │                         │
   └──────────┬──────────────┘
              ↓
    dedup + truncate + assemble
              ↓
       ┌──────┴──────┐
       │             │
   LLM configured?  No → template fallback
       │
  LlmClient.complete()
       │
  RoutineExecutionResult { summary, output }
```

### LLM Prompt Structure

```
System: You are a work analysis assistant. Based on the following two
data sources, answer the user's request:
1. Activity overview — session statistics for the time window
2. Relevant evidence — screen text fragments matching the request
Prioritize evidence content; use activity overview for context.
Respond in the same language as the user's request.

User:
Request: ${definition.prompt}
Time window: ${from} to ${to}

=== Activity Overview (${sessions.length} sessions) ===
${truncated session list}

=== Relevant Evidence (${evidence.length} items) ===
${deduped and truncated evidence}
```

### Schedule Inference Heuristic

```typescript
function inferRecentActivityMinutes(cron: string): number {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.split(' ');
  if (dayOfWeek !== '*') return 10080;   // weekly (includes weekday-only like "1-5")
  if (dayOfMonth !== '*') return 43200;  // monthly (30 days)
  if (hour !== '*') return 1440;         // daily (includes multi-daily like "*/6")
  return 60;                             // sub-daily
}
```

This heuristic is intentionally simple — it uses the coarsest matching granularity. Edge cases: `0 */6 * * *` (every 6 hours) maps to daily (1440 min) rather than 360 min; `0 9 * * 1-5` (weekdays) maps to weekly (10080 min). These are conservative over-estimates that ensure the look-back window always covers at least one full cycle. The user can override with an explicit `recentActivityMinutes` for any edge case.

### Keyword Extraction from Prompt

For `FindService.find({ query })`, the executor passes `definition.prompt` directly as the query string. `FindService`'s keyword mode performs NFC + locale-aware case folding and substring matching — this is sufficient for prompts containing concrete terms ("Slack", "competitor", "meeting notes"). Prompts that are purely abstract ("what should I focus on") will match few frames via keyword, but the activity overview from recall still provides useful context for the LLM.

### Migration Path for `RoutineKind`

All code locations that reference `RoutineKind` or hardcode `'daily_summary'` must be updated atomically:

| File | Location | Change |
|---|---|---|
| `src/services/routines/types.ts` | `RoutineKind` type, `RoutineDefinition.kind` | Remove type and field |
| `src/services/routines/routine-store.ts` | `isRoutineKind()` guard, `parseDefinition()`, `writeDefinition()` line 222 | Remove kind validation and write; tolerate and discard `kind` in persisted JSON |
| `src/mcp/tools/routine-create.ts` | line 105 hardcode, output schema `kind` enum | Remove hardcode and schema field |
| `src/mcp/tools/routine-list.ts` | output schema `kind` field, response mapping | Remove schema field |
| `src/dashboard/routes/routines.ts` | line 101 hardcode `kind: 'daily_summary'`, `recentActivityMinutes` default | Remove kind; apply schedule-aware default inference |
| `docs/zh/reference/tools.md` | routine-list / routine-create output descriptions mentioning `kind` | Remove `kind` from field lists |
| `docs/reference/tools.md` | routine tool documentation | Remove `kind` references |
| `tests/unit/routines/executor.test.ts` | fixture `kind: 'daily_summary'` | Remove `kind` from test fixtures |
| `tests/unit/routines/scheduler.test.ts` | fixture `kind: 'daily_summary'` | Remove `kind` from test fixtures |
| `tests/unit/routines/tools/routine-create.test.ts` | assertion on `kind` in output | Remove `kind` assertions |
| `tests/unit/routines/tools/routine-list.test.ts` | fixture and assertion on `kind` | Remove `kind` from fixtures and assertions |
| `tests/contract/routine-tools-contract.test.ts` | schema `kind` enum, fixture `kind` values | Remove `kind` from contract schemas and fixtures |
| `tests/integration/routines/routine-store.test.ts` | fixture `kind: 'daily_summary'` (6+ occurrences) | Remove `kind` from test fixtures |
| `tests/integration/routines/scheduler.test.ts` | fixture `kind: 'daily_summary'` | Remove `kind` from test fixtures |
| `tests/integration/security/private-file-permissions.test.ts` | fixture `kind: 'daily_summary'` | Remove `kind` from test fixtures |
| `tests/acceptance/dashboard-http.test.ts` | routines API assertions | Verify response no longer contains `kind` (if schema-checked) |
| `src/bootstrap/create-app.ts` | lines 5, 402–405: `DailySummaryExecutor` import and construction | Replace with `PromptDrivenExecutor`; inject `LlmClient` + `PrivacyStateReader` |

**Critical ordering**: `parseDefinition()` in `routine-store.ts` currently calls `isRoutineKind(kind)` and rejects definitions where `kind` is absent or unrecognized. The parser update must land in the same commit as the type change — otherwise new definitions written without `kind` will fail to load.

Persisted definitions are not rewritten — the stale `kind` field in existing JSON files is simply ignored on read.

### Superseded Constraints

The Routines MVP imposed `ROUT-08`: "daily_summary must be deterministic — no LLM calls allowed" (see `executor.ts` line 7 comment). This spec explicitly supersedes that constraint by introducing LLM-backed execution as the primary path, with the deterministic template as the fallback when no LLM is configured.
