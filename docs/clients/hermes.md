---
doc_version: 2
doc_status: active
last_updated: 2026-06-10
---

# Hermes Quickstart

This document walks you through connecting Hermes Agent to the local `canary-alpha-mcp` MCP service and running your first real tool call.

## Scope of this document

This document covers the path from "Hermes installed and configured to a working LLM provider" to "first real tool call through `npm run hermes:verify`".

It is distinct from:

- **[docs/delivery/hermes.md](../delivery/hermes.md)** — Phase 4 evidence capture. That document describes the bounded smoke gate that runs in an isolated Hermes home and writes evidence files to `.planning/`. It is not a user walkthrough.
- **[docs/clients/generic-mcp.md](./generic-mcp.md)** — Generic MCP client setup for any client. That document covers transport expectations and the tool surface for any MCP-compatible client, not Hermes specifically.

If you landed on the wrong page, use the links above to navigate.

## Prerequisites

Before following this walkthrough, you need:

1. **Hermes CLI on `PATH`** — Install from the upstream Hermes project. See the [Hermes install instructions](https://github.com/HermesMCP/hermes) for the current install path.
2. **`~/.hermes/config.yaml` configured with a working LLM provider** — Hermes calls the LLM; this repo does not write provider credentials. See the upstream Hermes provider-configuration docs for how to set `model` and `provider` fields. For workspace examples, DeepSeek (`https://api.deepseek.com`) is the recommended provider.
3. **Screenpipe running locally** — The Screenpipe desktop app or `npm run screenpipe:safe-record`.
4. **Node.js ≥ 22**.

## Step-by-step walkthrough

### 1. Install dependencies

```bash
npm install
```

### 2. Verify Screenpipe is healthy

```bash
curl http://localhost:3030/health
```

Expected: HTTP 200 with a JSON health payload.

### 3. Run onboarding

```bash
npm run onboard
```

Onboarding:
- writes `~/.canary-alpha-mcp/config.yaml`
- builds the project
- starts the managed local HTTP service
- runs a first MCP validation against your local Screenpipe data
- writes or updates `~/.hermes/config.yaml` with the `canary-alpha-mcp` MCP server entry
- reports the detected Hermes version (or a warning if Hermes is not on `PATH`)

Expected summary output includes:
```
- Hermes MCP config: ~/.hermes/config.yaml
- Hermes MCP server: canary-alpha-mcp
- hermes version: <version>
```

If Hermes is not yet installed, onboarding still completes and writes the Hermes config. Install Hermes afterwards and the config will be ready.

### 4. Start the MCP service (if not already running)

```bash
npm run service:start
```

### 5. Verify the MCP service

```bash
npm run service:status
```

Expected: endpoint reported as healthy, e.g. `endpoint: http://127.0.0.1:18765/mcp (healthy)`.

### 6. Run the end-to-end smoke gate

```bash
npm run hermes:verify
```

This command:
1. Detects Hermes CLI on `PATH`
2. Reads your real `~/.canary-alpha-mcp/config.yaml` to resolve the MCP endpoint
3. Probes the MCP service at `/mcp`
4. Runs a real Hermes chat scenario against your `~/.hermes/config.yaml` (no stubs, no isolated HOME)
5. Checks that Hermes called the `internal-status` tool
6. Prints a `Pass_Fail_Summary`

Expected output on success:
```
=== Pass_Fail_Summary ===
outcome:        pass
hermesVersion:  <version>
mcpEndpoint:    http://127.0.0.1:18765/mcp
toolExercised:  internal-status
failureMode:    none
=========================

hermes:verify passed.
- endpoint: http://127.0.0.1:18765/mcp
- hermes: <version>
```

## Example chat query

After onboarding, you can run Hermes chat directly:

```bash
hermes chat --toolsets canary-alpha-mcp \
  --query "Use only the configured MCP server. Call internal-status and report the server mode and retrieval status."
```

Expected: Hermes calls `internal-status`, returns `status: ok`, `mode: http`.

Other useful queries (all tools are members of the registered tool surface):

```bash
# Recall recent activity
hermes chat --toolsets canary-alpha-mcp \
  --query "Call recall over the last 10 minutes with granularity session and summarize what you see."

# Search for specific content
hermes chat --toolsets canary-alpha-mcp \
  --query "Use find with query 'meeting notes' in hybrid mode and report the top result."
```

## Failure modes

### hermes-missing

**Symptom**: `npm run hermes:verify` prints `[hermes-missing]` and exits non-zero.

**Cause**: The `hermes` CLI is not on `PATH`.

**Action**: Install Hermes from the [upstream install instructions](https://github.com/HermesMCP/hermes), then re-run `npm run hermes:verify`.

### llm-not-configured

**Symptom**: `npm run hermes:verify` prints `[llm-not-configured]` and exits non-zero.

**Cause**: Hermes is installed but `~/.hermes/config.yaml` does not have a working LLM provider configured.

**Action**: Configure a model and provider in `~/.hermes/config.yaml`. See the upstream Hermes provider-configuration docs. For workspace examples, use DeepSeek (`https://api.deepseek.com`). This repo does not write provider credentials — that is user responsibility.

### mcp-service-down

**Symptom**: `npm run hermes:verify` prints `[mcp-service-down]` and exits non-zero.

**Cause**: The local MCP service is not reachable at the configured endpoint.

**Action**:
```bash
npm run service:start
npm run service:status
npm run service:logs
```

### tool-call-failed

**Symptom**: `npm run hermes:verify` prints `[tool-call-failed]` and exits non-zero. A transcript file path is printed.

**Cause**: Hermes connected to the LLM and the MCP service, but the chat scenario did not produce evidence of an `internal-status` tool call.

**Action**:
1. Inspect the transcript at the path printed in the summary.
2. Check that `canary-alpha-mcp` is listed in `hermes mcp list`.
3. Run `hermes mcp test canary-alpha-mcp` to verify tool discovery.
4. See [docs/clients/generic-mcp.md](./generic-mcp.md) for the full tool surface.
5. Re-run `npm run hermes:verify`.

## Related documents

- [docs/delivery/hermes.md](../delivery/hermes.md) — Phase 4 evidence capture (bounded, isolated HOME)
- [docs/clients/generic-mcp.md](./generic-mcp.md) — Generic MCP client setup
- [docs/documentation/mcp-tools.md](../documentation/mcp-tools.md) — Tool surface reference
- [docs/quickstart.md](../quickstart.md) — General quickstart
