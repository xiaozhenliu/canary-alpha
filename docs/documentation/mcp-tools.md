---
doc_version: 3
doc_status: active
last_updated: 2026-04-18
---

# MCP Tools

The server currently registers seven MCP tools. This document describes the public tool surface, input schemas, and output expectations for client integrators.

## Result shape

Most tools return both:

- `content`: human-readable text for agent display
- `structuredContent`: machine-readable JSON for downstream automation

Some failure paths also set `isError: true`.

Retrieval tools include actionable degraded or recovery information in both the text summary and the structured payload.

## Tool inventory

| Tool | Category | Description |
|------|----------|-------------|
| `search-screen` | retrieval | Search indexed screen history with natural language and optional filters |
| `recent-activity` | retrieval | Retrieve recent activity from local screen history |
| `memory-read` | memory | Read persisted long-term memory by scope |
| `memory-write` | memory | Append or replace long-term memory content |
| `file-analyze` | file-analysis | Analyze a supported local file and summarize or answer a targeted question |
| `privacy-control` | privacy | Check or modify local privacy collection controls |
| `internal-status` | internal | Return bootstrap-safe runtime status |

## `search-screen`

Search indexed screen history.

**Input**

```json
{
  "query": "calendar note",
  "mode": "hybrid",
  "appName": "Calendar",
  "from": "2026-04-16T00:00:00Z",
  "to": "2026-04-16T23:59:59Z"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `query` | string | yes | Natural-language query, minimum length 1 |
| `mode` | `semantic` \| `keyword` \| `hybrid` | no | Defaults to `hybrid` |
| `appName` | string | no | Optional application filter |
| `from` | string | no | Optional lower time bound |
| `to` | string | no | Optional upper time bound |

**Output expectations**

- `content[0].text` contains a summary and freshness note, or an actionable error message
- `structuredContent.summary` contains the main summary
- `structuredContent.evidence` contains supporting records
- `structuredContent.freshness` reports freshness status
- `structuredContent.degraded` / `structuredContent.error` may explain fallback or rebuild action

## `recent-activity`

Retrieve recent screen activity.

**Input**

```json
{
  "minutes": 60,
  "format": "summary"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `minutes` | positive integer up to 1440 | no | Defaults to `60` |
| `format` | `summary` \| `raw` | no | Defaults to `summary` |

**Output expectations**

- `content[0].text` summarizes activity and freshness
- `structuredContent.summary` contains the summary form
- `structuredContent.raw` is available when raw mode is requested
- `structuredContent.evidence`, `freshness`, and `error` mirror retrieval state

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
- Failure paths set `isError: true`

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

This tool is the primary health probe used by `npm run service:status`.

## Compatibility notes

- The official v1 delivery surface is Streamable HTTP at `http://127.0.0.1:<port>/mcp`
- Stdio still exists for compatibility and tests, but it is not the primary public delivery path
- Acceptance tests exercise real tool calls for retrieval, privacy, memory, and HTTP flows

## Related docs

- [../../README.md](../../README.md)
- [configuration.md](./configuration.md)
- [../clients/generic-mcp.md](../clients/generic-mcp.md)
- [../troubleshooting.md](../troubleshooting.md)
