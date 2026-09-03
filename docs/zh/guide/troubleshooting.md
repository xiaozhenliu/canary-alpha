---
doc_version: 3
doc_status: active
last_updated: 2026-09-04
---

# 排障

出现问题时，先从这里开始：

```bash
npm run service:status
```

该命令验证真实的 MCP `internal-status` 契约，并报告端点 URL 和检索恢复状态。根据其输出确定适用于下文哪个章节。

本指南涵盖 v1 交付路径中的常见操作故障。

## 服务无法启动

### 症状

`npm run service:start` 立即退出。

### 检查步骤

1. 确认运行在 macOS 上。`service:start` 和 `service:stop` 目前仅支持 Darwin 上的 launchd。
2. 运行 `npm run build`。服务启动器需要 `dist/src/index.js`。
3. 确认配置文件存在：

```bash
npm run setup
```

4. 检查 `server.host` 是否为 `127.0.0.1`。服务拒绝任何非本地主机。

### 典型错误信息

- `Missing config file ... Run npm run setup first.`
- `Missing built service entrypoint ... Run npm run build first.`
- `Refusing to start service with non-local host ... Expected 127.0.0.1.`

## 服务状态不健康

### 症状

`npm run service:status` 报告：

```text
endpoint: http://127.0.0.1:<port>/mcp (unhealthy)
```

### 含义

该检查探测真实的 MCP 端点并调用 `internal-status`，比检查进程是否存在更严格。

### 检查步骤

1. 读取近期日志：

```bash
npm run service:logs
```

2. 确认配置文件解析正确。
3. 确认 `screenpipe.url` 处的 Screenpipe 可达。
4. 确认嵌入 provider 端点可达且配置正确。
5. 重新运行：

```bash
npm run service:start
npm run service:status
```

## 检索报告 `needs-rebuild`

### 症状

`internal-status` 报告：

```json
{
  "retrieval": {
    "recoveryStatus": "needs-rebuild"
  }
}
```

### 恢复步骤

从 Screenpipe 数据重建检索制品：

```bash
npm run rebuild-index
```

此路径仅针对检索恢复，不会重置配置、记忆或隐私文件。

## 检索报告 `degraded`

### 症状

工具输出提到检索状态降级，或 `internal-status` 报告 `recoveryStatus: degraded`。

### 含义

服务正在运行，但向量存储或检查点状态无法完全读取。

### 下一步

1. 用 `npm run service:logs` 检查日志
2. 重新运行 `npm run service:status`
3. 如果降级状态持续，运行 `npm run rebuild-index`

## 客户端无法发现工具

### 检查步骤

1. 确认客户端使用 Streamable HTTP 传输。
2. 确认 URL 以 `/mcp` 结尾。
3. 在本地运行 `npm run service:status`。
4. 先调用 `internal-status`。如果失败，问题在传输或服务健康，而非特定工具。

## Provider 错误

### 症状

检索工具失败或返回可操作的错误文本。

### 检查步骤

1. 核实 `providers.embeddings.baseUrl`
2. 核实 `providers.embeddings.model`
3. 当 provider 需要时，核实 `providers.embeddings.apiKey`
4. 确认 provider 从本机可达
5. 检查 `screenpipe.url` 处的 Screenpipe 是否可达

## 中文 OCR 识别不完整

### 症状

中文文本未被识别，或大部分内容仅以英文 OCR 结果出现。

### 检查步骤

在 `~/.computer-history-mcp/config.yaml` 中将中文放在优先位置：

```yaml
capture:
  ocrLanguages: [chinese, english]
```

`ocrLanguages` 是语言名称数组，不使用 `zh-Hans` 等 locale 代码。顺序代表优先级，macOS Apple Vision 使用第一项作为主要 OCR 模式。本仓库管理的 recorder 仅在启动时读取该设置，请运行：

```bash
npm run recorder:stop
npm run recorder:start
```

如果使用 Screenpipe 桌面应用，请在应用中重启它；如果自定义了 Screenpipe 可执行文件或数据目录，也同时检查 `screenpipe.binaryPath` 和 `screenpipe.dataDirectory` 是否指向同一套录制器与数据。

## 未找到日志

### 症状

`npm run service:logs` 打印：

```text
No log output found yet under ~/.computer-history-mcp/logs/.
```

### 含义

服务可能尚未启动，或在产生输出之前已退出。

### 检查步骤

- 运行 `npm run service:start`
- 重新运行 `npm run service:status`
- 检查 `~/.computer-history-mcp/logs/` 是否存在

## Screenpipe 维护状态不明

### 症状

`npm run screenpipe:safe-record` 正在运行或刚停止，但需要确认 Screenpipe 数据库维护操作是否运行、失败或轮转了诊断输出。

