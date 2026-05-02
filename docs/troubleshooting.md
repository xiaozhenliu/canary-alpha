---
doc_version: 1
doc_status: active
last_updated: 2026-04-16
---

# Troubleshooting

This guide covers the common operator failures in the current v1 delivery path.

## Service will not start

### Symptom

`npm run service:start` exits immediately.

### Checks

1. Confirm you are on macOS. `service:start` and `service:stop` currently support launchd on Darwin only.
2. Run `npm run build`. The service launcher requires `dist/src/index.js`.
3. Confirm the config exists:

```bash
npm run setup
```

4. Check that `server.host` is `127.0.0.1`. The service refuses any non-local host.

### Typical messages

- `Missing config file ... Run npm run setup first.`
- `Missing built service entrypoint ... Run npm run build first.`
- `Refusing to start service with non-local host ... Expected 127.0.0.1.`

## Service status is unhealthy

### Symptom

`npm run service:status` reports:

```text
endpoint: http://127.0.0.1:<port>/mcp (unhealthy)
```

### What this means

The check probes the real MCP endpoint and calls `internal-status`. This is stricter than checking whether a process exists.

### Checks

1. Read recent logs:

```bash
npm run service:logs
```

2. Confirm the config parses correctly.
3. Confirm Screenpipe is reachable at `screenpipe.url`.
4. Confirm the embedding provider endpoint is reachable and correctly configured.
5. Re-run:

```bash
npm run service:start
npm run service:status
```

## Retrieval reports `needs-rebuild`

### Symptom

`internal-status` reports:

```json
{
  "retrieval": {
    "recoveryStatus": "needs-rebuild"
  }
}
```

### Recovery

Rebuild retrieval artifacts from Screenpipe data:

```bash
npm run rebuild-index
```

This path is scoped to retrieval recovery. It does not reset unrelated config, memory, or privacy files.

## Retrieval reports `degraded`

### Symptom

Tool output mentions degraded retrieval state, or `internal-status` reports `recoveryStatus: degraded`.

### Meaning

The service is up, but vector store or checkpoint state is not fully readable.

### Next steps

1. Inspect logs with `npm run service:logs`
2. Re-run `npm run service:status`
3. If the degraded state persists, run `npm run rebuild-index`

## Client cannot discover tools

### Checks

1. Confirm the client is using Streamable HTTP.
2. Confirm the URL ends with `/mcp`.
3. Run `npm run service:status` locally.
4. Call `internal-status` first. If that fails, the issue is transport or service health rather than a specific tool.

## Provider errors

### Symptom

Retrieval tools fail or return actionable error text.

### Checks

1. Verify `providers.embeddings.baseUrl`
2. Verify `providers.embeddings.model`
3. Verify `providers.embeddings.apiKey` when your provider requires one
4. Confirm the provider is reachable from your machine
5. Check whether Screenpipe itself is reachable at `screenpipe.url`

## No logs found

### Symptom

`npm run service:logs` prints:

```text
No log output found yet under ~/.canary-alpha-mcp/logs/.
```

### Meaning

The service may not have started yet, or it exited before producing output.

### Checks

- run `npm run service:start`
- re-run `npm run service:status`
- check whether `~/.canary-alpha-mcp/logs/` exists

## File analysis rejects a file

### Symptom

`file-analyze` returns an error for a given path.

### Meaning

The service only analyzes supported text input. Binary content is rejected explicitly.

### Next steps

- verify the file exists
- verify the path is correct
- retry with a text file rather than a binary asset

## Verification commands

Use these commands when narrowing down a problem:

```bash
npm run service:status
npm run service:logs
npm run test:http-tool-flow
npm run smoke:http
npm run test:acceptance
```

## Related docs

- [../README.md](../README.md)
- [documentation/configuration.md](./documentation/configuration.md)
- [documentation/mcp-tools.md](./documentation/mcp-tools.md)
- [delivery/http-service.md](./delivery/http-service.md)
