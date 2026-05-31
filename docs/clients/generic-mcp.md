---
doc_version: 3
doc_status: active
last_updated: 2026-05-28
---

# Generic MCP Client Setup

Use this guide when connecting any MCP-compatible client to the public `canary-alpha-mcp` HTTP endpoint.

## Official endpoint

The official v1 endpoint is:

```
http://127.0.0.1:<port>/mcp
```

This server is intentionally local-only. The managed service refuses non-local hosts.

## Before you connect

1. For the normal first-run path, install dependencies and run onboarding after Screenpipe is healthy:

```bash
npm install
npm run onboard
```

Onboarding writes the app config, starts the managed service, validates the MCP endpoint, and configures Hermes automatically.

2. For manual generic-client setup, use the validated endpoint from onboarding or `npm run service:status`.

A healthy status output should report an endpoint like:

```text
endpoint: http://127.0.0.1:18765/mcp (healthy)
```

## Transport expectations

- Transport: Streamable HTTP
- Host: `127.0.0.1`
- Path: `/mcp`
- Authentication: none built into the server for local v1
- Scope: local machine only

## Generic client checklist

Any client should support these steps:

1. Add a new MCP server using Streamable HTTP
2. Set the server URL to `http://127.0.0.1:<port>/mcp`
3. Connect and list available tools
4. Confirm these tools appear:
   - `find`
   - `recall`
   - `inspect`
   - `memory-read`
   - `memory-write`
   - `file-analyze`
   - `privacy-control`
   - `internal-status`
5. Run `internal-status` with `{}` to confirm runtime health
6. Run a simple retrieval call such as `recall` or `find`

## Suggested first calls

### Health check

Tool: `internal-status`

```json
{}
```

Expected result shape:

- `status: ok`
- `mode: http`
- `host: 127.0.0.1`
- `port: <configured port>`
- `configFile: ~/.canary-alpha-mcp/config.yaml`
- `retrieval.recoveryStatus: ready | needs-rebuild | degraded`

### Retrieval smoke test

Tool: `recall`

```json
{
  "from": "<ISO timestamp ten minutes before now>",
  "to": "<ISO timestamp now>",
  "granularity": "session",
  "includeSummary": false
}
```

Or tool: `find`

```json
{
  "query": "note",
  "mode": "hybrid"
}
```

## Verification commands

Outside the client, these repo commands verify the same path:

```bash
npm run service:status
npm run test:http-tool-flow
npm run smoke:http
```

If you are validating Hermes specifically after onboarding, run:

```bash
hermes mcp list
hermes mcp test screenpipe-memory
```

For repeatable release evidence, also run:

```bash
npm run test:hermes:phase4
```

## Common integration mistakes

### Wrong transport

Do not point the client at stdio if you are validating the official v1 delivery path. Use Streamable HTTP.

### Wrong URL

Use `/mcp`, not just the host and port.

### Service not built

`npm run service:start` requires the built entrypoint at `dist/src/index.js`, so run `npm run build` first when bypassing `npm run onboard`.

### Unhealthy endpoint

If the client can reach the port but tools fail, run `npm run service:status`. It validates the real MCP `internal-status` contract, not just process existence.

## Related docs

- [../../README.md](../../README.md)
- [../documentation/configuration.md](../documentation/configuration.md)
- [../documentation/mcp-tools.md](../documentation/mcp-tools.md)
- [../delivery/http-service.md](../delivery/http-service.md)
- [../troubleshooting.md](../troubleshooting.md)
