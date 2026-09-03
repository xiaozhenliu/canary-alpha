---
doc_version: 3
doc_status: active
last_updated: 2026-09-04
---

# Introduction

`computer-history-mcp` is a local-first MCP server that wraps Screenpipe screen memory, long-term memory, local file analysis, and privacy controls as standard [Model Context Protocol](https://modelcontextprotocol.io/) tools. It runs entirely on your machine and exposes a loopback-only Streamable HTTP endpoint (`http://127.0.0.1:18765/mcp`) that any MCP-compatible client can connect to.

The problem it solves: AI agents have no memory of what you actually did on your computer. When you ask "what was I working on this morning?" or "find that link I saw yesterday," every conversation starts from scratch. `computer-history-mcp` fills that gap by indexing your Screenpipe activity locally and making it queryable through a focused MCP interface — without sending your activity stream to a hosted service.

## How it works

Screenpipe continuously captures your screen activity and stores it locally. This server reads visible AXTree and OCR data, turns each visible AXTree into tagged context, builds a hybrid index (FTS5 keyword search + vector embeddings), and exposes retrieval through MCP tools:

```
Screenpipe daemon
  └─ captures screen activity → ~/.screenpipe/
       └─ computer-history-mcp
            ├─ extracts [Window] / [Nav] / [Action] / [Body] context
            ├─ keeps only session-scoped line deltas, then indexes frames (FTS5 + vector embeddings)
            └─ exposes MCP tools: find / recall / inspect / memory / ...
                  └─ any MCP client (Claude Code, Cursor, Hermes, ...)
```

The four semantic domains retain different kinds of visible context: `[Window]` names the app or document, `[Nav]` captures tabs, breadcrumbs, channels, and chat partners, `[Action]` captures visible menus and dialogs, and `[Body]` captures the primary content or input. A session-scoped line-hash deduplicator stores a line only when it first appears or changes; it resets after an idle gap, so a new session starts with complete context.

When an agent calls `recall` or `find`, the server queries the local index using hybrid retrieval (keyword match ranked by BM25, fused with vector similarity), returns tagged evidence fragments, and never contacts an external service with your activity data.

## What it is not

- **Not a chat interface.** There is no conversational UI. Capability is exposed through MCP tools; the built-in Dashboard (`http://127.0.0.1:<port>/`) is an operations panel for managing the server, not a product interface.
- **Not a cloud service.** The server binds to `127.0.0.1` only. Your screen data stays on your machine.
- **Not a replacement for Screenpipe.** This server depends on Screenpipe to capture and store your screen activity. It adds the MCP interface layer on top; Screenpipe must be running for retrieval to work.

## Next steps

- [Quickstart](/guide/quickstart) — from a clean machine to your first successful tool call
- [Connect your client](/guide/clients/claude-code) — Claude Code, Cursor, Hermes, and more
