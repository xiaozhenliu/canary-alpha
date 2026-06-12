---
doc_version: 8
doc_status: active
last_updated: 2026-06-12
---

# Configuration

`canary-alpha-mcp` reads its runtime config from `~/.canary-alpha-mcp/config.yaml`.

Use `npm run onboard` for the MCP-layer first-run path after your local Screenpipe API is already healthy. It creates or replaces the app config using the standard v1 defaults, backs up any existing app config first, builds the project, starts the managed service, validates the live local MCP endpoint, and writes the validated `canary-alpha-mcp` server into Hermes config. `npm run setup` is still available when you want the app config/log directory without running the full onboarding flow.

## Config file location

- Config file: `~/.canary-alpha-mcp/config.yaml`
- App home: `~/.canary-alpha-mcp/`
- Logs: `~/.canary-alpha-mcp/logs/`
- Screenpipe safe-record maintenance log: `~/.canary-alpha-mcp/logs/screenpipe-maintenance.jsonl` with 7-day pruning and 1 MB rotation to `screenpipe-maintenance.jsonl.1`
- Automatic app-config backups created by `npm run onboard`: `~/.canary-alpha-mcp/config.backup-YYYYMMDD-HHMMSS.yaml`
- Hermes config updated by `npm run onboard`: `~/.hermes/config.yaml`

If you have already finished onboarding and want to change embedding settings later, edit `~/.canary-alpha-mcp/config.yaml` directly, then restart the managed service with `npm run service:stop && npm run service:start`.

## Default first-run behavior

`npm run onboard` assumes these defaults unless it has to ask for hosted-provider credentials:

```yaml
server:
  mode: http
  host: 127.0.0.1
  port: 18765

logging:
  level: info

screenpipe:
  url: http://localhost:3030

providers:
  embeddings:
    kind: ollama
    baseUrl: http://localhost:11434/v1
    model: nomic-embed-text

vectorStore:
  kind: chroma

retrieval:
  freshnessWindowMinutes: 15
  pollIntervalSeconds: 30
  maxCatchUpBatches: 3
  maxCatchUpRecords: 500
```

If Ollama is not reachable at `http://localhost:11434/v1`, or if the configured `nomic-embed-text` model is missing, onboarding prints an actionable local-model message and falls back to a hosted OpenAI-compatible provider. It only asks for:

- API key
- base URL (default: `https://api.deepseek.com`)
- model (default: `text-embedding-3-large` placeholder; override to whatever embedding model your hosted provider exposes)

No username, auth-mode, Hermes snippet paste, or manual YAML editing is required for the standard onboarding path.

## Hermes client config

After the local MCP service validates, `npm run onboard` merges this server into `~/.hermes/config.yaml` while preserving other Hermes settings and other MCP servers:

```yaml
mcp_servers:
  canary-alpha-mcp:
    url: http://127.0.0.1:18765/mcp
    enabled: true
    tools:
      include:
        - internal-status
        - find
        - recall
        - inspect
        - memory-read
        - memory-write
        - file-analyze
        - privacy-control
```

The automatic Hermes config step only accepts `127.0.0.1` MCP endpoints. If the existing Hermes config is invalid YAML, onboarding fails clearly and leaves the file unchanged.

## Config file location and manual setup

`npm run setup` writes the same default config shape and log directory without starting the service.

## Configuration fields

### `server`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `mode` | `stdio` \| `http` | `http` | Official v1 delivery uses `http`. |
| `host` | string | `127.0.0.1` | `service:start` refuses non-local hosts. |
| `port` | positive integer | `8765` | The schema default is `8765`, but the official setup/onboarding path writes `18765` so the managed local HTTP service uses a predictable endpoint. |

### `logging`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `level` | `debug` \| `info` \| `warn` \| `error` | `info` | Controls service log verbosity. |

### `screenpipe`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `url` | string | unset in schema; onboarding writes `http://localhost:3030` | Must point at a reachable local Screenpipe service for the normal v1 flow. |

