---
doc_version: 4
doc_status: active
last_updated: 2026-06-14
---

# Operations

Day-to-day commands for managing, diagnosing, and maintaining the `canary-alpha-mcp` service.

## Daily start (one command)

```bash
npm run up                 # Build, start the managed MCP service, and start Screenpipe recording (foreground recorder)
npm run up -- --detach     # Same, but run the recorder in the background so the terminal is freed
npm run down               # Stop the managed MCP service (does not stop the recorder)
npm run down:all           # Gracefully stop the recorder AND the managed MCP service
```

`up` is the everyday bring-up: it compiles the current source (so the service runs the latest code, not a stale `dist/`), starts the launchd-managed MCP service and waits until it is reachable, then ensures Screenpipe is capturing — reusing an already-running instance, or starting the recorder in the foreground otherwise. While the recorder runs in the foreground, press Ctrl-C to stop recording; the MCP service keeps running so an agent can still query already-captured memory. To run the recorder in the background instead (so you can close the terminal), pass `--detach` — see [Background recorder](#background-recorder-close-the-terminal). Stop the service with `npm run down`, or tear the whole stack down with `npm run down:all`.

Screenpipe records continuously (24/7) with a 7-day retention window; there is no fixed recording duration. If a Screenpipe instance is already running, `up` reuses it as-is. To guarantee the recorder runs with this script's intended options instead of whatever an already-running instance was started with, force a clean restart:

```bash
npm run up -- --restart-capture   # stop any running Screenpipe, then start a fresh recorder
```

### Background recorder (close the terminal)

By default `up` starts the recorder in the foreground, so the launching terminal must stay open. Pass `--detach` (alias `--background`) to run the recorder detached instead — output is written to `~/.canary-alpha-mcp/logs/recorder.log` and the terminal is freed:

```bash
npm run up -- --detach            # start the stack with the recorder in the background
```

Manage the background recorder with its own lifecycle commands:

```bash
npm run recorder:start    # start the recorder detached (logs to recorder.log)
npm run recorder:status   # report whether the background recorder is running
npm run recorder:logs     # tail the recorder log
npm run recorder:stop     # gracefully stop the recorder (SIGTERM + final maintenance)
```

`recorder:stop` sends SIGTERM so the recorder shuts Screenpipe down cleanly and runs a final database-maintenance pass before exiting; it escalates to SIGKILL only if the recorder does not exit within 30 seconds.

The background stack has two independent layers, and they survive differently:

| Layer | Backgrounding | After closing the terminal | After reboot / re-login |
|-------|---------------|----------------------------|--------------------------|
| MCP HTTP service | launchd-managed daemon | Keeps running | Auto-starts (`RunAtLoad` + `KeepAlive`) |
| Screenpipe recorder | Detached process in its own session | Keeps running | Does **not** auto-start — run `recorder:start` again |

The recorder is intentionally not launchd-managed: it needs the macOS screen-recording (TCC) permission granted to your login session, which a launchd daemon may not inherit.

### Graceful shutdown

Tear the background stack down with one command:

```bash
npm run down:all   # stop the recorder, then the managed MCP service
```

`down:all` stops the recorder first (so its final maintenance pass flushes and Screenpipe shuts down cleanly), then stops the managed service. Both stop steps are idempotent — they report "already stopped" when nothing is running — so `down:all` is safe on a partially-running stack. To control the layers separately, use the equivalent two commands:

```bash
npm run recorder:stop   # graceful recorder stop (SIGTERM + final maintenance, SIGKILL backstop after 30s)
npm run down            # stop the managed MCP service and remove its launchd autostart entry
```

`npm run down` on its own stops only the managed MCP service; it leaves the recorder running. Use `down:all` (or follow `down` with `recorder:stop`) for a full teardown.

Use the individual commands below when you want finer control than `up` / `down` / `down:all`.

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
