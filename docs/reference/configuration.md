---
doc_version: 14
doc_status: active
last_updated: 2026-06-21
---

# Configuration

`computer-history-mcp` reads its runtime config from `~/.computer-history-mcp/config.yaml`.

Use `npm start` as the normal entry point. When the app config or onboarding-complete marker is absent, it starts or reuses Screenpipe and delegates to `npm run onboard`; onboarding creates the config using the standard Crimson defaults, backs up any existing app config first, builds the project, starts the managed service, validates the live local MCP endpoint, and writes the validated `computer-history-mcp` server into Hermes config. `npm run setup` is still available when you want the app config/log directory without running the full onboarding flow; its config alone does not make `npm start` misclassify the installation as complete.

## Config file location

- Config file: `~/.computer-history-mcp/config.yaml`
- App home: `~/.computer-history-mcp/`
- Onboarding state marker: `~/.computer-history-mcp/.onboarding-complete`
- Logs: `~/.computer-history-mcp/logs/`
- Screenpipe safe-record maintenance log: `~/.computer-history-mcp/logs/screenpipe-maintenance.jsonl` with 7-day pruning and 1 MB rotation to `screenpipe-maintenance.jsonl.1`
- Automatic app-config backups created by `npm run onboard`: `~/.computer-history-mcp/config.backup-YYYYMMDD-HHMMSS.yaml`
- Hermes config updated by `npm run onboard`: `~/.hermes/config.yaml`

