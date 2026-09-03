---
doc_version: 13
doc_status: active
last_updated: 2026-09-04
---

# Operations

Day-to-day commands for managing, diagnosing, and maintaining the `computer-history-mcp` service.

## Rename migration from canary-alpha-mcp

Existing installs that still use `~/.canary-alpha-mcp` are migrated automatically by `npm start`, `npm run setup`, and `npm run service:start`:

- If only the legacy directory exists, it is copied to a timestamped backup and renamed to `~/.computer-history-mcp`.
- If both directories exist, migration stops without overwriting or merging data. Resolve the conflict manually before continuing.
- Managed service scripts also stop and remove the legacy launchd label `com.canary-alpha-mcp` before installing `com.computer-history-mcp`.

## Universal start

```bash
npm start
```

Use `npm start` regardless of whether this is the first run or an existing installation. The command selects the path from local state:

- Config or the onboarding-complete marker is missing: start or reuse Screenpipe, then continue interactive onboarding. This includes a config created by `npm run setup` alone.
- Onboarding is complete but `dist/src/index.js` is missing: build once, then resume the stack.
- Onboarding and build output are present: run the fast resume path without rebuilding.

Successful onboarding writes `~/.computer-history-mcp/.onboarding-complete`. For compatibility, an existing managed launchd service is also accepted as evidence of an installation created before this marker existed. Agents do not decide whether a run is “first” or “resume”; the script owns that state transition.

The resume path checks the managed MCP service and Screenpipe in parallel, reuses healthy components, starts only missing components, waits for both endpoints to become healthy, and exits. Agents and normal users should not select `onboard`, `resume`, `service:start`, or `screenpipe:safe-record` themselves; those commands remain available for targeted maintenance.

## Update MCP after changing source code

```bash
npm run refresh:hermes
```

Use this command after editing or pulling source code when Hermes must use and verify the new MCP build. It performs one fail-fast sequence:

1. Runs the full project build.
2. Reinstalls and restarts the launchd-managed MCP service, then waits for its MCP endpoint.
3. Restores the shared local stack, reusing healthy components and starting Screenpipe only when needed.
4. Runs `hermes:verify` against the real Hermes configuration and requires a successful `internal-status` tool call.

Success means both the refreshed MCP runtime and the Hermes integration were verified. A non-zero exit identifies the failed stage and prevents later stages from masking it. Hermes itself and its LLM provider must already be configured.

Do not use `npm start` for this task: when valid build output already exists, `npm start` intentionally resumes it without rebuilding. `npm run up -- --detach` rebuilds and restarts the stack, but does not prove that Hermes can call it.

## Build and start the latest source

```bash
npm run up                 # Build, start the managed MCP service, and start Screenpipe recording (foreground recorder)
npm run up -- --detach     # Same, but run the recorder in the background so the terminal is freed
npm run down               # Stop the managed MCP service (does not stop the recorder)
npm run down:all           # Gracefully stop the recorder AND the managed MCP service
```

`up` compiles the current source (so the service runs the latest code, not a stale `dist/`), starts the launchd-managed MCP service and waits until it is reachable, then ensures Screenpipe is capturing — reusing an already-running instance, or starting the recorder in the foreground otherwise. While the recorder runs in the foreground, press Ctrl-C to stop recording; the MCP service keeps running so an agent can still query already-captured memory. To run the recorder in the background instead (so you can close the terminal), pass `--detach` — see [Background recorder](#background-recorder-close-the-terminal). Stop the service with `npm run down`, or tear the whole stack down with `npm run down:all`.

Screenpipe records continuously (24/7) with a 7-day retention window; there is no fixed recording duration. If a Screenpipe instance is already running, `up` reuses it as-is. To guarantee the recorder runs with this script's intended options instead of whatever an already-running instance was started with, force a clean restart:

```bash
npm run up -- --restart-capture   # stop any running Screenpipe, then start a fresh recorder
```

### Background recorder (close the terminal)

By default `up` starts the recorder in the foreground, so the launching terminal must stay open. Pass `--detach` (alias `--background`) to run the recorder detached instead — output is written to `~/.computer-history-mcp/logs/recorder.log` and the terminal is freed:

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

The recorder resolves its executable and storage from `screenpipe.binaryPath` and `screenpipe.dataDirectory`. This lets stable and development binaries coexist without changing the global `screenpipe` symlink. Stop the active recorder before switching either field; a development build should use a separate port and data directory so it cannot migrate or mutate the stable database.

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

Use the individual commands below when you want finer control than `resume` / `up` / `down` / `down:all`.

## Managing the service

```bash
npm run service:start    # Start the managed HTTP service
npm run service:stop     # Stop the managed HTTP service
npm run service:status   # Check service health and endpoint reachability
npm run service:logs     # Stream the service log
```

`service:status` validates the real MCP `internal-status` contract, not just whether a process is running. It reports the endpoint URL and retrieval recovery status.

`service:logs` streams the log file for the managed service. Use this when onboarding fails or when the service exits unexpectedly.

::: tip Dashboard
When the service is running in HTTP mode, a browser-based management panel is available at `http://127.0.0.1:<port>/`. It provides status monitoring, configuration editing, routines management, activity browsing, privacy controls, and log viewing. See [Dashboard reference](/reference/dashboard) for details.
:::

## Use the service while developing

Use one Screenpipe recorder and one managed `computer-history-mcp` service for normal daily operation. Connect every MCP client to the same HTTP endpoint, normally `http://127.0.0.1:18765/mcp`. Multiple clients can share this endpoint and the same derived index; do not start a separate server process for each client.

The derived SQLite database, retrieval checkpoint, privacy state, and runtime files assume a single writer. Do not run two `computer-history-mcp` processes against the same `~/.computer-history-mcp` directory. In particular, do not add a stdio configuration that launches another server process while the managed HTTP service is running.

Repository tests that exercise capture and embedding boundaries use temporary application directories and local stubs. They do not require a second live Screenpipe or `computer-history-mcp` service. For manual development against the real Screenpipe API, stop only the managed service, run the development server, and restore the managed service when finished:

```bash
npm run service:stop
npm run dev:http

# After stopping the development server with Ctrl-C:
npm run service:start
```

Screenpipe can remain running throughout this workflow. The development server reuses its local API and captured history.

Running two `computer-history-mcp` instances concurrently is an advanced, unsupported-by-default workflow. If it is unavoidable, isolate all of the following:

- HTTP port and authentication token
- application home and `config.yaml`
- derived SQLite database and vector data
- retrieval checkpoint, privacy state, runtime registry, routines, and logs

Keep `trim` disabled on the secondary instance, and do not run `privacy-control delete-range` or Screenpipe maintenance from it. Separate derived stores prevent writer conflicts, but both instances still share the same upstream Screenpipe data and would duplicate indexing and embedding work.

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
| `~/.computer-history-mcp/config.yaml` | Server configuration (embedding provider, port, etc.) |
| `~/.computer-history-mcp/data/` | Reserved local data directory; it may be absent. Current default derived artifacts are stored at the app-home root, including `derived.sqlite`. |
| `~/.computer-history-mcp/logs/` | Service logs and maintenance run records |
| `~/.computer-history-mcp/routines/definitions/` | Routine definition JSON files (one per routine, slug-named) |
| `~/.computer-history-mcp/routines/history/` | Routine execution history JSON files (one per routine, newest first) |
| `~/.screenpipe/` | Screenpipe raw capture data (managed by Screenpipe, not this server) |

For details on what gets captured and how to control it, see [Privacy & Data](/reference/privacy).
