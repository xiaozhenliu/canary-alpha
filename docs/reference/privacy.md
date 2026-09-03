---
doc_version: 1
doc_status: active
last_updated: 2026-06-12
---

# Privacy & Data

## Data locality

`computer-history-mcp` is local-only by design:

- The managed HTTP service binds exclusively to `127.0.0.1`. It will not accept connections from other machines.
- All derived data (indexes, config, logs) is stored under `~/.computer-history-mcp/` on your local machine.
- The server makes no outbound network calls except to the embedding endpoint you configure (local Ollama by default).
- There is no telemetry or usage reporting.

## What gets captured

Screenpipe is responsible for capturing your screen activity. `computer-history-mcp` reads and indexes that data — it does not control what Screenpipe captures.

When you start Screenpipe with `npm run screenpipe:safe-record`, this repo's wrapper applies safer local-development defaults:

- **PII removal**: enabled
- **Retention**: bounded local retention
- **Ignored windows**: a narrow default set for repeated low-value macOS system UI
- **Ignored apps**: a small repo-managed set for high-risk local apps
- **Audio capture**: disabled by default — opt in with `--audio-device`, `--use-system-default-audio`, or `--experimental-coreaudio-system-audio`
- **Vision capture**: disabled by default — opt in with `--monitor-id`, `--use-all-monitors`, or `--included-windows`
- **Audio transcription**: off by default even when audio is enabled — opt in with `--audio-transcription-engine`; an explicit `--disable-audio` overrides the wrapper's audio-intent defaults

If you use the Screenpipe desktop app instead, capture settings are controlled in the Screenpipe app preferences.

## Runtime privacy controls

The `privacy-control` MCP tool lets any connected agent inspect and modify collection controls at runtime:

```json
{ "action": "status" }
```

Returns current collection state, pause status, and the excluded-app list.

```json
{ "action": "pause" }
```

Pauses Screenpipe capture immediately.

```json
{ "action": "resume" }
```

Resumes capture.

```json
{ "action": "exclude-app", "app": "AppName" }
```

Adds an application to the excluded list. Pass `"rebuild": true` to also rebuild the retrieval index after the exclusion.

The same actions are available from the command line via the `scripts/privacy-control.js` script:

```bash
node scripts/privacy-control.js status
node scripts/privacy-control.js pause
node scripts/privacy-control.js resume
node scripts/privacy-control.js exclude-app --app "Claude"
```

## Storage & retention

| Path | Contents |
|------|----------|
| `~/.computer-history-mcp/config.yaml` | Server configuration |
| `~/.computer-history-mcp/logs/` | Service logs and maintenance records |
| `~/.computer-history-mcp/logs/screenpipe-maintenance.jsonl` | Maintenance run records |
| `~/.screenpipe/` | Raw Screenpipe capture data (managed by Screenpipe) |

**Maintenance log rotation**: `screenpipe-maintenance.jsonl` is pruned to the last 7 days and rotated to `screenpipe-maintenance.jsonl.1` when it exceeds 1 MB.

Screenpipe raw data under `~/.screenpipe/` is managed by Screenpipe itself. To delete captured ranges, use the `privacy-control` tool with the appropriate delete action, or manage it directly through the Screenpipe desktop app.
