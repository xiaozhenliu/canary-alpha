---
doc_version: 5
doc_status: active
last_updated: 2026-06-12
---

# Hermes delivery proof

## Role in Phase 4

Hermes is the official main client example for Phase 4. Its job is not to replace deterministic acceptance; its job is to provide bounded real-agent interoperability evidence against the local HTTP MCP service.

Deterministic Vitest acceptance remains the fast debugging backbone. Hermes adds a bounded outer proof that a real MCP-capable agent can discover and use the delivered local resident HTTP service bound to `127.0.0.1`.

Stdio remains available only for compatibility and deterministic testing, and neither stdio nor Claude Desktop is the official v1 delivery path.

## Canonical release command set

Use the same canonical focused v1 command set referenced by the public delivery docs:

```bash
npm run setup
npm run build
npm run service:start
npm run service:status
npm run test
npm run test:hermes:phase4
```

Use `README.md` for the concise release path and `docs/delivery/http-service.md` for the managed-service runtime contract.

## User onboarding config

For the normal user path, `npm run onboard` writes or updates `~/.hermes/config.yaml` with the `canary-alpha-mcp` MCP server after the local MCP service validates. It preserves existing Hermes settings and other MCP servers, and it does not call interactive `hermes mcp add`.

Verify the real user config with:

```bash
hermes mcp list
hermes mcp test canary-alpha-mcp
```

## Endpoint

Hermes should target the official local resident MCP service:

- `http://127.0.0.1:<port>/mcp`

## Bounded Phase 4 smoke gate

Run:

```bash
npm run test:hermes:phase4
```

The script:

1. verifies Hermes CLI is installed
2. reads `~/.canary-alpha-mcp/config.yaml`
3. verifies the local HTTP service is reachable at `/mcp`
4. creates an isolated temporary Hermes home
5. registers the local MCP server in that isolated config
6. captures Hermes MCP discovery and connectivity evidence
7. attempts one bounded real-agent chat scenario

## Evidence

Evidence is written to:

- `.planning/phases/04-delivery-setup-recovery/evidence/hermes/`

Important files:

- `endpoint-probe.json`
- `hermes-config.yaml`
- `hermes-mcp-list.txt`
- `hermes-mcp-test.txt`
- `hermes-status.txt`
- `hermes-chat.txt`
- `SUMMARY.json`

## Scenario boundary

The scripted Hermes scenario is intentionally narrow:

- confirm MCP connectivity to the delivered HTTP service
- confirm tool discovery through Hermes
- attempt a bounded retrieval flow using `internal-status` and `recall`

This bounded outer proof is not intended to prove open-ended agent quality, replace `npm run onboard`, or replace the deterministic retrieval acceptance suite.

## Failure modes

The script uses distinct failure-mode labels in its error output to make triage unambiguous. Each label is shown in brackets alongside a human-readable message.

### `hermes-missing`

If `hermes` is not installed or not on `PATH`, the script fails with an actionable setup message.

### `mcp-service-down`

The script emits this label for three distinct sub-cases, each with its own next-step hints:

- configuration cannot be loaded — suggests `npm run setup` and `npm run service:status`
- the configured host is not `127.0.0.1` (non-loopback) — reports the resolved host; no service command is suggested because the fix is editing `~/.canary-alpha-mcp/config.yaml`
- the HTTP service is unreachable — suggests `npm run service:start`, `npm run service:status`, and `npm run service:logs`

### `llm-not-configured`

If Hermes can reach the MCP service but has no working LLM provider configuration, the script fails with a message directing the user to configure a provider before re-running the smoke gate.

### `tool-call-failed`

This is the catch-all branch: the MCP endpoint probe passed and `llm-not-configured` was not detected, but the Hermes chat did not successfully call `internal-status` (the expected tool marker was absent or the chat exited non-zero). Causes include a genuine tool-call failure, a chat timeout, or an unrecognized error. The script still writes the full transcript to a temp file and points to it — the transcript, not the label, is the source of truth for triage.

That distinction matters: the MCP endpoint may probe healthy even when real-agent execution does not reach the tool.
