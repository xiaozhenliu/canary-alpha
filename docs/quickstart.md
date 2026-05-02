---
doc_version: 8
doc_status: active
last_updated: 2026-04-18
---

# Quickstart

This quickstart is the real first-run path for `canary-alpha-mcp` on a clean macOS machine.

It has two layers:

1. install and launch Screenpipe until its local API is healthy on `http://localhost:3030`
2. run this repository's onboarding flow to configure and validate the MCP server

## 1. Install and launch Screenpipe

Recommended path: install the Screenpipe desktop app from <https://screenpi.pe/onboarding>.

What to do on macOS:

1. Download and install the Screenpipe desktop app.
2. Launch Screenpipe.
3. When macOS prompts for permissions, allow:
   - Screen Recording
   - Accessibility
   - Microphone
4. If macOS shows a first-launch warning for the downloaded app, open it from Finder with **Open** so you can approve it.

Alternative terminal path from this repo:

```bash
npm run screenpipe:safe-record
```

This wrapper launches `screenpipe record` with repo-recommended safer defaults for local development: PII removal enabled, bounded local retention, a narrow default ignored-window set for repeated low-value macOS system UI, a small repo-managed ignored-app set for high-risk local apps, and audio and vision capture disabled unless you explicitly pass supported capture flags. Supported audio opt-in flags include `--audio-device`, `--use-system-default-audio`, and `--experimental-coreaudio-system-audio`; supported vision opt-in flags include `--monitor-id`, `--use-all-monitors`, and `--included-windows`. If you do opt into audio capture, the wrapper still defaults transcription off unless you explicitly choose `--audio-transcription-engine`, and an explicit `--disable-audio` overrides the wrapper’s audio-intent defaults.

If you prefer the raw upstream CLI, the equivalent starting point is:

```bash
npx screenpipe@latest record
```

The terminal path starts the Screenpipe daemon and stores data locally under `~/.screenpipe/`.

## 2. Verify Screenpipe before touching this repo

Do not continue until the local Screenpipe API is healthy.

```bash
curl http://localhost:3030/health
```

Expected result: a JSON health response from the local Screenpipe service.

You can also probe the search surface directly:

```bash
curl "http://localhost:3030/search"
```

## 3. Install this repository

This project expects Node.js 22+.

```bash
npm install
```

## 4. Run the MCP-layer onboarding flow

```bash
npm run onboard
```

`npm run onboard` is intentionally scoped to the MCP layer, not Screenpipe installation. Once Screenpipe is already healthy, onboarding will:

- verify `http://localhost:3030`
- prefer local Ollama at `http://localhost:11434/v1` with `nomic-embed-text`
- ask only for hosted embedding API key/base URL/model if Ollama is unavailable or `nomic-embed-text` is missing
- write `~/.canary-alpha-mcp/config.yaml`
- back up any existing app config before overwriting it
- build the project
- start the managed local HTTP service
- run first-run MCP validation with `internal-status`, `recent-activity`, and `search-screen`
- write or update `~/.hermes/config.yaml` with the `screenpipe-memory` MCP server

## 5. Confirm Hermes and the MCP endpoint

`npm run onboard` configures Hermes automatically after the local MCP endpoint validates. Confirm the client registration with:

```bash
hermes mcp list
hermes mcp test screenpipe-memory
```

The official local MCP endpoint is:

```text
http://127.0.0.1:18765/mcp
```

You can re-check the managed service with:

```bash
npm run service:status
```

## 6. Talk to the MCP server through Hermes

Once `hermes mcp test screenpipe-memory` passes, try a bounded tool call through chat:

```bash
hermes chat --toolsets screenpipe-memory --query "Call recent-activity with minutes 10 and summarize what you find."
```

If Hermes can list and test the MCP server but chat fails, the MCP setup is usually healthy and Hermes likely needs its own model/provider credentials configured.

## 7. Boundary: quickstart vs controlled-real evaluation

This quickstart is a real-user setup path against your own machine and your own Screenpipe data.

It is intentionally different from the controlled-real evaluation harness:

- Quickstart: proves the local dependency chain and MCP service are working on this machine now.
- `npm run test:evaluations:v1`: runs the controlled-real Hermes evaluation layer for repeatable evidence and fixture-bounded validation.

Use quickstart to get the system working locally. Use the evaluation harness when you need repeatable validation artifacts.

## Troubleshooting

If `curl http://localhost:3030/health` fails:

- confirm Screenpipe is actually running
- on macOS, confirm Screen Recording, Accessibility, and Microphone permissions are granted
- if the downloaded app is blocked on first launch, open it manually from Finder once and approve it

If `npm run onboard` fails after Screenpipe is healthy, continue with:

```bash
npm run service:logs
npm run service:status
```

Then review [docs/troubleshooting.md](./troubleshooting.md).
