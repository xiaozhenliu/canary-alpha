---
doc_version: 1
doc_status: active
last_updated: 2026-06-12
---

# Cursor

## Prerequisites

The `computer-history-mcp` service must be running. If you haven't done so yet, follow the [Quickstart](/guide/quickstart) first.

Verify the service is healthy:

```bash
npm run service:status
```

## Add via Cursor Settings

Open Cursor Settings → **MCP** → **Add new MCP server**.

- Name: `computer-history-mcp`
- Type: **HTTP**
- URL: `http://127.0.0.1:18765/mcp`

Save, then restart Cursor if prompted.

## Add via config file

Cursor MCP servers can also be configured in a JSON file.

**Global** (applies to all projects): `~/.cursor/mcp.json`

**Project-level** (applies to one project): `.cursor/mcp.json` at the repo root

Both files share the same `mcpServers` structure. Choose HTTP transport for the running service:

```json
{
  "mcpServers": {
    "computer-history-mcp": {
      "url": "http://127.0.0.1:18765/mcp"
    }
  }
}
```

Or stdio transport pointing at the built entry point (replace `<repo-path>` with the absolute path to your checkout):

```json
{
  "mcpServers": {
    "computer-history-mcp": {
      "command": "node",
      "args": ["<repo-path>/dist/src/index.js", "--mode", "stdio"]
    }
  }
}
```

The `dist/src/index.js` entry point requires running `npm run build` first.

## Verify the connection

In Cursor's AI panel, ask: *"Call the internal-status tool and tell me the server mode."*

Expected: response includes `status: ok`.

## Common issues

**MCP server not listed**: Restart Cursor after editing the config file.

**Service not running**: Run `npm run service:start` and confirm with `npm run service:status`.

**stdio entry point missing**: Run `npm run build` to produce `dist/src/index.js`.

For more, see [Troubleshooting](/guide/troubleshooting).
