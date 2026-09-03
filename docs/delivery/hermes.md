---
doc_version: 7
doc_status: active
last_updated: 2026-06-13
---

# Hermes delivery proof

## Role in Phase 4

Hermes is the official main client example for Phase 4. Its job is not to replace deterministic acceptance; its job is to provide bounded real-agent interoperability evidence against the local HTTP MCP service.

Deterministic Vitest acceptance remains the fast debugging backbone. Hermes adds a bounded outer proof that a real MCP-capable agent can discover and use the delivered local resident HTTP service bound to `127.0.0.1`.

Stdio remains available only for compatibility and deterministic testing, and neither stdio nor Claude Desktop is the official v1 delivery path.

## Verification entry points

Three commands exercise the delivered service from a real Hermes agent, each with a distinct boundary. This document is the single home for all three; the end-user connection walkthrough lives in [docs/guide/clients/hermes.md](../guide/clients/hermes.md).

| Command | Script | Tools exercised | Outcome vocabulary | Purpose |
|---------|--------|-----------------|--------------------|---------|
| `npm run hermes:verify` | `scripts/hermes-e2e.js` | `internal-status` | bracketed failure-mode labels (see [Failure modes](#failure-modes)) | Canonical post-onboarding connectivity check |
| `npm run test:hermes:phase4` | `scripts/hermes-phase4-smoke.js` | `internal-status` + `recall` | chat outcome `passed` / `blocked` / `skipped` (uses `fail()`, not bracketed labels) | Bounded Phase 4 delivery gate — detailed below |
| `npm run e2e:live` | `scripts/e2e-live-run.js` | `recall` + `find` | shares the bracketed labels below, plus `build-failed`, `config-missing`, `screenpipe-unhealthy`, `empty-recall` | Full live retrieval run over a freshly recorded window. Builds the current source first (so the service under test reflects HEAD), then records, polls index readiness, and recalls |

The detailed sections below describe the Phase 4 gate. `hermes:verify` and `e2e:live` deliberately share the failure-mode vocabulary documented under [Failure modes](#failure-modes) (`scripts/e2e-live-run-lib.js` mirrors `scripts/hermes-e2e.js`'s signal lists).

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

For the normal user path, `npm run onboard` writes or updates `~/.hermes/config.yaml` with the `computer-history-mcp` MCP server after the local MCP service validates. It preserves existing Hermes settings and other MCP servers, and it does not call interactive `hermes mcp add`.

Verify the real user config with:

```bash
hermes mcp list
hermes mcp test computer-history-mcp
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
2. reads `~/.computer-history-mcp/config.yaml`
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

These bracketed labels are the shared failure-mode vocabulary of `npm run hermes:verify` (`scripts/hermes-e2e.js`) and `npm run e2e:live` (`scripts/e2e-live-run.js`); each label is shown in brackets alongside a human-readable message. `npm run test:hermes:phase4` instead reports a chat outcome of `passed` / `blocked` / `skipped` and does not emit these labels.

The four labels below are emitted by `hermes:verify`. `e2e:live` reuses `llm-not-configured` and `tool-call-failed`, and adds `build-failed` (`npm run build` failed in preflight — the run aborts before touching any service so it never validates stale code), `config-missing` (config file absent), `screenpipe-unhealthy` (recorder not healthy), and `empty-recall` (recall ran but returned no data, decided by a direct ground-truth `recall` probe over the window).

### `hermes-missing`

If `hermes` is not installed or not on `PATH`, the script fails with an actionable setup message.

### `mcp-service-down`

The script emits this label for three distinct sub-cases, each with its own next-step hints:

- configuration cannot be loaded — suggests `npm run setup` and `npm run service:status`
- the configured host is not `127.0.0.1` (non-loopback) — reports the resolved host; no service command is suggested because the fix is editing `~/.computer-history-mcp/config.yaml`
- the HTTP service is unreachable — suggests `npm run service:start`, `npm run service:status`, and `npm run service:logs`

### `llm-not-configured`

If Hermes can reach the MCP service but has no working LLM provider configuration, the script fails with a message directing the user to configure a provider before re-running the smoke gate.

### `tool-call-failed`

This is the catch-all branch: the MCP endpoint probe passed and `llm-not-configured` was not detected, but the Hermes chat did not successfully call `internal-status` (the expected tool marker was absent or the chat exited non-zero). Causes include a genuine tool-call failure, a chat timeout, or an unrecognized error. The script still writes the full transcript to a temp file and points to it — the transcript, not the label, is the source of truth for triage.

That distinction matters: the MCP endpoint may probe healthy even when real-agent execution does not reach the tool.
