---
doc_version: 19
doc_status: active
last_updated: 2026-09-04
---

# Quickstart

From a clean macOS machine to your first successful MCP tool call.

## Prerequisites

- macOS
- Node.js 22+
- The tested MIT release, `screenpipe@0.3.282`
- About 10 minutes

## Step 1 — Install Screenpipe and grant permissions

Install the exact tested Screenpipe release:

```bash
npm install --global screenpipe@0.3.282
screenpipe --version
```

The version command must report `screenpipe 0.3.282`. Do not use `screenpipe@latest`: current upstream releases use a different license and have not been validated with this project.

Grant the `screenpipe` executable **Screen Recording** and **Accessibility** access in macOS System Settings. Grant **Microphone** access only if you explicitly enable audio capture; this project disables audio by default.

You do not need to decide whether Screenpipe is already running. The startup command in Step 3 checks it and starts the repository's safer background recorder when needed. See [Privacy & Data](/reference/privacy) for those defaults.

### OCR languages

For Chinese-primary OCR, set the language order in `~/.computer-history-mcp/config.yaml`:

```yaml
capture:
  ocrLanguages: [chinese, english]
```

The first language is Apple Vision's primary OCR mode. The recorder reads this setting only when it starts, so restart the repo-managed recorder after changing it:

```bash
npm run recorder:stop
npm run recorder:start
```

If you use the Screenpipe desktop app instead, restart it there. See [Configuration](/reference/configuration) for supported languages and custom Screenpipe paths.

## Step 2 — Install this project

Clone the repo and install dependencies:

```bash
git clone https://github.com/xiaozhenliu/computer-history-mcp.git
cd computer-history-mcp
npm install
```

Expected result: `npm install` completes without errors.

## Step 3 — Start from any local state

```bash
npm start
```

`npm start` determines the required path automatically:

1. If configuration or the onboarding-complete marker is missing, starts or reuses Screenpipe and continues interactive onboarding.
2. If onboarding is complete but build output is missing, builds once.
3. For an existing installation, checks MCP and Screenpipe in parallel and starts only missing components.

Expected result: the command reports that local startup completed. First-time onboarding may ask for embedding-provider configuration.

The default MCP endpoint is:

```text
http://127.0.0.1:18765/mcp
```

## Step 4 — Connect your agent

Connect any MCP-compatible client to `http://127.0.0.1:18765/mcp`:

- [Claude Code & Claude Desktop](/guide/clients/claude-code)
- [Cursor](/guide/clients/cursor)
- [Hermes](/guide/clients/hermes)
- [Generic MCP Client](/guide/clients/generic-mcp)

::: warning Reuse the managed service
Connect additional clients to this same HTTP endpoint. Do not start another `computer-history-mcp` stdio or development process against `~/.computer-history-mcp` while the managed service is running. For the safe development workflow, see [Use the service while developing](/guide/operations#use-the-service-while-developing).
:::

## Daily use

Always use the same command. Do not inspect local state or choose a lower-level lifecycle command first:

```bash
npm start
```

See [Operations](/guide/operations#universal-start) for the state-selection details.

## If something fails

See [Troubleshooting](/guide/troubleshooting) for symptom-based guidance, or run:

```bash
npm run service:logs
npm run service:status
```
