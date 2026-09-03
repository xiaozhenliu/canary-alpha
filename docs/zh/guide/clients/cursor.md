---
doc_version: 2
doc_status: active
last_updated: 2026-09-04
---

# Cursor

## 前提条件

`computer-history-mcp` 服务必须已经运行。如果尚未完成，请先按 [快速开始](/zh/guide/quickstart) 操作。

验证服务健康状态：

```bash
npm run service:status
```

## 通过 Cursor 设置界面添加

打开 Cursor 设置 → **MCP** → **添加新 MCP 服务**。

- 名称：`computer-history-mcp`
- 类型：**HTTP**
- URL：`http://127.0.0.1:18765/mcp`

保存后，如有提示请重启 Cursor。

## 通过配置文件添加

Cursor MCP 服务也可以通过 JSON 文件配置。

**全局配置**（适用于所有项目）：`~/.cursor/mcp.json`

**项目级配置**（仅适用于单个项目）：仓库根目录下的 `.cursor/mcp.json`

两个文件使用相同的 `mcpServers` 结构。推荐 HTTP 传输连接已运行的服务：

```json
{
  "mcpServers": {
    "computer-history-mcp": {
      "url": "http://127.0.0.1:18765/mcp"
    }
  }
}
```

或使用 stdio 传输连接构建产物（将 `<repo-path>` 替换为仓库绝对路径）：

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

stdio 方式需要先运行 `npm run build`。

## 验证连接

在 Cursor AI 面板中提问：*"调用 internal-status 工具并告诉我服务模式。"*

预期：响应包含 `status: ok`。

## 常见问题

**MCP 服务未出现**：编辑配置文件后重启 Cursor。

**服务未运行**：运行 `npm start`，再用 `npm run service:status` 确认。

**stdio 入口缺失**：运行 `npm run build` 生成 `dist/src/index.js`。

更多内容参见 [排障](/zh/guide/troubleshooting)。
