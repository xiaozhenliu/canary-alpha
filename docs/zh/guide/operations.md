---
doc_version: 12
doc_status: active
last_updated: 2026-09-04
---

# 日常运维

`computer-history-mcp` 服务的日常管理、诊断和维护命令。

## 从 canary-alpha-mcp 迁移

仍使用 `~/.canary-alpha-mcp` 的旧安装会在 `npm start`、`npm run setup` 与 `npm run service:start` 时自动迁移：

- 仅存在旧目录时，会先复制到带时间戳的备份，再重命名为 `~/.computer-history-mcp`。
- 新旧目录同时存在时，迁移会停止且不做覆盖或合并；请先手动处理冲突。
- 托管服务脚本还会先停止并移除旧 launchd 标签 `com.canary-alpha-mcp`，再安装 `com.computer-history-mcp`。

## 统一启动入口

```bash
npm start
```

无论是首次运行还是已有安装，都使用 `npm start`。该命令根据本地状态自动选择路径：

- 配置或 onboarding 完成标记不存在：启动或复用 Screenpipe，然后继续交互式 onboarding。仅执行过 `npm run setup`、只生成配置的情况也属于此分支。
- onboarding 已完成但缺少 `dist/src/index.js`：执行一次构建，然后恢复整套服务。
- onboarding 和构建产物都存在：不重新构建，直接进入快速恢复。

onboarding 成功后会写入 `~/.computer-history-mcp/.onboarding-complete`。为兼容引入该标记前的安装，已有的 launchd 托管服务也会被视为已完成安装。Agent 无需判断当前属于“首次启动”还是“resume”，状态转换完全由脚本负责。

快速恢复会并行检查 MCP 托管服务和 Screenpipe，复用健康组件，只启动缺失组件，并等待两个端点都健康后退出。Agent 和普通用户不应自行选择 `onboard`、`resume`、`service:start` 或 `screenpipe:safe-record`；这些命令仅保留给定向维护。

## 修改源码后更新 MCP

```bash
npm run refresh:hermes
```

编辑或拉取源码后，如果要让 Hermes 使用并验证新的 MCP 构建，统一运行此命令。它按顺序执行，并在任一步失败时立即停止：

1. 执行完整项目构建。
2. 重新安装并重启 launchd 托管的 MCP 服务，等待 MCP endpoint 可用。
3. 恢复共享本地栈；复用健康组件，仅在需要时启动 Screenpipe。
4. 使用真实 Hermes 配置运行 `hermes:verify`，要求 Hermes 成功调用 `internal-status`。

命令成功表示新版 MCP 运行时和 Hermes 集成都已验证。非零退出会指出失败阶段，后续步骤不会掩盖错误。运行前需要已配置 Hermes 及其 LLM provider。

不要用 `npm start` 处理源码更新：已有有效构建产物时，它会按设计直接恢复而不重新构建。`npm run up -- --detach` 会重建并重启本地栈，但不会证明 Hermes 可以调用它。

## 构建并启动最新源码

```bash
npm run up                 # 构建、启动托管 MCP 服务，并以前台方式开始 Screenpipe 录制
npm run up -- --detach     # 同上，但让录制进程在后台运行并释放终端
npm run down               # 停止托管 MCP 服务，不停止录制进程
npm run down:all           # 优雅停止录制进程和托管 MCP 服务
```

`up` 先编译当前源码（确保服务运行最新代码而非过期的 `dist/`），启动 launchd 托管的 MCP 服务并等待其可达，然后确保 Screenpipe 正在采集——已在运行则复用，否则在前台启动录制进程。录制进程在前台运行时，按 Ctrl-C 停止录制；MCP 服务仍保持运行，agent 可继续查询已采集的记忆。使用 `--detach` 可让录制进程在后台运行。

Screenpipe 默认 24/7 连续录制、数据保留 7 天，没有固定录制时长。若已有 Screenpipe 实例在跑，`up` 会原样复用它。如果想确保录制进程使用本脚本的预期参数（而非某个已在运行实例的旧参数），可强制干净重启：

```bash
npm run up -- --restart-capture   # 停掉正在运行的 Screenpipe，再启动全新录制
```

### 管理后台录制进程

