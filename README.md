---
doc_version: 14
doc_status: active
last_updated: 2026-04-18
---

# canary-alpha-mcp

Local-first MCP server that exposes Screenpipe screen memory, long-term memory, file analysis, and privacy controls as standard MCP tools. Any MCP-compatible agent connects over HTTP and calls the tools directly.

Current release: `v1.0.0`

## Quick start

Use the full step-by-step guide in [docs/quickstart.md](docs/quickstart.md) if you are starting from a clean machine. The short version is:

1. Install and launch Screenpipe.
   - Recommended path: the Screenpipe desktop app from <https://screenpi.pe/onboarding>
   - On first launch on macOS, grant Screen Recording, Accessibility, and Microphone permissions
   - Terminal path from this repo: `npm run screenpipe:safe-record`
   - This wrapper applies repo-recommended safer defaults: PII removal, bounded retention, a narrow default ignored-window set for low-value macOS system UI, a small repo-managed ignored-app set for high-risk local apps, and no audio or vision capture unless you explicitly pass supported capture flags. Supported audio opt-in flags include `--audio-device`, `--use-system-default-audio`, and `--experimental-coreaudio-system-audio`; supported vision opt-in flags include `--monitor-id`, `--use-all-monitors`, and `--included-windows`. If you do opt into audio capture, transcription stays off unless you also choose an audio transcription engine, and an explicit `--disable-audio` still wins over those defaults
   - Verify that the local API is healthy:

   ```bash
   curl http://localhost:3030/health
   ```

2. Install this repo and run the MCP-layer onboarding:

```bash
npm install
npm run onboard
```

If Ollama is unavailable, or if `nomic-embed-text` is not installed, `npm run onboard` explains the local model requirement and asks only for the hosted embedding API key/base URL/model instead of requiring manual YAML edits.

`npm run screenpipe:safe-record` is the repo-local safer terminal path: it enables PII removal, applies bounded retention, ignores a narrow default set of repeated low-value macOS system windows plus selected high-risk apps, and disables audio and vision capture unless you explicitly pass supported capture flags. Supported audio opt-in flags include `--audio-device`, `--use-system-default-audio`, and `--experimental-coreaudio-system-audio`; supported vision opt-in flags include `--monitor-id`, `--use-all-monitors`, and `--included-windows`. If you do opt into audio capture, the wrapper still defaults transcription off unless you explicitly set `--audio-transcription-engine`, and an explicit `--disable-audio` overrides the wrapper’s audio-intent defaults.

`npm run onboard` is the default-first repo onboarding step after local Screenpipe is healthy. It:

- assumes Screenpipe is already healthy, whether you started it from the desktop app or with `npm run screenpipe:safe-record`
- checks that local Screenpipe is reachable at `http://localhost:3030`
- prefers local Ollama at `http://localhost:11434/v1` with `nomic-embed-text` when available
- only asks for hosted-provider fields if Ollama is unavailable or the configured embedding model is missing
- writes `~/.canary-alpha-mcp/config.yaml` for you
- writes or updates `~/.hermes/config.yaml` with the `screenpipe-memory` MCP server after validation passes
- backs up any existing config before overwriting it
- builds the project, starts the managed local HTTP service, and runs a first real MCP validation against your own local Screenpipe data

The MCP endpoint is:

```
http://127.0.0.1:18765/mcp
```

## Configuration

Config file: `~/.canary-alpha-mcp/config.yaml`

You do not need to edit YAML for the normal first-run path. `npm run onboard` writes the config using the standard v1 defaults and only asks for irreducible hosted-provider inputs such as an API key. If you want to change embedding provider settings later, edit `~/.canary-alpha-mcp/config.yaml` and restart the managed service. See [docs/documentation/configuration.md](docs/documentation/configuration.md) for all fields and provider examples.

## Service commands

| Command | Purpose |
|---------|---------|
| `npm run onboard` | Run the default-first interactive setup, build, service start, and first-run validation |
| `npm run setup` | Create the default config and log directory without starting the service |
| `npm run service:start` | Start the managed launchd service |
| `npm run service:stop` | Stop the service |
| `npm run service:status` | Check health and endpoint reachability |
| `npm run service:logs` | Tail recent service logs |
| `npm run rebuild-index` | Rebuild retrieval index from Screenpipe data |

## MCP tools

Seven tools are registered at the endpoint:

| Tool | Category | Purpose |
|------|----------|---------|
| `search-screen` | retrieval | Search indexed screen history |
| `recent-activity` | retrieval | Retrieve recent screen activity |
| `memory-read` | memory | Read persisted long-term memory |
| `memory-write` | memory | Write or append long-term memory |
| `file-analyze` | file-analysis | Summarize or query a local file |
| `privacy-control` | privacy | Check or modify privacy collection controls |
| `internal-status` | internal | Runtime health and retrieval state |

See [docs/documentation/mcp-tools.md](docs/documentation/mcp-tools.md) for input schemas and output contracts.

## Connecting a client

Point any MCP-compatible client at `http://127.0.0.1:18765/mcp` using Streamable HTTP transport. For Hermes, `npm run onboard` writes the `screenpipe-memory` server into `~/.hermes/config.yaml` after the first-run validation passes, preserving other Hermes settings. See [docs/clients/generic-mcp.md](docs/clients/generic-mcp.md) for setup steps and verification.

## Validation boundary

The onboarding flow is intentionally different from the controlled-real Hermes evaluation layer:

- the quickstart path in [docs/quickstart.md](docs/quickstart.md) plus `npm run onboard` is the real-user install path that uses your own local Screenpipe data and proves the local MCP service is working now.
- `npm run test:evaluations:v1` is the controlled-real evaluation harness that runs Hermes against fixture-backed local stubs and writes repeatable evidence artifacts under `.planning/`.

Use onboarding to get productive quickly; use the evaluation harness when you need repeatable validation evidence.

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md) for common issues: service unreachable, provider errors, and index recovery.

## Documentation map

| Document | Audience | Coverage |
|----------|----------|---------|
| [docs/quickstart.md](docs/quickstart.md) | New users | Normal macOS install/start path |
| [docs/documentation/configuration.md](docs/documentation/configuration.md) | Users | Config fields, defaults, provider examples |
| [docs/documentation/mcp-tools.md](docs/documentation/mcp-tools.md) | Client integrators | Tool contracts and schemas |
| [docs/clients/generic-mcp.md](docs/clients/generic-mcp.md) | Client integrators | Generic HTTP client setup |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Operators | Diagnosis and recovery |
| [docs/delivery/http-service.md](docs/delivery/http-service.md) | Operators | Managed service lifecycle |
| [docs/delivery/hermes.md](docs/delivery/hermes.md) | Operators | Hermes interoperability proof |
| [docs/engineering/code-standards.md](docs/engineering/code-standards.md) | Maintainers | Engineering rules |
