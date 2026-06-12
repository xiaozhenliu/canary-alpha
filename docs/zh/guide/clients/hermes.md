---
doc_version: 1
doc_status: active
last_updated: 2026-06-12
---

# Hermes

本文介绍如何将 Hermes Agent 连接到本地 `canary-alpha-mcp` MCP 服务并完成首次真实工具调用。

## 前提条件

在继续之前，请先完成 [快速开始](/zh/guide/quickstart)——服务必须已经运行。此外还需要：

1. **Hermes CLI 在 `PATH` 中** — 从上游 Hermes 项目安装。参见 [Hermes 安装说明](https://github.com/HermesMCP/hermes)。
2. **`~/.hermes/config.yaml` 已配置可用的 LLM provider** — Hermes 负责调用 LLM，本仓库不写入 provider 凭证。参见上游 Hermes provider 配置文档。推荐使用 DeepSeek（`https://api.deepseek.com`）。

`npm run onboard` 步骤会自动将 `canary-alpha-mcp` 条目写入 `~/.hermes/config.yaml`。如果 onboarding 时 Hermes 尚未安装，安装后配置条目已就绪，无需重新运行 onboard。

## 操作步骤

### 1. 启动 MCP 服务（如果尚未运行）

```bash
npm run service:start
```

### 2. 验证 MCP 服务

```bash
npm run service:status
```

预期：显示端点健康，例如 `endpoint: http://127.0.0.1:18765/mcp (healthy)`。

### 3. 运行端到端冒烟验证

```bash
npm run hermes:verify
```

该命令会：
1. 检测 `PATH` 中的 Hermes CLI
2. 从 `~/.canary-alpha-mcp/config.yaml` 读取 MCP 端点
3. 探测 `/mcp` 服务
4. 使用你的 `~/.hermes/config.yaml` 运行真实的 Hermes 聊天场景（无 stub，无隔离 HOME）
5. 检查 Hermes 是否调用了 `internal-status` 工具
6. 打印 `Pass_Fail_Summary`

成功时预期输出：
```
=== Pass_Fail_Summary ===
outcome:        pass
hermesVersion:  <version>
mcpEndpoint:    http://127.0.0.1:18765/mcp
toolExercised:  internal-status
failureMode:    none
=========================

hermes:verify passed.
- endpoint: http://127.0.0.1:18765/mcp
- hermes: <version>
```

## 示例聊天查询

onboarding 完成后，可直接运行 Hermes 聊天：

```bash
hermes chat --toolsets canary-alpha-mcp \
  --query "Use only the configured MCP server. Call internal-status and report the server mode and retrieval status."
```

预期：Hermes 调用 `internal-status`，返回 `status: ok`、`mode: http`。

其他常用查询：

```bash
# 回忆最近活动
hermes chat --toolsets canary-alpha-mcp \
  --query "Call recall over the last 10 minutes with granularity session and summarize what you see."

# 搜索特定内容
hermes chat --toolsets canary-alpha-mcp \
  --query "Use find with query 'meeting notes' in hybrid mode and report the top result."
```

## 故障模式

### hermes-missing

**症状**：`npm run hermes:verify` 打印 `[hermes-missing]` 并以非零退出。

**原因**：`hermes` CLI 不在 `PATH` 中。

**处理**：从 [上游安装说明](https://github.com/HermesMCP/hermes) 安装 Hermes，然后重新运行 `npm run hermes:verify`。

### llm-not-configured

**症状**：`npm run hermes:verify` 打印 `[llm-not-configured]` 并以非零退出。

**原因**：Hermes 已安装但 `~/.hermes/config.yaml` 中未配置可用的 LLM provider。

**处理**：在 `~/.hermes/config.yaml` 中配置 model 和 provider。本仓库不写入 provider 凭证，这是用户责任。

### mcp-service-down

**症状**：`npm run hermes:verify` 打印 `[mcp-service-down]` 并以非零退出。

**原因**：本地 MCP 服务在配置的端点不可达。

**处理**：
```bash
npm run service:start
npm run service:status
npm run service:logs
```

### tool-call-failed

**症状**：`npm run hermes:verify` 打印 `[tool-call-failed]` 并打印 transcript 文件路径。

**原因**：Hermes 连接了 LLM 和 MCP 服务，但聊天场景未产生 `internal-status` 工具调用的证据。

**处理**：
1. 检查打印路径处的 transcript 文件
2. 确认 `canary-alpha-mcp` 出现在 `hermes mcp list` 中
3. 运行 `hermes mcp test canary-alpha-mcp` 验证工具发现
4. 参见 [通用 MCP 客户端](/zh/guide/clients/generic-mcp) 了解完整工具集
5. 重新运行 `npm run hermes:verify`

## 相关文档

- [通用 MCP 客户端](/zh/guide/clients/generic-mcp) — 任意 MCP 客户端的传输期望和工具集
- [MCP 工具参考](/zh/reference/tools) — 完整工具集参考
- [快速开始](/zh/guide/quickstart) — 首次运行配置
- [排障](/zh/guide/troubleshooting) — 按症状诊断
