---
doc_version: 1
doc_status: active
last_updated: 2026-06-12
---

# 通用 MCP 客户端

本文适用于将任意兼容 MCP 的客户端连接到 `canary-alpha-mcp` HTTP 端点的场景。

## 官方端点

官方 v1 端点为：

```
http://127.0.0.1:18765/mcp
```

本服务仅限本地访问，托管服务会拒绝非本机来源的连接。

## 连接前准备

请先完成 [快速开始](/zh/guide/quickstart)。Onboarding 会写入应用配置、启动托管服务并验证 MCP 端点。

对于手动通用客户端配置，使用 onboarding 或 `npm run service:status` 获取已验证的端点地址。

正常的状态输出示例：

```text
endpoint: http://127.0.0.1:18765/mcp (healthy)
```

## 传输说明

- 传输协议：Streamable HTTP
- 主机：`127.0.0.1`
- 路径：`/mcp`
- 认证：v1 本地版本不需要认证
- 作用域：仅本机

## 通用客户端检查清单

任何客户端均应支持以下步骤：

1. 使用 Streamable HTTP 添加新 MCP 服务
2. 将服务 URL 设置为 `http://127.0.0.1:18765/mcp`
3. 连接并列出可用工具
4. 确认以下工具出现：
   - `find`
   - `recall`
   - `inspect`
   - `memory-read`
   - `memory-write`
   - `file-analyze`
   - `privacy-control`
   - `screenpipe-control`
   - `internal-status`
5. 以 `{}` 调用 `internal-status` 确认运行时健康
6. 运行简单检索调用（如 `recall` 或 `find`）

## 建议的首次调用

### 健康检查

工具：`internal-status`

```json
{}
```

预期响应字段：

- `status: ok`
- `mode: http`
- `host: 127.0.0.1`
- `port: <configured port>`
- `configFile: ~/.canary-alpha-mcp/config.yaml`
- `retrieval.recoveryStatus: ready | needs-rebuild | degraded`

### 检索冒烟测试

工具：`recall`

```json
{
  "from": "<十分钟前的 ISO 时间戳>",
  "to": "<当前 ISO 时间戳>",
  "granularity": "session",
  "includeSummary": false
}
```

或工具：`find`

```json
{
  "query": "note",
  "mode": "hybrid"
}
```

## 验证命令

在客户端之外，以下仓库命令可验证相同路径：

```bash
npm run service:status
npm run test:http-tool-flow
npm run smoke:http
```

如果要专门验证 onboarding 后的 Hermes：

```bash
hermes mcp list
hermes mcp test canary-alpha-mcp
```

## 常见集成错误

### 传输协议错误

如果要验证官方 v1 交付路径，不要使用 stdio——请使用 Streamable HTTP。

### URL 错误

使用 `/mcp` 路径，不要只写主机和端口。

### 服务未构建

`npm run service:start` 需要 `dist/src/index.js` 构建产物，绕过 `npm run onboard` 时请先运行 `npm run build`。

### 端点不健康

如果客户端能访问端口但工具调用失败，运行 `npm run service:status`。它会验证真实的 MCP `internal-status` 契约，而不仅仅是进程是否存在。

## 相关文档

- [MCP 工具参考](/zh/reference/tools) — 完整工具集参考
- [配置文件](/zh/reference/configuration) — 配置选项
- [排障](/zh/guide/troubleshooting) — 按症状诊断
- [快速开始](/zh/guide/quickstart) — 首次运行配置