### `providers.embeddings`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `kind` | string | `openai-compatible` in schema; onboarding writes `ollama` when reachable | The code accepts any string, but official examples use `ollama` and OpenAI-compatible providers. |
| `baseUrl` | string | unset in schema | Embedding API base URL. Onboarding defaults to `http://localhost:11434/v1` for Ollama or a hosted OpenAI-compatible endpoint when Ollama is unavailable. |
| `model` | string | unset in schema | Embedding model name. Onboarding defaults to `nomic-embed-text` for Ollama or the embedding model exposed by the hosted provider you select. |
| `apiKey` | string | unset | Optional for local providers such as Ollama; usually required for hosted providers. This credential is for the embedding endpoint only — the LLM summary path uses its own DeepSeek key (see below). |
| `concurrency` | positive integer | `2` | Caps simultaneous embedding requests across the shared runtime provider. Lower it for hosted providers with strict concurrency or rate limits. |

### LLM provider for summary generation

The embeddings layer and the LLM layer are configured independently:

- **Embeddings** (`providers.embeddings`) accept any OpenAI-compatible API endpoint. The local default is Ollama at `http://localhost:11434/v1`; any hosted OpenAI-compatible provider works too.
- **LLM summaries** (`analysis.summary.provider`) default to the local `template` provider. When you opt into `remote-llm`, the summary worker calls the DeepSeek chat endpoint described under `llm.{base_url, api_key, model}`. The standard values are `https://api.deepseek.com`, `${DEEPSEEK_API_KEY}`, and `deepseek-chat`. See `config.yaml.example` for the full block.

In other words: pick whichever embedding endpoint you like, but the `remote-llm` summary path is DeepSeek only.

### `vectorStore`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `kind` | string | `chroma` | Current v1 storage contract assumes Chroma-style local persistence. |
| `path` | string | unset | Optional custom retrieval artifact path. If omitted, retrieval artifacts stay under the app home. |

### `retrieval`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `freshnessWindowMinutes` | positive integer | `15` | Freshness target used in retrieval responses. |
| `pollIntervalSeconds` | positive integer | `30` | Background retrieval polling cadence. |
| `maxCatchUpBatches` | positive integer | `3` | Limits catch-up work per cycle. |
| `maxCatchUpRecords` | positive integer | `500` | Caps records processed during catch-up. |

## Environment overrides

The loader can override config values from the environment:

- `MCP_MODE`
- `MCP_PORT`
- `MCP_LOG_LEVEL`
- `SCREENPIPE_BASE_URL`

Managed service scripts also inject launchd-specific port overrides when the service is started through `npm run service:start`.

## Example: local Ollama

```yaml
server:
  mode: http
  host: 127.0.0.1
  port: 18765

logging:
  level: info

screenpipe:
  url: http://localhost:3030

providers:
  embeddings:
    kind: ollama
    baseUrl: http://localhost:11434/v1
    model: nomic-embed-text

vectorStore:
  kind: chroma

retrieval:
  freshnessWindowMinutes: 15
  pollIntervalSeconds: 30
  maxCatchUpBatches: 3
  maxCatchUpRecords: 500
```

## Example: hosted OpenAI-compatible embeddings

The example below uses the OpenAI-compatible API shape generically — `apiKey` is the credential for the embedding endpoint only and is unrelated to the DeepSeek key used by the `remote-llm` summary provider.

```yaml
server:
  mode: http
  host: 127.0.0.1
  port: 18765

logging:
  level: info

screenpipe:
  url: http://localhost:3030

providers:
  embeddings:
    kind: openai-compatible
    baseUrl: https://api.example-embeddings.com/v1
    model: your-embedding-model
    apiKey: sk-your-key
    concurrency: 2

vectorStore:
  kind: chroma
```

## Validation behavior

- `npm run onboard` fails early if local Screenpipe is not reachable at the default local endpoint.
- `npm run onboard` prefers local Ollama when reachable and the configured embedding model is installed; otherwise it prompts for hosted-provider credentials.
- `npm run onboard` runs first live MCP validation (`internal-status`, `recall`, and `find`) after the service starts, then writes Hermes config. This is a real-user install check, not the same thing as the controlled-real Hermes evaluation harness.
- If the config file exists but does not match the schema, startup fails with an `Invalid config file` error.
- `service:start` rejects any `server.host` other than `127.0.0.1`.

## Related docs

- [MCP Tools](/reference/tools) — Tool surface reference
- [Troubleshooting](/guide/troubleshooting) — Symptom-based diagnosis
- [Privacy & Data](/reference/privacy) — Data locality and privacy controls