If you have already finished onboarding and want to change settings later, use the [`config` CLI](#managing-configuration-with-the-config-cli) (or edit `~/.computer-history-mcp/config.yaml` directly), then restart the managed service with `npm run service:stop && npm run service:start`.

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
  binaryPath: screenpipe
  dataDirectory: ~/.screenpipe

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
  computer-history-mcp:
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

## Managing configuration with the config CLI

Instead of hand-editing `config.yaml`, you can manage every field with the built-in `config` subcommand. It type-checks and validates values before writing, preserves your comments and formatting, masks secrets, and surfaces environment overrides. It never starts the full server (no vector store or runtime bootstrap), so it stays fast and keeps working even when the rest of the config is broken.

Run it from the built server:

```bash
npm run build            # produces dist/ once
node dist/src/index.js config <command> ...
```

| Command | What it does |
|---------|--------------|
| `config list [--reveal]` | Print every effective field. Schema-default fallbacks are tagged `(default)`; environment overrides are tagged `(overridden by env <VAR>)`. |
| `config get <path> [--reveal]` | Read one dotted path, e.g. `config get providers.embeddings.model`. |
| `config set <path> <value>` | Set one field. The value is type-coerced and the whole file is re-validated before the write; the config file is created if it does not exist yet. |
| `config set <path> -- <value>` | Same, with a `--` terminator so a value that starts with `-` (for example a negative `analysis.embeddings.minScore`) is not parsed as a flag. |
| `config unset <path>` | Remove an optional field so it falls back to its schema default. Required fields cannot be unset. |
| `config add <path> <item>` | Append one item to an array field, in place, with comments preserved. |
| `config remove <path> <item>` | Remove one item from an array field. |
| `config validate` | Validate the current `config.yaml` against the schema and print per-field errors. Exits non-zero on failure. |
| `config path` | Print the absolute path of `config.yaml`. |

Flags:

- `--reveal` — show secret values (`providers.embeddings.apiKey`, `llm.api_key`, `screenpipe.apiKey`, `server.authToken`) in cleartext instead of `***`. A warning is printed because the secret then lands in your terminal history.
- `--` — terminator after which all following tokens are taken literally; use it for values that begin with `-`.

Notes:

- **Secrets are masked by default** in `list` and `get`; only `--reveal` shows them.
- **Environment overrides win at runtime.** If a field is currently overridden by an environment variable (for example `MCP_PORT`), the CLI says so, so a `set` that appears to have no effect is explained rather than silent.
- **Computed paths are read-only.** Derived values such as `paths.*` are not file fields and cannot be `set`.

After a `set`, `unset`, `add`, or `remove`, restart the managed service for changes to take effect: `npm run service:stop && npm run service:start`.

## Configuration fields

### `server`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `mode` | `stdio` \| `http` | `http` | Official Crimson delivery uses `http`. |
| `host` | string | `127.0.0.1` | `service:start` refuses non-local hosts. |
| `port` | positive integer | `8765` | The schema default is `8765`, but the official setup/onboarding path writes `18765` so the managed local HTTP service uses a predictable endpoint. |

### `logging`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `level` | `debug` \| `info` \| `warn` \| `error` | `info` | Controls service log verbosity. |

### `capture`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `provider` | `screenpipe` | `screenpipe` | Which capture provider backs screen-memory ingestion, inspect, trim, and recorder control. Currently `screenpipe` is the only supported value; adding a new provider means a new directory under `src/services/capture/providers/` plus a new enum member. |
| `livenessThresholdSeconds` | positive integer | `120` | Frames newer than this count as live capture (`ok`); older frames classify the capture state as `idle`. |
| `permissionsGracePeriodSeconds` | non-negative integer | `60` | Grace period after the recorder process starts before a frameless state is reported as `permissions-missing`. |
| `ocrLanguages` | array of language names | `['english']` | OCR recognition languages, passed to the recorder as repeated `screenpipe record --language <name>` flags. Supported values are a subset of screenpipe's `Language` names (upstream supports ~76): `english`, `chinese`, `japanese`, `korean`, `french`, `german`, `spanish`, `russian`, `portuguese`, `italian`, `arabic`. **Order is priority** — on macOS, Apple Vision uses the *first* language as its primary OCR mode (based on our internal OCR investigation). Set `[chinese, english]` to enable Chinese-primary capture. Values are name-based (e.g. `chinese`), not Apple locale codes (`zh-Hans`). The dashboard displays this field read-only in this release. |

```yaml
capture:
  # Which capture provider backs screen-memory ingestion.
  # Currently supported: screenpipe (default).
  provider: screenpipe
  # OCR recognition languages (order = priority; first language is the
  # Apple Vision primary mode on macOS). Default is English-only.
  ocrLanguages:
    - chinese
    - english
```

Set OCR languages from the CLI with `config add` (it **appends**, it does not replace — run it once per language, and the **first** language you add becomes Apple Vision's primary mode):

```bash
node dist/src/index.js config add capture.ocrLanguages chinese
node dist/src/index.js config add capture.ocrLanguages english
```

### `screenpipe`

Provider-specific configuration block for the `screenpipe` capture provider (the same way `providers.embeddings` configures the embedding provider). It is only consulted when `capture.provider` is `screenpipe`.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `url` | string | unset in schema; onboarding writes `http://localhost:3030` | Must point at a reachable local Screenpipe service for the normal Crimson flow. |
| `binaryPath` | non-empty string | `screenpipe` | Recorder executable name or path. `~/` is expanded. Use an absolute versioned path to select a development build without replacing the stable global command. |
| `dataDirectory` | non-empty string | `~/.screenpipe` | Directory passed to `screenpipe record --data-dir` and used by indexing, inspection, diagnostics, privacy deletion, trim, and maintenance. `~/` is expanded. Never point two concurrently running recorders at the same directory. |

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
| `kind` | string | `chroma` | Current Crimson storage contract assumes Chroma-style local persistence. |
| `path` | string | unset | Optional custom retrieval artifact path. If omitted, retrieval artifacts stay under the app home. |

### `retrieval`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `freshnessWindowMinutes` | positive integer | `15` | Freshness target used in retrieval responses. |
| `pollIntervalSeconds` | positive integer | `30` | Background retrieval polling cadence. |
| `maxCatchUpBatches` | positive integer | `3` | Limits catch-up work per cycle. |
| `maxCatchUpRecords` | positive integer | `500` | Caps records processed during catch-up. |

### `routines`

Controls the local routines engine. Routines are background tasks that run on a cron schedule. Each routine carries a `prompt` field; the scheduler passes that prompt — together with evidence retrieved from recent screen activity — to the configured LLM and stores the result in the execution history. When no LLM is configured, a template fallback is used instead.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `enabled` | boolean | `false` | When `false`, no routines are scheduled or executed. Set to `true` to activate the scheduler. |
| `definitionsPath` | string | `~/.computer-history-mcp/routines/definitions/` | Directory where routine definition JSON files are persisted. Supports `~/` expansion. If omitted, the default path under the app home is used. |
| `historyPath` | string | `~/.computer-history-mcp/routines/history/` | Directory where routine execution history JSON files are persisted, newest-first per routine. Supports `~/` expansion. If omitted, the default path under the app home is used. |

Default storage layout:

```
~/.computer-history-mcp/
  routines/
    definitions/   ← one JSON file per routine (slug-named)
    history/       ← one JSON file per routine (execution records, newest first)
```

To enable routines with default paths:

```yaml
routines:
  enabled: true
```

To override storage locations:

```yaml
routines:
  enabled: true
  definitionsPath: ~/my-data/routines/definitions
  historyPath: ~/my-data/routines/history
```

**Not yet supported** — manual trigger of a routine run, routine outputs as MCP resources, and cross-machine sync. These are tracked in the project backlog for future releases.

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
