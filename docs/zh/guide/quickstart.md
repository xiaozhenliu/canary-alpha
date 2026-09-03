---
doc_version: 7
doc_status: active
last_updated: 2026-09-04
---

# 快速开始

从一台干净的 macOS 机器到第一次成功的 MCP 工具调用。

## 前提条件

- macOS
- Node.js 22+
- 经过实测的 MIT 版本 `screenpipe@0.3.282`
- 约 10 分钟

## 第一步——安装 Screenpipe 并授予权限

安装经过实测的准确版本：

```bash
npm install --global screenpipe@0.3.282
screenpipe --version
```

版本命令必须输出 `screenpipe 0.3.282`。不要使用 `screenpipe@latest`：当前上游版本采用不同许可证，且尚未通过本项目验证。

在 macOS 系统设置中为 `screenpipe` 可执行文件授予**屏幕录制**和**辅助功能**权限。只有在明确启用音频采集时才需要授予**麦克风**权限；本项目默认禁用音频。

无需自行判断 Screenpipe 是否已经运行。第三步的启动命令会自动检查，并在需要时启动本仓库提供的安全后台录制进程。相关默认值参见[隐私与数据](/zh/reference/privacy)。

## 第二步——安装本项目

克隆仓库并安装依赖：

```bash
git clone https://github.com/xiaozhenliu/computer-history-mcp.git
cd computer-history-mcp
npm install
```

预期结果：`npm install` 无报错完成。

## 第三步——从任意本地状态启动

```bash
npm start
```

`npm start` 会自动判断所需路径：

1. 配置或 onboarding 完成标记缺失时，启动或复用 Screenpipe，并继续交互式 onboarding。
2. onboarding 已完成但缺少构建产物时，执行一次构建。
3. 已有完整安装时，并行检查 MCP 和 Screenpipe，只启动缺失组件。

预期结果：命令报告本地启动完成。首次 onboarding 期间可能询问 embedding provider 配置。

### 中文 OCR

需要优先识别中文时，在 `~/.computer-history-mcp/config.yaml` 中配置：

```yaml
capture:
  ocrLanguages: [chinese, english]
```

语言顺序代表优先级；macOS Apple Vision 使用第一个语言作为主要 OCR 模式。recorder 仅在启动时读取此设置，因此修改后需要重启本仓库管理的 recorder：

```bash
npm run recorder:stop
npm run recorder:start
```

如果使用 Screenpipe 桌面应用，请在应用中重启它。更多可用语言和自定义 Screenpipe 路径见[配置文件](/zh/reference/configuration)。

默认 MCP 端点地址：

```text
http://127.0.0.1:18765/mcp
```

## 第四步——接入你的 agent

将任何兼容 MCP 的客户端连接到 `http://127.0.0.1:18765/mcp`：

- [Claude Code 与 Claude Desktop](/zh/guide/clients/claude-code)
- [Cursor](/zh/guide/clients/cursor)
- [Hermes](/zh/guide/clients/hermes)
- [通用 MCP 客户端](/zh/guide/clients/generic-mcp)

::: warning 复用托管服务
其他客户端也应连接这个 HTTP 端点。托管服务运行时，不要再启动共享 `~/.computer-history-mcp` 的 `computer-history-mcp` stdio 或开发进程。安全的开发流程参见[开发时使用服务](/zh/guide/operations#开发时使用服务)。
:::

## 日常使用

始终使用同一个命令。不要先检查本地状态，也不要自行选择底层生命周期命令：

```bash
npm start
```

状态选择细节参见[日常运维](/zh/guide/operations#统一启动入口)。

## 如果出现问题

参见 [排障](/zh/guide/troubleshooting) 获取按症状分类的诊断指南，或运行：

```bash
npm run service:logs
npm run service:status
```
