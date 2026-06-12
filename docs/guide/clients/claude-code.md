---
doc_version: 1
doc_status: active
last_updated: 2026-06-12
---

# Claude Code & Claude Desktop

## Prerequisites

The `canary-alpha-mcp` service must be running. If you haven't done so yet, follow the [Quickstart](/guide/quickstart) first.

Verify the service is healthy:

```bash
npm run service:status
```

## Claude Code (HTTP transport)

Claude Code can connect directly to the running HTTP service:

```bash
claude mcp add --transport http canary-alpha-mcp http://127.0.0.1:18765/mcp
```

This registers the server in your Claude Code MCP configuration. The next time you start a Claude Code session, the tool surface will be available.

**Verify the connection:**

Ask Claude: *"Call the internal-status tool and report the result."*

Expected: Claude calls `internal-status` and returns `status: ok`, `mode: http`.

## Claude Desktop (stdio transport)

Claude Desktop uses stdio transport via a JSON config file. Locate or create:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add `canary-alpha-mcp` to the `mcpServers` object. Replace `<repo-path>` with the absolute path to your local checkout:

```json
{
  "mcpServers": {
    "canary-alpha-mcp": {
      "command": "node",
      "args": ["<repo-path>/dist/src/index.js", "--mode", "stdio"]
    }
  }
}
```

The `dist/src/index.js` entry point is built by `npm run build`. If you see errors about the file not existing, run `npm run build` from the repo root first.

Restart Claude Desktop after editing the config. The `canary-alpha-mcp` tools should appear in the tool list.

**Verify the connection:**

Ask Claude Desktop: *"Call internal-status and tell me the server mode."*

Expected: response includes `mode: stdio`.

## Common issues

**Service not running**: Claude Code says the server is unreachable. Run `npm run service:start` and check with `npm run service:status`.

**Wrong port**: The default port is `18765`. If you changed it in `~/.canary-alpha-mcp/config.yaml`, update the URL accordingly.

**stdio entry point missing**: Run `npm run build` to produce `dist/src/index.js`.

For more, see [Troubleshooting](/guide/troubleshooting).
