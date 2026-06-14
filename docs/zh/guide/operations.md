---
doc_version: 3
doc_status: active
last_updated: 2026-06-13
---

# 日常运维

`canary-alpha-mcp` 服务的日常管理、诊断和维护命令。

## 一键启动（单条命令）

```bash
npm run up      # 构建、启动托管 MCP 服务、并开始 Screenpipe 录制
npm run down    # 停止托管 MCP 服务
```

`up` 是日常启动入口：它先编译当前源码（确保服务运行最新代码而非过期的 `dist/`），启动 launchd 托管的 MCP 服务并等待其可达，然后确保 Screenpipe 正在采集——已在运行则复用，否则在前台启动录制进程。录制进程在前台运行时，按 Ctrl-C 停止录制；MCP 服务仍保持运行，agent 可继续查询已采集的记忆。用 `npm run down` 停止服务。

Screenpipe 默认 24/7 连续录制、数据保留 7 天，没有固定录制时长。若已有 Screenpipe 实例在跑，`up` 会原样复用它。如果想确保录制进程使用本脚本的预期参数（而非某个已在运行实例的旧参数），可强制干净重启：

```bash
npm run up -- --restart-capture   # 停掉正在运行的 Screenpipe，再启动全新录制
```

需要比 `up` / `down` 更精细的控制时，使用下面的单项命令。

## 管理服务

```bash
npm run service:start    # 启动托管 HTTP 服务
npm run service:stop     # 停止托管 HTTP 服务
npm run service:status   # 检查服务健康和端点可达性
npm run service:logs     # 追踪服务日志
```

`service:status` 验证真实的 MCP `internal-status` 契约，而不仅仅是进程是否运行。它会报告端点 URL 和检索恢复状态。

`service:logs` 追踪托管服务的日志文件。在 onboarding 失败或服务意外退出时使用。

## 诊断

```bash
npm run storage:diagnostics   # 报告索引健康状况、磁盘用量和摄入统计
npm run maintain:status        # 显示上次维护运行的时间戳和结果
npm run maintain:run           # 立即运行一次 Screenpipe 数据库维护
```

`storage:diagnostics` 是检索似乎缓慢或不完整时首先运行的命令。它报告 FTS5 索引大小、向量索引状态和近期摄入计数。

`maintain:run` 触发与 `npm run screenpipe:safe-record` 每 10 分钟自动运行相同的维护操作。可随时手动触发。

## 索引维护

```bash
npm run rebuild-index
```

从头重建本地检索索引。在 `service:status` 报告 `retrieval.recoveryStatus: needs-rebuild`，或 `storage:diagnostics` 显示索引陈旧或损坏时运行。

根据 Screenpipe 历史记录大小，重建可能需要几分钟。重建期间服务保持可用，但检索质量可能降低直到重建完成。

参见 [排障](/zh/guide/troubleshooting) 了解 `needs-rebuild` 的诊断步骤。

## 实时端到端检验

```bash
npm run e2e:live -- --duration 10m
```

启动所有缺失的本地依赖，按指定时长录制 Screenpipe 活动，等待索引就绪，然后让 Hermes 摘要该时间窗口内实际采集的内容。用于验证采集 → 索引 → 检索 → agent 响应完整流程在本机正常工作。

## 数据落盘位置

| 路径 | 内容 |
|------|------|
| `~/.canary-alpha-mcp/config.yaml` | 服务配置（嵌入 provider、端口等） |
| `~/.canary-alpha-mcp/logs/` | 服务日志和维护运行记录 |
| `~/.screenpipe/` | Screenpipe 原始采集数据（由 Screenpipe 管理，非本服务） |

有关采集内容及控制方式的详细信息，参见 [隐私与数据](/zh/reference/privacy)。
