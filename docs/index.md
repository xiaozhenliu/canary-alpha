---
layout: home
doc_version: 2
doc_status: active
last_updated: 2026-09-04
hero:
  name: computer-history-mcp
  text: Local-first MCP server for your screen memory
  tagline: Give any MCP-compatible agent searchable, summarizable access to what you saw and did — all stored locally.
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: What is it?
      link: /guide/introduction
features:
  - title: Structured screen memory
    details: Universal AXTree extraction preserves visible window, navigation, action, and body context with [Window], [Nav], [Action], and [Body] tags.
  - title: Delta-aware retrieval
    details: Session-scoped line deduplication stores only newly appeared or changed context, keeping find / recall / inspect focused on meaningful activity.
  - title: Works with any MCP client
    details: Claude Code, Claude Desktop, Cursor, Hermes, or any client speaking stdio or Streamable HTTP.
  - title: Local-first by design
    details: Data stays on your machine. The server listens on 127.0.0.1 only, with built-in privacy controls.
---
