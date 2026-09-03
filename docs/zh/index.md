---
layout: home
doc_version: 2
doc_status: active
last_updated: 2026-09-04
hero:
  name: computer-history-mcp
  text: 本地优先的屏幕记忆 MCP 服务
  tagline: 让任何兼容 MCP 的 AI agent 都能检索和摘要你的屏幕活动——所有数据本地存储。
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/quickstart
    - theme: alt
      text: 它是什么？
      link: /zh/guide/introduction
features:
  - title: 结构化屏幕记忆
    details: 通用 AXTree 提取通过 [Window]、[Nav]、[Action]、[Body] 标签保留可见的窗口、导航、操作和正文上下文。
  - title: 差量感知检索
    details: 会话级行去重仅存储新出现或变化的上下文，让 find / recall / inspect 聚焦有意义的活动。
  - title: 兼容所有 MCP 客户端
    details: 支持 Claude Code、Claude Desktop、Cursor、Hermes，以及任何支持 stdio 或 Streamable HTTP 的客户端。
  - title: 本地优先设计
    details: 数据留在你的机器上。服务仅监听 127.0.0.1，内置隐私控制。
---
