---
doc_version: 3
doc_status: active
last_updated: 2026-06-12
---

# Hermes

This document walks you through connecting Hermes Agent to the local `canary-alpha-mcp` MCP service and running your first real tool call.

## Prerequisites

Before following this walkthrough, complete the [Quickstart](/guide/quickstart) first — the service must already be running. Then make sure you have:

1. **Hermes CLI on `PATH`** — Install from the upstream Hermes project. See the [Hermes install instructions](https://github.com/HermesMCP/hermes) for the current install path.
2. **`~/.hermes/config.yaml` configured with a working LLM provider** — Hermes calls the LLM; this repo does not write provider credentials. See the upstream Hermes provider-configuration docs for how to set `model` and `provider` fields. For workspace examples, DeepSeek (`https://api.deepseek.com`) is the recommended provider.

The `npm run onboard` step from the Quickstart automatically writes a `canary-alpha-mcp` entry into `~/.hermes/config.yaml`. If Hermes was not installed at that time, install it and the config entry will already be waiting.

## Step-by-step walkthrough

### 1. Start the MCP service (if not already running)

```bash
npm run service:start
```

### 2. Verify the MCP service

```bash
npm run service:status
```

Expected: endpoint reported as healthy, e.g. `endpoint: http://127.0.0.1:18765/mcp (healthy)`.

### 3. Run the end-to-end smoke gate

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
4. See [Generic MCP Client](/guide/clients/generic-mcp) for the full tool surface.
5. Re-run `npm run hermes:verify`.

## Related documents

- [Generic MCP Client](/guide/clients/generic-mcp) — Transport expectations and tool surface for any MCP client
- [MCP Tools Reference](/reference/tools) — Full tool surface reference
- [Quickstart](/guide/quickstart) — First-run setup
- [Troubleshooting](/guide/troubleshooting) — Symptom-based diagnosis
