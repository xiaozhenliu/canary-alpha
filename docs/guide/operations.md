---
doc_version: 1
doc_status: active
last_updated: 2026-06-12
---

# Operations

Day-to-day commands for managing, diagnosing, and maintaining the `canary-alpha-mcp` service.

## Managing the service

```bash
npm run service:start    # Start the managed HTTP service
npm run service:stop     # Stop the managed HTTP service
npm run service:status   # Check service health and endpoint reachability
npm run service:logs     # Stream the service log
```

`service:status` validates the real MCP `internal-status` contract, not just whether a process is running. It reports the endpoint URL and retrieval recovery status.

`service:logs` streams the log file for the managed service. Use this when onboarding fails or when the service exits unexpectedly.

## Diagnostics

```bash
npm run storage:diagnostics   # Report index health, disk usage, and ingestion stats
npm run maintain:status        # Show last maintenance run timestamp and outcome
npm run maintain:run           # Run Screenpipe database maintenance immediately
```

`storage:diagnostics` is the first command to run when retrieval seems slow or incomplete. It reports the FTS5 index size, vector index status, and recent ingestion counts.

`maintain:run` triggers the same maintenance pass that `npm run screenpipe:safe-record` runs automatically every 10 minutes. You can run it manually at any time.

## Index maintenance

```bash
npm run rebuild-index
```

Rebuilds the local retrieval index from scratch. Run this when `service:status` reports `retrieval.recoveryStatus: needs-rebuild`, or when `storage:diagnostics` shows stale or corrupt index state.

Rebuilding takes a few minutes depending on Screenpipe history size. The service remains available during the rebuild but retrieval quality may be reduced until the build completes.

See [Troubleshooting](/guide/troubleshooting) for the `needs-rebuild` diagnosis steps.

## Live end-to-end check

```bash
npm run e2e:live -- --duration 10m
```

Starts any missing local dependencies, records Screenpipe activity for the given duration, waits for index readiness, then asks Hermes to summarize what was captured in that window. Use this to verify the full pipeline — capture → index → retrieval → agent response — is working on your machine.

## Where things live on disk

| Path | Contents |
|------|----------|
| `~/.canary-alpha-mcp/config.yaml` | Server configuration (embedding provider, port, etc.) |
| `~/.canary-alpha-mcp/logs/` | Service logs and maintenance run records |
| `~/.screenpipe/` | Screenpipe raw capture data (managed by Screenpipe, not this server) |

For details on what gets captured and how to control it, see [Privacy & Data](/reference/privacy).
