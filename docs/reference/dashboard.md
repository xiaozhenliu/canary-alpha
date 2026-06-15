---
doc_version: 1
doc_status: active
last_updated: 2026-06-15
---

# Dashboard

`canary-alpha-mcp` ships an embedded web dashboard for local operators. It provides browser-based status monitoring, configuration management, routines control, activity browsing, privacy management, and log viewing — all without leaving your browser.

The dashboard is **not** a product feature surface. It does not replace MCP tools for agent use. It is an operator-facing management panel that visualizes and interacts with the same underlying services that MCP tools expose.

## Accessing the dashboard

When the server runs in HTTP mode, the dashboard is available at:

```
http://127.0.0.1:<port>/
```

The default port is `18765`, so the typical URL is `http://127.0.0.1:18765/`.

The dashboard is served from the same HTTP endpoint as the MCP protocol — no separate process or port is needed. Route priority:

1. `/mcp` — MCP protocol (JSON-RPC over Streamable HTTP)
2. `/api/*` — Dashboard REST API (Bearer token auth)
3. All other paths — SPA static files (`dist/dashboard/`)

::: tip
The dashboard is only available when the server runs in `http` mode. In `stdio` mode there is no HTTP listener, so the dashboard is not accessible.
:::

## Authentication

All `/api/*` endpoints require a Bearer token. The token is the `server.authToken` value from your `config.yaml`:

```yaml
server:
  authToken: "your-secret-token"
```

The dashboard UI reads the token from the browser and injects it into every API request as an `Authorization: Bearer <token>` header.

**Fail-closed behavior**: if `server.authToken` is not configured, all API requests are rejected with `401 Unauthorized`. This is by design — the dashboard will not function without an auth token.

::: warning
The auth token is a shared secret between you and the server. Do not expose it in public configs or version control. `npm run onboard` generates a random token automatically.
:::

## Pages

The dashboard has six page modules. Each module maps to a sidebar entry and a dedicated set of API endpoints.

### Status

**Route**: `/`

The default landing page. Shows a grid of status cards with live server health:

| Card | Information |
|------|-------------|
| **Server** | Mode, host:port, PID, uptime, config file path |
| **Capture** | Capture provider, liveness state (ok / idle / permissions-missing / unavailable), latest frame timestamp |
| **Retrieval** | Checkpoint timestamp, vector store kind, recovery status, embedding hash index size |
| **Ingestion Mix** | Source type distribution over the past 24 hours (AX / OCR ratio) |
| **Disk Budget** | Screenpipe database size, budget usage, dominant table proportions |
| **Work Activity** | Extraction count, session count, summary worker state |
| **Providers** | Embedding provider kind, model, status |

Degraded subsystems are highlighted with a warning badge and reason text. Data auto-refreshes every 30 seconds; click **Refresh** for an immediate update.

### Config

**Route**: `/config`

A schema-driven configuration editor. The form is automatically generated from the server's Zod config schema — when new config fields are added to the schema, they appear in the dashboard without any UI code changes.

Features:

- All config sections displayed with collapse/expand (server, logging, capture, screenpipe, providers, vectorStore, retrieval, routines, trim, storage, privacy, analysis, llm, paths)
- Each field shows: current value, schema default, description, and whether it is overridden by an environment variable
- Sensitive fields (`apiKey`, `authToken`) are masked by default; click to reveal
- Inline validation against JSON Schema before saving
- Saves directly to `config.yaml` with AST-preserving write (comments and formatting are kept)

::: info
Config changes are written to disk but require a service restart to take effect. The page displays a reminder after each save.
:::

### Routines

**Route**: `/routines`

Lists all configured routines with their schedule, enabled state, and latest run status.

- **Create**: define a new routine with name, cron schedule (presets available: daily at 08:00, hourly, weekdays at 09:00, or custom), and enabled flag
- **Toggle**: enable or disable individual routines via a switch
- **History**: view execution history timeline for any routine — each entry shows run ID, timestamp, status (success / failed / skipped), and summary

### Activity

**Route**: `/activity`

Browse work-activity sessions as a timeline, with search capabilities.

- **Session timeline**: shows app name, context label, start/end time, active duration, and summary for each session
- **Filters**: date range picker and app name filter
- **Search panel**: enter a query and choose search mode (keyword, semantic, or hybrid) to find matching content across indexed frames — results show extracted text, relevance score, app name, and timestamp

### Privacy

**Route**: `/privacy`

View and manage privacy controls.

- **Pause / Resume**: toggle capture collection on or off
- **Excluded apps**: view the current exclusion list; add or remove apps
- **Delete range**: trigger data deletion for a specified time range (requires confirmation)

### Logs

**Route**: `/logs`

Tail the server log file with structured formatting.

- Shows the most recent 200 log entries
- Filter by log level: debug, info, warn, error
- Structured JSON entries are parsed and displayed with timestamp, level, message, and metadata; non-JSON lines are shown as-is
- Auto-refreshes every 15 seconds

## REST API endpoints

The dashboard communicates with the server through these REST endpoints. All require `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Server status (same data as `internal-status` tool) |
| `GET` | `/api/config` | List all config entries with provenance |
| `GET` | `/api/config/schema` | JSON Schema for the full config |
| `GET` | `/api/config/effective` | Current effective config values |
| `PUT` | `/api/config/:path` | Update a config field |
| `GET` | `/api/routines` | List all routines |
| `POST` | `/api/routines` | Create a new routine |
| `GET` | `/api/routines/:name/history` | Execution history for a routine |
| `GET` | `/api/activity/sessions` | Work-activity sessions (supports `from`, `to`, `app` query params) |
| `POST` | `/api/activity/search` | Semantic / keyword / hybrid search |
| `GET` | `/api/privacy` | Current privacy status |
| `POST` | `/api/privacy/action` | Execute a privacy action (pause, resume, exclude-app, delete-range) |
| `GET` | `/api/logs` | Recent log entries (supports `limit`, `level` query params) |

## Relationship to CLI and MCP tools

The dashboard, the config CLI, and MCP tools are three interfaces to the same underlying services:

| Interface | Audience | Transport |
|-----------|----------|-----------|
| MCP tools | AI agents | JSON-RPC over stdio or Streamable HTTP |
| Config CLI | Terminal operators | Direct process invocation |
| Dashboard | Browser operators | REST API over HTTP |

They share the same data stores and service instances. Changes made through any interface are visible to the others (after restart for config changes).
