---
doc_version: 5
doc_status: active
last_updated: 2026-06-01
---

# MCP Tools

The server currently registers nine MCP tools. This document describes the public tool surface, input schemas, and output expectations for client integrators.

## Result shape

Most tools return both:

- `content`: human-readable text for agent display
- `structuredContent`: machine-readable JSON for downstream automation

Some failure paths also set `isError: true`.

Work-activity retrieval tools (`find`, `recall`, `inspect`) always emit a `narrativeText` string field in the structured payload — even on degraded paths — so callers never have to branch on `null` for the natural-language summary. They surface degraded state through an explicit `degraded` block when fallback behavior occurred.

## Tool inventory

| Tool | Category | Description |
|------|----------|-------------|
| `find` | work-activity | Search captured work-activity content for evidence fragments by keyword, semantic similarity, or hybrid mode |
| `recall` | work-activity | Recall sessions or aggregated time blocks for a window, with optional summaries |
| `inspect` | work-activity | Drill down into a single session or frame, returning evidence rows or the raw AX tree |
| `memory-read` | memory | Read persisted long-term memory by scope |
| `memory-write` | memory | Append or replace long-term memory content |
| `file-analyze` | file-analysis | Analyze a supported local file and summarize or answer a targeted question |
| `privacy-control` | privacy | Check or modify local privacy collection controls |
| `screenpipe-control` | screenpipe | Check, start, or stop the local Screenpipe recording process |
| `internal-status` | internal | Return bootstrap-safe runtime status |

## `find`

Search captured work-activity content for evidence fragments. `mode="keyword"` is the default and runs an FTS5 keyword scan over `extracted_content`; `semantic` runs a vector query over the embedding hash index; `hybrid` merges both with a deterministic ranker.

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
- `structuredContent.sessions` is present when `granularity="session"`. Each session item exposes `sessionId`, `appName`, `contextLabel`, `startedAt`, `endedAt`, `activeSeconds`, `evidenceFrameIds`, `sourceTypes`, and optional `summary` (`text`, `status` ∈ `pending` | `ready` | `failed` | `degraded` | `not_applicable`, `providerKind` ∈ `template` | `remote-llm`)
- `structuredContent.blocks` is present when `granularity="hour"` or `"day"`. Each block exposes `start`, `end`, `sessionCount`, `totalActiveSeconds`, `byApp` (record of `appName -> seconds`), `narrativeText`
- `structuredContent.narrativeText` is always present

## `inspect`

Drill down into a single session or frame. Pick the target by passing exactly one of `sessionId` or `frameId` inside `target`.

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
| `action` | `status` \| `pause` \| `resume` \| `exclude-app` \| `delete-range` | yes | Operation to perform |
| `appName` | string | no | Used with `exclude-app` |
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
  "configFile": "~/.canary-alpha-mcp/config.yaml",
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

The response also carries the capture/ingestion observability blocks (`capture`, `ingestionMix`, `diskBudget`) and a `workActivity` block summarising the derived-store health (session counts, summary worker state, embedding hash index size). See [../troubleshooting.md#capture--ingestion-observability](../troubleshooting.md#capture--ingestion-observability) for the failure-mode reference.

This tool is the primary health probe used by `npm run service:status`.

## Compatibility notes

- The official v1 delivery surface is Streamable HTTP at `http://127.0.0.1:<port>/mcp`
- Stdio still exists for compatibility and tests, but it is not the primary public delivery path
- The legacy `search-screen` and `recent-activity` retrieval tools were removed; their forward replacements are `find`, `recall`, and `inspect`
- Acceptance tests exercise real tool calls for retrieval, privacy, memory, and HTTP flows

## Related docs

- [../../README.md](../../README.md)
- [configuration.md](./configuration.md)
- [../clients/generic-mcp.md](../clients/generic-mcp.md)
- [../troubleshooting.md](../troubleshooting.md)