```bash
npm run recorder:start    # 在后台启动录制进程
npm run recorder:status   # 查看后台录制进程状态
npm run recorder:logs     # 查看后台录制日志
npm run recorder:stop     # 优雅停止后台录制进程
```

recorder 从 `screenpipe.binaryPath` 和 `screenpipe.dataDirectory` 解析可执行文件与存储目录，因此稳定版和开发版可以并存，无需改写全局 `screenpipe` 链接。切换任一字段前先停止当前 recorder；开发版应使用独立端口和数据目录，避免迁移或修改稳定库。

需要比 `resume` / `up` / `down` / `down:all` 更精细的控制时，使用下面的单项命令。

## 管理服务

```bash
npm run service:start    # 启动托管 HTTP 服务
npm run service:stop     # 停止托管 HTTP 服务
npm run service:status   # 检查服务健康和端点可达性
npm run service:logs     # 追踪服务日志
```

`service:status` 验证真实的 MCP `internal-status` 契约，而不仅仅是进程是否运行。它会报告端点 URL 和检索恢复状态。

`service:logs` 追踪托管服务的日志文件。在 onboarding 失败或服务意外退出时使用。

::: tip 控制面板
当服务以 HTTP 模式运行时，浏览器管理面板可通过 `http://127.0.0.1:<port>/` 访问。它提供状态监控、配置编辑、Routines 管理、活动浏览、隐私控制和日志查看功能。详见[控制面板参考](/zh/reference/dashboard)。
:::

## 开发时使用服务

日常运行时只保留一个 Screenpipe 录制进程和一个 `computer-history-mcp` 托管服务。所有 MCP 客户端都连接同一个 HTTP 端点，通常为 `http://127.0.0.1:18765/mcp`。多个客户端可以共享该端点和同一份派生索引；不要为每个客户端单独启动服务器进程。

派生 SQLite 数据库、检索 checkpoint、隐私状态和运行时文件按单 writer 设计。不要让两个 `computer-history-mcp` 进程共享同一个 `~/.computer-history-mcp` 目录。尤其不要在托管 HTTP 服务运行时，再添加一个会启动另一服务器进程的 stdio 配置。

仓库中覆盖 capture 和 embedding 边界的测试使用临时应用目录和本地 stub，不需要启动第二套真实 Screenpipe 或 `computer-history-mcp` 服务。需要针对真实 Screenpipe API 手工开发时，只停止托管服务，启动开发服务器，结束后再恢复托管服务：

```bash
npm run service:stop
npm run dev:http

# 用 Ctrl-C 停止开发服务器后：
npm run service:start
```

整个过程中 Screenpipe 可以保持运行；开发服务器会复用它的本地 API 和已采集历史。

并行运行两个 `computer-history-mcp` 实例属于高级用法，默认不受支持。确实无法避免时，必须隔离以下内容：

- HTTP 端口和认证 token
- 应用 home 和 `config.yaml`
- 派生 SQLite 数据库和向量数据
- 检索 checkpoint、隐私状态、运行时注册表、routines 和日志

在第二个实例上保持 `trim` 关闭，并且不要通过它执行 `privacy-control delete-range` 或 Screenpipe 维护。隔离派生存储可以避免 writer 冲突，但两个实例仍共享上游 Screenpipe 数据，也会重复执行索引和 embedding。

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
| `~/.computer-history-mcp/config.yaml` | 服务配置（嵌入 provider、端口等） |
| `~/.computer-history-mcp/data/` | 预留的本地数据目录；它可能不存在。当前默认派生制品存放在应用主目录根部，包括 `derived.sqlite`。 |
| `~/.computer-history-mcp/logs/` | 服务日志和维护运行记录 |
| `~/.computer-history-mcp/routines/definitions/` | Routine 定义 JSON 文件（每个 routine 一个，以 slug 命名） |
| `~/.computer-history-mcp/routines/history/` | Routine 执行历史 JSON 文件（每个 routine 一个，最新优先） |
| `~/.screenpipe/` | Screenpipe 原始采集数据（由 Screenpipe 管理，非本服务） |

有关采集内容及控制方式的详细信息，参见 [隐私与数据](/zh/reference/privacy)。
