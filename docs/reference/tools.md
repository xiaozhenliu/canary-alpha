---
doc_version: 12
doc_status: active
last_updated: 2026-09-04
---

# MCP Tools

The server currently registers twelve MCP tools. This document describes the public tool surface, input schemas, and output expectations for client integrators.

## Result shape

Most tools return both:

- `content`: human-readable text for agent display
- `structuredContent`: machine-readable JSON for downstream automation

Some failure paths also set `isError: true`.

Work-activity retrieval tools (`find`, `recall`, `inspect`) always emit a `narrativeText` string field in the structured payload — even on degraded paths — so callers never have to branch on `null` for the natural-language summary. They surface degraded state through an explicit `degraded` block when fallback behavior occurred.

The `from` / `to` time-window bounds on `find` and `recall` are interpreted as **absolute instants and compared in UTC**. A UTC `Z` bound (e.g. `2026-04-16T00:00:00Z`) therefore matches captured records correctly regardless of the recorder's local timezone offset; you may also pass an offset form (`+08:00`) and it resolves to the same instant.

## Tool inventory

| Tool | Category | Onboarding | Description |
|------|----------|:---:|-------------|
| `find` | work-activity | ✓ | Search captured work-activity content for evidence fragments by keyword, semantic similarity, or hybrid mode |
| `recall` | work-activity | ✓ | Recall sessions or aggregated time blocks for a window, with optional summaries |
| `inspect` | work-activity | ✓ | Drill down into a single session or frame, returning evidence rows or the raw AX tree |
| `memory-read` | memory | ✓ | Read persisted long-term memory by scope |
| `memory-write` | memory | ✓ | Append or replace long-term memory content |
| `file-analyze` | file-analysis | ✓ | Analyze a supported local file and summarize or answer a targeted question |
| `privacy-control` | privacy | ✓ | Check or modify local privacy collection controls |
| `screenpipe-control` | screenpipe | — | Check, start, or stop the local Screenpipe recording process |
| `internal-status` | internal | ✓ | Return bootstrap-safe runtime status |
| `routine-list` | routines | ✓ | List all configured local routines with their schedule, enabled state, and latest run summary |
| `routine-create` | routines | — | Create a new local routine or update an existing one by name |
| `routine-history` | routines | ✓ | Return the execution history of a named routine, newest first |

## `find`

Search captured work-activity content for evidence fragments. `mode="keyword"` is the default and runs an FTS5 keyword scan over `extracted_content`; `semantic` runs a vector query over the embedding hash index; `hybrid` merges both with a deterministic ranker. AXTree-derived evidence preserves semantic prefixes: `[Window]` for window/document identity, `[Nav]` for tabs, breadcrumbs, channels, and chat partners, `[Action]` for visible menus and dialogs, and `[Body]` for primary content and input.

**Input**

