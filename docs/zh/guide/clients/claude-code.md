---
doc_version: 2
doc_status: active
last_updated: 2026-09-04
---

# Claude Code 与 Claude Desktop

## 前提条件

`computer-history-mcp` 服务必须已经运行。如果尚未完成，请先按 [快速开始](/zh/guide/quickstart) 操作。

验证服务健康状态：

```bash
npm run service:status
```

## Claude Code（HTTP 传输）

Claude Code 可直接连接到正在运行的 HTTP 服务：

```bash
claude mcp add --transport http computer-history-mcp http://127.0.0.1:18765/mcp
```

这会将服务注册到 Claude Code 的 MCP 配置中。下次启动 Claude Code 会话时，工具集将自动可用。

**验证连接：**

向 Claude 提问：*"调用 internal-status 工具并报告结果。"*

预期：Claude 调用 `internal-status` 并返回 `status: ok`、`mode: http`。

## Claude Desktop（stdio 传输）

Claude Desktop 通过 JSON 配置文件使用 stdio 传输。找到或创建以下文件：

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

将 `computer-history-mcp` 添加到 `mcpServers` 对象中。将 `<repo-path>` 替换为你的本地仓库绝对路径：

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

`dist/src/index.js` 入口点由 `npm run build` 构建。如果提示文件不存在，请先在仓库根目录运行 `npm run build`。

编辑完配置后重启 Claude Desktop，`computer-history-mcp` 的工具应出现在工具列表中。

**验证连接：**

向 Claude Desktop 提问：*"调用 internal-status 并告诉我服务模式。"*

预期：响应包含 `mode: stdio`。

## 常见问题

**服务未运行**：Claude Code 提示服务不可达。运行 `npm start`，再用 `npm run service:status` 确认。

**端口错误**：默认端口为 `18765`。如果在 `~/.computer-history-mcp/config.yaml` 中修改了端口，请相应更新 URL。

**stdio 入口缺失**：运行 `npm run build` 生成 `dist/src/index.js`。

更多内容参见 [排障](/zh/guide/troubleshooting)。
