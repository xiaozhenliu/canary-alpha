---
doc_version: 1
doc_status: active
last_updated: 2026-06-12
---

# 介绍

`canary-alpha-mcp` 是一个本地优先的 MCP 服务，将 Screenpipe 屏幕记忆、长期记忆、本地文件分析和隐私控制封装为标准 [Model Context Protocol](https://modelcontextprotocol.io/) 工具。它完全运行在本机，通过仅限回环地址的 Streamable HTTP 端点（`http://127.0.0.1:18765/mcp`）供任何兼容 MCP 的客户端接入。

它解决的问题是：AI agent 对你实际在电脑上做的事一无所知。当你问"今天早上我在做什么"或"找一下昨天看到的那个链接"时，每次对话都要从零开始。`canary-alpha-mcp` 通过在本地索引你的 Screenpipe 活动，并通过聚焦的 MCP 接口提供检索能力，填补了这一空缺——而不会把你的活动流发送给任何云端服务。

## 工作原理

Screenpipe 持续采集你的屏幕活动并存储在本地。本服务读取这些数据，构建混合索引（FTS5 关键词检索 + 向量嵌入），并通过 MCP 工具暴露检索能力：

```
Screenpipe 守护进程
  └─ 采集屏幕活动 → ~/.screenpipe/
       └─ canary-alpha-mcp
            ├─ 索引帧数据（FTS5 + 向量嵌入）
            └─ 暴露 MCP 工具：find / recall / inspect / memory / ...
                  └─ 任意 MCP 客户端（Claude Code、Cursor、Hermes ...）
```

当 agent 调用 `recall` 或 `find` 时，服务在本地索引上执行混合检索（BM25 关键词排名与向量相似度融合），返回证据片段，不会把你的活动数据发送给外部服务。

## 它不是什么

- **不是前端产品。** 没有 Web UI 或桌面应用。所有能力仅通过 MCP 工具和资源暴露。
- **不是云服务。** 服务仅绑定 `127.0.0.1`，你的屏幕数据留在本机。
- **不是 Screenpipe 的替代品。** 本服务依赖 Screenpipe 采集和存储屏幕活动，在其之上提供 MCP 接口层；Screenpipe 必须运行，检索才能工作。

## 下一步

- [快速开始](/zh/guide/quickstart) — 从零配置到第一次成功的工具调用
- [接入客户端](/zh/guide/clients/claude-code) — Claude Code、Cursor、Hermes 等
