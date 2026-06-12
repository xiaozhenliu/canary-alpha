---
doc_version: 1
doc_status: active
last_updated: 2026-06-12
---

# 快速开始

从一台干净的 macOS 机器到第一次成功的 MCP 工具调用。

## 前提条件

- macOS
- Node.js 22+
- 约 10 分钟

## 第一步——安装并启动 Screenpipe

从 [screenpi.pe/onboarding](https://screenpi.pe/onboarding) 安装 Screenpipe 桌面应用。启动后，授予 macOS 所请求的权限：**屏幕录制**、**辅助功能**、**麦克风**。如果 macOS 在首次启动时拦截该应用，请从 Finder 手动打开并点击 **Open** 授权。

在继续之前，验证本地 Screenpipe API 已运行：

```bash
curl http://localhost:3030/health
```

预期结果：返回 JSON 健康响应。在此成功之前不要继续后续步骤。

**终端替代方式：** 如果不想使用桌面应用，可通过本仓库以更安全的本地默认值启动 Screenpipe（`npm run screenpipe:safe-record`）。具体默认值参见 [隐私与数据](/zh/reference/privacy)。

## 第二步——安装本项目

克隆仓库并安装依赖：

```bash
git clone https://github.com/xiaozhenliu/canary-alpha.git
cd canary-alpha
npm install
```

预期结果：`npm install` 无报错完成。

## 第三步——运行 onboarding

```bash
npm run onboard
```

onboarding 脚本会依次完成：

1. 验证 `http://localhost:3030` 可达
2. 检测本地 Ollama 嵌入模型；仅在不可用时才询问托管 API 密钥
3. 写入 `~/.canary-alpha-mcp/config.yaml`
4. 构建项目并启动本地托管 HTTP 服务
5. 运行首次 MCP 验证（`internal-status`、`recall`、`find`）

预期结果：脚本完成，所有检查通过。

## 第四步——验证

检查托管服务是否运行：

```bash
npm run service:status
```

MCP 端点地址：

```text
http://127.0.0.1:18765/mcp
```

预期结果：服务状态显示 `running`，端点响应正常。

## 第五步——接入你的 agent

将任何兼容 MCP 的客户端连接到 `http://127.0.0.1:18765/mcp`：

- [Claude Code 与 Claude Desktop](/zh/guide/clients/claude-code)
- [Cursor](/zh/guide/clients/cursor)
- [Hermes](/zh/guide/clients/hermes)
- [通用 MCP 客户端](/zh/guide/clients/generic-mcp)

## 如果出现问题

参见 [排障](/zh/guide/troubleshooting) 获取按症状分类的诊断指南，或运行：

```bash
npm run service:logs
npm run service:status
```