```json
{
  "query": "budget planning",
  "mode": "hybrid",
  "appName": "Calendar",
  "from": "2026-04-16T00:00:00Z",
  "to": "2026-04-16T23:59:59Z",
  "limit": 20,
  "groupBy": "session"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `query` | string | yes | NFC-normalized, 1–512 chars after trimming |
| `mode` | `keyword` \| `semantic` \| `hybrid` | no | Defaults to `keyword` |
| `appName` | string | no | Optional exact-match application filter |
| `from` | string | no | Optional ISO-8601 lower bound (inclusive) |
| `to` | string | no | Optional ISO-8601 upper bound (inclusive) |
| `limit` | positive integer up to 100 | no | Defaults to `20` |
| `groupBy` | `session` | no | When set, the response includes a `groupedBySession` array |

**Output expectations**

- `content[0].text` carries the `narrativeText` summary (or a fallback message)
- `structuredContent.data` is the array of evidence items: `frameId`, `sessionId?`, `appName?`, `contextLabel`, `extractedText`, `timestamp`, `matchSource` (`keyword` | `semantic`), optional `score`, `sourceTypes`
- `structuredContent.groupedBySession` (optional) groups items by session when `groupBy="session"` was requested
- `structuredContent.narrativeText` is always present
- `structuredContent.degraded` (optional) signals that the actual mode differed from the requested mode (e.g., semantic→keyword fallback) or that a keyword scan truncated; carries `requestedMode`, `actualMode`, `reason`
- AXTree evidence is session-scoped line deltas: an unchanged tagged line is stored only once in the active context, while newly appeared or changed lines remain searchable. A new session begins with a fresh full context after the idle boundary.

## `recall`

Recall captured work-activity sessions or aggregated time blocks for a window. `granularity="session"` lists sessions; `hour` / `day` bucket sessions by time. `includeSummary` defaults to `true`, attaching a per-session summary.

**Input**

```json
{
  "from": "2026-04-16T00:00:00Z",
  "to": "2026-04-16T23:59:59Z",
  "granularity": "session",
  "appName": "Cursor",
  "includeSummary": true
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `from` | string | yes | ISO-8601 lower bound (inclusive) |
| `to` | string | yes | ISO-8601 upper bound (inclusive) |
| `granularity` | `session` \| `hour` \| `day` | no | Defaults to `session` |
| `appName` | string | no | Optional exact-match application filter |
| `includeSummary` | boolean | no | Defaults to `true` |

**Output expectations**

- `content[0].text` carries the `narrativeText` summary
- `structuredContent.granularity` echoes the resolved granularity
- `structuredContent.sessions` is present when `granularity="session"`. Each session item exposes `sessionId`, `appName`, `contextLabel`, `startedAt`, `endedAt`, `activeSeconds` (integer whole seconds), `evidenceFrameIds`, `sourceTypes`, and optional `summary` (`text`, `status` ∈ `pending` | `ready` | `failed` | `degraded` | `not_applicable`, `providerKind` ∈ `template` | `remote-llm`)
- `structuredContent.blocks` is present when `granularity="hour"` or `"day"`. Each block exposes `start`, `end`, `sessionCount`, `totalActiveSeconds` (integer whole seconds), `byApp` (record of `appName -> integer seconds`), `narrativeText`
- `structuredContent.narrativeText` is always present

## `inspect`

Drill down into a single session or frame. Pick the target by passing exactly one of `sessionId` or `frameId` inside `target`. For AXTree-derived frames, `extractedContent.extractedText` contains the same `[Window]`, `[Nav]`, `[Action]`, and `[Body]` lines emitted by structured extraction, subject to session-scoped delta deduplication.

**Input**

```json
{ "target": { "sessionId": "session-1" } }
```

```json
{ "target": { "frameId": 42 } }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `target.sessionId` | string | one-of | Session UUID/ID |
| `target.frameId` | string \| number | one-of | ScreenPipe frame id (numeric upstream, accepted as string for client convenience) |

**Output expectations**

- `structuredContent.kind` is `'session'` or `'frame'`
- For `kind="session"`: `session` (the session row, may be `null` if not found), `evidence` (per-frame `extracted_content` rows), and `narrativeText`
- For `kind="frame"`: `frame` (`frameId`, `timestamp`, optional `appName` / `windowName`, `accessibilityTreeJson` — raw AX tree as a JSON string, or `null` when unavailable), `extractedContent` (the derived row, or `null` if extraction has not run for that frame), and `narrativeText`
- Failure paths return `isError: true`, the structured `kind="session"` shape with `session: null`, `evidence: []`, and a diagnostic `narrativeText`

## `memory-read`

Read persisted long-term memory.

**Input**

```json
{
  "scope": "all"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `scope` | `memory` \| `user` \| `all` | no | Defaults to `all` |

**Output expectations**

- `structuredContent.scope` echoes the resolved scope
- `structuredContent.content` contains the selected text content
- `structuredContent.memory` and `structuredContent.user` are included for `all`

## `memory-write`

Append or replace persisted long-term memory.

**Input**

```json
{
  "scope": "memory",
  "content": "Remember that the user prefers concise output.",
  "mode": "append"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `scope` | `memory` \| `user` | no | Defaults to `memory` |
| `content` | string | yes | Minimum length 1 |
| `mode` | `append` \| `replace` | no | Defaults to `append` |

**Output expectations**

- `content[0].text` states whether content was appended or replaced
- `structuredContent` returns `scope`, `mode`, and final `content`

## `file-analyze`

Analyze a supported local file.

**Input**

```json
{
  "path": "/absolute/path/to/file.md",
  "question": "What are the main action items?"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | string | yes | Local file path |
| `question` | string | no | Optional focused question |

**Output expectations**

- On success, `structuredContent` includes `summary`, optional `answer`, `highlights`, `evidence`, and `file`
- On failure, `isError: true` and `structuredContent.error` describe the problem
- Binary content is rejected as unsupported text input

## `privacy-control`

Inspect or modify privacy collection controls.

Local operators can also use the focused CLI wrapper for the existing MCP tool instead of hand-crafting MCP payloads:

```bash
npm run privacy-control -- status
npm run privacy-control -- pause
npm run privacy-control -- resume
npm run privacy-control -- exclude-app --app "Claude"
npm run privacy-control -- exclude-app --app "Claude" --rebuild
npm run privacy-control -- remove-excluded-app --app "Claude"
```

The CLI prints only paused state, excluded app names, and actionable validation errors so the terminal output does not expose unrelated retrieved content. `--rebuild` reuses the existing `rebuild-index` workflow after updating the exclusion so operators can clear already-indexed plaintext for the newly excluded app.

**Input**

```json
{
  "action": "exclude-app",
  "appName": "Messages"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `action` | `status` \| `pause` \| `resume` \| `exclude-app` \| `remove-excluded-app` \| `delete-range` | yes | Operation to perform |
| `appName` | string | no | Used with `exclude-app` and `remove-excluded-app` |
| `range` | `last_1h` \| `last_1d` \| `all` | no | Used with `delete-range` |
| `confirm` | boolean | no | Confirmation flag for destructive delete-range actions |

**Output expectations**

- `structuredContent.paused` reports whether collection is paused
- `structuredContent.excludedApps` lists excluded applications
- `structuredContent.allowedDeleteRanges` lists valid delete ranges
- `structuredContent.confirmationHint` explains when confirmation is required
- For `delete-range`, `structuredContent.cascade` reports the derived-store cascade outcome: `upstreamDeleted` (count of upstream rows removed), `cascade` (`ok` | `partial` | `failed`), optional `failedFrameIds`, and optional `reason`. While a cascade-failure tombstone is active, `find` and `recall` filter out evidence/sessions that fall inside the affected window until the next `reconcileCascadeFailures()` pass clears it
- Failure paths set `isError: true`

## `screenpipe-control`

Check, start, or stop the local Screenpipe recording process managed by this server.

**Input**

```json
{
  "action": "status"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `action` | `status` \| `start` \| `stop` | yes | Operation to perform |

**Output expectations**

- `content[0].text` always includes the requested `action` and resolved `running` state
- `pid` is included when the server started the active Screenpipe process
- `error` is included when the operation cannot be completed
- `stop` only terminates a Screenpipe process started by this MCP server

## `internal-status`

Return bootstrap-safe runtime status.

**Input**

```json
{}
```

**Structured output**

```json
{
  "status": "ok",
  "mode": "http",
  "host": "127.0.0.1",
  "port": 18765,
  "pid": 12345,
  "configFile": "~/.computer-history-mcp/config.yaml",
  "retrieval": {
    "checkpointExists": true,
    "checkpointTimestamp": "2026-04-16T12:00:00.000Z",
    "vectorStoreKind": "chroma",
    "recoveryStatus": "ready"
  }
}
```

`recoveryStatus` is one of:

- `ready`
- `needs-rebuild`
- `degraded`

The response also carries the capture/ingestion observability blocks (`capture`, `ingestionMix`, `diskBudget`) and a `workActivity` block summarising the derived-store health (session counts, summary worker state, embedding hash index size). See [Troubleshooting: Capture & ingestion observability](/guide/troubleshooting#capture--ingestion-observability) for the failure-mode reference.

This tool is the primary health probe used by `npm run service:status`.

## `routine-list`

List all configured local routines. Optionally filter to only enabled or only disabled routines. Returns each routine's schedule, enabled state, prompt, recent-activity window, timestamps, and the most recent run summary when one exists.

**Input**

```json
{
  "enabled": true
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `enabled` | boolean | no | When provided, filters to routines whose `enabled` field matches this value |

**Output expectations**

- `structuredContent.routines` is an array of routine objects. Each item exposes `name`, `schedule`, `enabled`, `prompt`, `recentActivityMinutes`, `createdAt`, `updatedAt`, and optional `latestRun` (`runId`, `startedAt`, `completedAt`, `status` ∈ `success` | `failed` | `skipped`, `summary`)
- `structuredContent.total` is the count of returned routines
- `content[0].text` is a brief narrative summary (e.g. "3 routine(s) configured.")
- Failure paths return `isError: true` with `structuredContent: { routines: [], total: 0 }`

## `routine-create`

Create a new local routine or update an existing one by name. The schedule must be a valid 5-field cron expression. The name is normalized to a filesystem-safe slug (lowercase alphanumeric with hyphens). If the scheduler is running, the new or updated definition is picked up immediately without a server restart.

**Input**

```json
{
  "name": "morning standup",
  "prompt": "Summarize yesterday's work activity for the standup.",
  "schedule": "0 9 * * 1-5",
  "enabled": true,
  "recentActivityMinutes": 480
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string (min 1) | yes | Normalized to lowercase alphanumeric with hyphens |
| `prompt` | string (min 1) | yes | Prompt executed by the routine executor |
| `schedule` | string (min 1) | yes | 5-field cron expression (e.g. `"0 8 * * *"` for daily at 08:00) |
| `enabled` | boolean | no | Defaults to `true` |
| `recentActivityMinutes` | positive integer | no | Look-back window in minutes. When omitted, inferred from schedule frequency: hourly→60, daily→1440, weekly→10080, monthly→43200. Explicit values always override inference. |

**Output expectations**

- `structuredContent.routine` returns the persisted definition: `name`, `schedule`, `enabled`, `prompt`, `recentActivityMinutes`, `createdAt`, `updatedAt`
- `structuredContent.isNew` is `true` when the routine was created, `false` when an existing routine was updated
- `content[0].text` states whether the routine was created or updated (e.g. `Routine "morning-standup" created.`)
- Failure paths (invalid cron, empty name, store error) return `isError: true`

## `routine-history`

Return the execution history of a named routine, newest first. Each record includes run status, timing, and the output or error message. The `name` parameter is matched exactly against the stored (normalized) routine name.

**Input**

```json
{
  "name": "morning-standup",
  "limit": 5
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string (min 1) | yes | Routine name to look up (as stored after normalization) |
| `limit` | positive integer up to 100 | no | Defaults to `10` |

**Output expectations**

- `structuredContent.name` echoes the requested routine name
- `structuredContent.runs` is the array of run records, newest first. Each record exposes `runId`, `name`, `startedAt`, `completedAt`, `status` ∈ `success` | `failed` | `skipped`, `summary`, `output`, and optional `error` (`message`)
- `structuredContent.total` is the count of returned records
- `content[0].text` is a brief narrative (e.g. `5 run record(s) for routine "morning-standup".`)
- When no history exists, `runs` is empty and the narrative says so
- Failure paths return `isError: true` with `structuredContent: { name, runs: [], total: 0 }`

## Compatibility notes

- The official v1 delivery surface is Streamable HTTP at `http://127.0.0.1:<port>/mcp`
- Stdio still exists for compatibility and tests, but it is not the primary public delivery path
- The legacy `search-screen` and `recent-activity` retrieval tools were removed; their forward replacements are `find`, `recall`, and `inspect`
- Acceptance tests exercise real tool calls for retrieval, privacy, memory, and HTTP flows

## Related docs

- [Configuration](/reference/configuration) — Configuration reference
- [Generic MCP Client](/guide/clients/generic-mcp) — Transport and first-call guide
- [Troubleshooting](/guide/troubleshooting) — Symptom-based diagnosis
