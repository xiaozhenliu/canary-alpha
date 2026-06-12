---
doc_version: 13
doc_status: active
last_updated: 2026-06-12
---

# Quickstart

From a clean macOS machine to your first successful MCP tool call.

## Prerequisites

- macOS
- Node.js 22+
- About 10 minutes

## Step 1 — Install and launch Screenpipe

Install the Screenpipe desktop app from [screenpi.pe/onboarding](https://screenpi.pe/onboarding). After launch, grant macOS the requested permissions: **Screen Recording**, **Accessibility**, and **Microphone**. If macOS blocks the app on first launch, open it from Finder and click **Open** to approve it.

Verify the local Screenpipe API is running before continuing:

```bash
curl http://localhost:3030/health
```

Expected result: a JSON health response. Do not proceed until this returns successfully.

**Terminal alternative:** If you prefer not to use the desktop app, you can start Screenpipe from this repo with safer local defaults via `npm run screenpipe:safe-record`. See [Privacy & Data](/reference/privacy) for what those defaults are.

## Step 2 — Install this project

Clone the repo and install dependencies:

```bash
git clone https://github.com/xiaozhenliu/canary-alpha.git
cd canary-alpha
npm install
```

Expected result: `npm install` completes without errors.

## Step 3 — Run onboarding

```bash
npm run onboard
```

The onboarding script does the following:

1. Verifies `http://localhost:3030` is reachable
2. Probes for a local Ollama embedding model; asks for a hosted API key only if unavailable
3. Writes `~/.canary-alpha-mcp/config.yaml`
4. Builds the project and starts the managed local HTTP service
5. Runs first-run MCP validation (`internal-status`, `recall`, `find`)

Expected result: the script completes with all checks passing.

## Step 4 — Verify

Check that the managed service is running:

```bash
npm run service:status
```

The MCP endpoint is available at:

```text
http://127.0.0.1:18765/mcp
```

Expected result: service status shows `running` and the endpoint responds.

## Step 5 — Connect your agent

Connect any MCP-compatible client to `http://127.0.0.1:18765/mcp`:

- [Claude Code & Claude Desktop](/guide/clients/claude-code)
- [Cursor](/guide/clients/cursor)
- [Hermes](/guide/clients/hermes)
- [Generic MCP Client](/guide/clients/generic-mcp)

## If something fails

See [Troubleshooting](/guide/troubleshooting) for symptom-based guidance, or run:

```bash
npm run service:logs
npm run service:status
```
