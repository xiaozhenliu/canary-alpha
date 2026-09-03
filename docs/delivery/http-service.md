---
doc_version: 1
doc_status: active
last_updated: 2026-04-16
---

# HTTP service delivery

## Official runtime shape

Phase 4 delivers `computer-history-mcp` as a local resident HTTP service bound to `127.0.0.1`. The official MCP endpoint is:

- `http://127.0.0.1:<port>/mcp`

This service-first path is the primary v1 delivery story. Stdio remains available only for compatibility and deterministic testing, and neither stdio nor Claude Desktop is the official delivery path.

## Canonical release command set

Use this canonical focused v1 command set for setup, resident service verification, deterministic HTTP proof, and bounded outer proof:

```bash
npm run setup
npm run build
npm run service:start
npm run service:status
npm run test:http-tool-flow
npm run smoke:http
npm run test:hermes:phase4
```

For a concise public overview, see `README.md`. For bounded real-agent evidence, see `docs/delivery/hermes.md`.

## Prerequisites

- Node.js 22+
- A valid config file at `~/.computer-history-mcp/config.yaml`
- Screenpipe reachable at the configured `screenpipe.url`
- An embedding provider reachable at the configured `providers.embeddings.baseUrl`

## Setup

Create the config template and log directories:

```bash
npm run setup
```

The setup script creates:

- `~/.computer-history-mcp/config.yaml`
- `~/.computer-history-mcp/logs/`

The generated config template defaults to HTTP mode and a local listener.

## Build

Build the service before starting the managed runtime:

```bash
npm run build
```

The managed launcher expects the built entrypoint at `dist/src/index.js`.

## Service lifecycle

Start the managed launchd service:

```bash
npm run service:start
```

Check health:

```bash
npm run service:status
```

Read recent logs:

```bash
npm run service:logs
```

Stop the service:

```bash
npm run service:stop
```

## Health contract

`npm run service:status` verifies more than process existence. It probes the MCP endpoint and expects `internal-status` to report:

- `status: ok`
- `mode: http`
- matching `pid`
- matching `configFile`

That keeps the delivery proof tied to the actual MCP surface rather than only `launchctl` state.

## Recovery

If retrieval checkpoint or vector-store state is missing, stale, or corrupted, rebuild it from Screenpipe history:

```bash
npm run rebuild-index
```

The rebuild path is intentionally scoped to retrieval recovery only. It resets vector/checkpoint artifacts, reindexes Screenpipe data, and leaves unrelated app-home files intact.

## Automated verification

Real HTTP tool-flow acceptance:

```bash
npm run test:http-tool-flow
npm run smoke:http
```

Bounded Hermes interoperability proof:

```bash
npm run test:hermes:phase4
```

Existing transport and acceptance coverage:

```bash
npm run test -- tests/acceptance/http-init.test.ts
npm run test:acceptance
npm run typecheck
```

## Wording drift check

Use a targeted grep during Phase 4 verification to check for stale delivery claims in project docs and planning files. Record the exact command and reviewed output in the phase summary so the verification command itself does not pollute the search surface.