### 检查步骤

1. 读取维护 JSONL 日志：

```bash
tail -n 50 ~/.computer-history-mcp/logs/screenpipe-maintenance.jsonl
```

2. 查找 `maintenance-run-start`、`maintenance-run-exit` 或 `maintenance-run-error`。
3. 检查 `trigger` 字段：
   - `periodic`：录制持续期间 10 分钟后台维护间隔触发。
   - `final`：录制器退出后 wrapper 最后运行了一次维护。
4. 如果 `screenpipe-maintenance.jsonl` 不存在但 `npm run screenpipe:safe-record` 未退出且运行时间不足 10 分钟，等待下一个间隔或干净地停止 wrapper 以触发最终维护。
5. 如果日志已轮转，检查 `~/.computer-history-mcp/logs/screenpipe-maintenance.jsonl.1`。

活跃日志保留 7 天有效的 JSONL 条目，超过 1 MB 时轮转。格式异常或过旧的条目在下次写入时丢弃。

## 文件分析拒绝文件

### 症状

`file-analyze` 对给定路径返回错误。

### 含义

服务只分析受支持的文本输入，二进制内容会被明确拒绝。

### 下一步

- 确认文件存在
- 确认路径正确
- 用文本文件而非二进制资源重试

## 采集与摄入可观测性

使用 `internal-status` 检查实时采集和摄入状态。工具返回三个诊断块——`capture`、`ingestionMix` 和 `diskBudget`——直接映射到以下故障模式。

### 故障模式

**ScreenPipe 进程未运行**

`capture.state == "process-down"`

`screenpipe-safe-record` 进程未在运行时注册表中。用 `npm run screenpipe:safe-record` 或 Screenpipe 桌面应用启动它，然后重新检查 `internal-status`。

**macOS 辅助功能权限缺失**

`capture.state == "permissions-missing"`

进程刚启动但尚无帧写入，且宽限期已过。打开 **系统设置 → 隐私与安全 → 辅助功能**，授予 Screenpipe 权限，然后重启进程。

**进程运行但未产生新帧**

`capture.state == "idle"`

进程存活，但 `frames.timestamp` 在存活阈值（默认 120 秒）内未推进。常见原因：屏幕已锁定、机器休眠，或 `--ignored-windows` / `excludedApps` 范围过宽。检查 `capture.lastFrameTimestamp` 和 `capture.reason`。

**磁盘配额耗尽且无可回收数据**

`diskBudget.warning` 为非空字符串

数据库超过 `storage.diskBudgetBytes`，且没有早于 `storage.retentionDays` 的行可删除。在 `~/.computer-history-mcp/config.yaml` 中提高配额（`storage.diskBudgetBytes`）或缩短保留窗口（`storage.retentionDays`）。

**AX / OCR 摄入比例严重失衡**

`ingestionMix.ratio` 接近 `0` 或接近 `1`

`ratio` 是过去 24 小时内 `accessibilityCount / (accessibilityCount + ocrCount)`。接近 `0` 表示几乎所有内容来自 OCR（辅助功能采集可能被阻止或 AX 路径失败）；接近 `1` 表示 OCR 回退从未触发（在 AX 优先健康设置中属于预期，但值得确认）。与 `capture.state` 和 Screenpipe 日志交叉参考。

## 验证命令

排查问题时使用以下命令：

```bash
npm run service:status
npm run service:logs
npm run test
npm run test:contract
npm run eval:coverage
```

## 隐私删除范围级联失败

当 `privacy-control` 运行 `delete-range` 时，它先删除上游 Screenpipe 行，然后将删除级联到派生存储（`extracted_content`、`sessions`、向量索引）。如果上游删除成功但级联失败，服务会写入一个覆盖请求窗口的 `cascade-failure` 墓碑，以确保检索结果与用户隐私意图一致。

墓碑活跃期间，`find` 和 `recall` 会过滤掉时间戳落在该窗口内的证据和 session——即使底层派生行仍然存在。在 `npm run service:logs` 中查找 `privacy-control delete-range` 警告，并检查 `privacy-control` 响应中的 `cascade.cascade` 字段（`partial` 或 `failed` 表示墓碑活跃）。

解决底层派生数据库问题（磁盘空间、文件锁、schema 不匹配等）后，针对同一范围重新运行 `privacy-control`。协调入口点会重试级联，并在成功后清除每个墓碑，之后 `find` / `recall` 不再抑制该窗口。

## 相关文档

- [日常运维](/zh/guide/operations) — 服务管理和诊断命令
- [配置文件](/zh/reference/configuration) — 配置选项
- [MCP 工具参考](/zh/reference/tools) — 工具集参考
