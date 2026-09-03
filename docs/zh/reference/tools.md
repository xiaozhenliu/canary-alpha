---
doc_version: 5
doc_status: active
last_updated: 2026-06-21
---

# MCP 工具

服务当前注册了十二个 MCP 工具。本文介绍面向客户端集成者的公开工具接口、输入 schema 和输出预期。

## 返回值格式

大多数工具同时返回：

- `content`：供 agent 展示的人类可读文本
- `structuredContent`：供下游自动化使用的机器可读 JSON

部分失败路径还会设置 `isError: true`。

工作活动检索工具（`find`、`recall`、`inspect`）始终在结构化载荷中包含 `narrativeText` 字符串字段——即使在降级路径上——调用者无需针对 `null` 做分支处理。当发生回退行为时，通过显式的 `degraded` 块暴露降级状态。

`find` 与 `recall` 的 `from` / `to` 时间窗边界按**绝对时刻并以 UTC 比较**。因此 UTC `Z` 边界（如 `2026-04-16T00:00:00Z`）能正确匹配采集记录，与录制端的本地时区偏移无关；也可传带偏移的形式（`+08:00`），解析为同一时刻。

## 工具列表

| 工具 | 类别 | Onboarding 默认 | 说明 |
|------|------|:---:|------|
| `find` | work-activity | ✓ | 按关键词、语义相似度或混合模式搜索工作活动内容，返回证据片段 |
| `recall` | work-activity | ✓ | 回忆指定时间窗口内的 session 或聚合时间块，可附带摘要 |
| `inspect` | work-activity | ✓ | 深入查看单个 session 或帧，返回证据行或原始 AX 树 |
| `memory-read` | memory | ✓ | 按 scope 读取持久化长期记忆 |
| `memory-write` | memory | ✓ | 追加或替换持久化长期记忆内容 |
| `file-analyze` | file-analysis | ✓ | 分析支持的本地文件并摘要，或回答具体问题 |
| `privacy-control` | privacy | ✓ | 检查或修改本地隐私采集控制 |
| `screenpipe-control` | screenpipe | — | 检查、启动或停止本地 Screenpipe 录制进程 |
| `internal-status` | internal | ✓ | 返回启动安全的运行时状态 |
| `routine-list` | routines | ✓ | 列出所有已配置的本地 routine，包含调度计划、启用状态和最近一次运行摘要 |
| `routine-create` | routines | — | 按名称创建新 routine 或更新已有 routine |
| `routine-history` | routines | ✓ | 按名称返回指定 routine 的执行历史，按最新优先排序 |

## `find`

搜索工作活动内容，返回证据片段。`mode="keyword"` 为默认值，对 `extracted_content` 运行 FTS5 关键词扫描；`semantic` 对嵌入哈希索引运行向量查询；`hybrid` 使用确定性排名器融合两者。

**输入**

```json
{
  "query": "budget planning",
  "mode": "hybrid",
  "appName": "Calendar",
  "from": "2026-04-16T00:00:00Z",
  "to": "2026-04-16T23:59:59Z",
  "limit": 20,
  "groupBy": "session"
}
```

| 字段 | 类型 | 是否必填 | 备注 |
|------|------|---------|------|
| `query` | string | 是 | NFC 归一化，去空格后 1–512 字符 |
| `mode` | `keyword` \| `semantic` \| `hybrid` | 否 | 默认 `keyword` |
| `appName` | string | 否 | 可选的应用名精确匹配过滤 |
| `from` | string | 否 | 可选的 ISO-8601 下界（含） |
| `to` | string | 否 | 可选的 ISO-8601 上界（含） |
| `limit` | 1–100 正整数 | 否 | 默认 `20` |
| `groupBy` | `session` | 否 | 设置后响应包含 `groupedBySession` 数组 |

**输出预期**

- `content[0].text` 包含 `narrativeText` 摘要（或回退消息）
- `structuredContent.data` 是证据项数组：`frameId`、`sessionId?`、`appName?`、`contextLabel`、`extractedText`、`timestamp`、`matchSource`（`keyword` | `semantic`）、可选 `score`、`sourceTypes`
- `structuredContent.groupedBySession`（可选）在请求 `groupBy="session"` 时按 session 分组
- `structuredContent.narrativeText` 始终存在
- `structuredContent.degraded`（可选）表示实际 mode 与请求 mode 不同（如 semantic→keyword 回退）或关键词扫描被截断；包含 `requestedMode`、`actualMode`、`reason`

## `recall`

回忆指定时间窗口内的工作活动 session 或聚合时间块。`granularity="session"` 列出 session；`hour` / `day` 按时间段聚合 session。`includeSummary` 默认 `true`，附带每个 session 的摘要。

**输入**

```json
{
  "from": "2026-04-16T00:00:00Z",
  "to": "2026-04-16T23:59:59Z",
  "granularity": "session",
  "appName": "Cursor",
  "includeSummary": true
}
```

| 字段 | 类型 | 是否必填 | 备注 |
|------|------|---------|------|
| `from` | string | 是 | ISO-8601 下界（含） |
| `to` | string | 是 | ISO-8601 上界（含） |
| `granularity` | `session` \| `hour` \| `day` | 否 | 默认 `session` |
| `appName` | string | 否 | 可选的应用名精确匹配过滤 |
| `includeSummary` | boolean | 否 | 默认 `true` |

**输出预期**

- `content[0].text` 包含 `narrativeText` 摘要
- `structuredContent.granularity` 回显解析后的粒度
- `structuredContent.sessions` 在 `granularity="session"` 时存在；每个 session 含 `sessionId`、`appName`、`contextLabel`、`startedAt`、`endedAt`、`activeSeconds`（整数秒）、`evidenceFrameIds`、`sourceTypes`，以及可选 `summary`（`text`、`status` ∈ `pending` | `ready` | `failed` | `degraded` | `not_applicable`、`providerKind` ∈ `template` | `remote-llm`）
- `structuredContent.blocks` 在 `granularity="hour"` 或 `"day"` 时存在；每个块含 `start`、`end`、`sessionCount`、`totalActiveSeconds`（整数秒）、`byApp`（appName → 整数秒）、`narrativeText`
- `structuredContent.narrativeText` 始终存在

## `inspect`

深入查看单个 session 或帧。通过在 `target` 中传入 `sessionId` 或 `frameId` 之一来选择目标。

**输入**

```json
{ "target": { "sessionId": "session-1" } }
```

```json
{ "target": { "frameId": 42 } }
```

| 字段 | 类型 | 是否必填 | 备注 |
|------|------|---------|------|
| `target.sessionId` | string | 二选一 | Session UUID/ID |
| `target.frameId` | string \| number | 二选一 | ScreenPipe 帧 ID（上游为数字，接受字符串格式以方便客户端） |

**输出预期**

- `structuredContent.kind` 为 `'session'` 或 `'frame'`
- `kind="session"` 时：`session`（session 行，未找到时为 `null`）、`evidence`（每帧 `extracted_content` 行）、`narrativeText`
- `kind="frame"` 时：`frame`（`frameId`、`timestamp`、可选 `appName` / `windowName`、`accessibilityTreeJson`——原始 AX 树 JSON 字符串，不可用时为 `null`）、`extractedContent`（派生行，或该帧尚未提取时为 `null`）、`narrativeText`
- 失败路径返回 `isError: true`，结构化 `kind="session"` 格式中 `session: null`、`evidence: []`，以及诊断 `narrativeText`

## `memory-read`

读取持久化长期记忆。

**输入**

```json
{
  "scope": "all"
}
```

| 字段 | 类型 | 是否必填 | 备注 |
|------|------|---------|------|
| `scope` | `memory` \| `user` \| `all` | 否 | 默认 `all` |

**输出预期**

- `structuredContent.scope` 回显解析后的 scope
- `structuredContent.content` 包含选定的文本内容
- `scope="all"` 时包含 `structuredContent.memory` 和 `structuredContent.user`

## `memory-write`

追加或替换持久化长期记忆。

**输入**

```json
{
  "scope": "memory",
  "content": "Remember that the user prefers concise output.",
  "mode": "append"
}
```

| 字段 | 类型 | 是否必填 | 备注 |
|------|------|---------|------|
| `scope` | `memory` \| `user` | 否 | 默认 `memory` |
| `content` | string | 是 | 最小长度 1 |
| `mode` | `append` \| `replace` | 否 | 默认 `append` |

**输出预期**

- `content[0].text` 说明内容是被追加还是替换
- `structuredContent` 返回 `scope`、`mode` 和最终 `content`

## `file-analyze`

分析支持的本地文件。

**输入**

```json
{
  "path": "/absolute/path/to/file.md",
  "question": "What are the main action items?"
}
```

| 字段 | 类型 | 是否必填 | 备注 |
|------|------|---------|------|
| `path` | string | 是 | 本地文件路径 |
| `question` | string | 否 | 可选的具体问题 |

**输出预期**

- 成功时 `structuredContent` 包含 `summary`、可选 `answer`、`highlights`、`evidence`、`file`
- 失败时 `isError: true`，`structuredContent.error` 描述问题
- 二进制内容会被拒绝

## `privacy-control`

检查或修改隐私采集控制。

本地操作者也可以使用 CLI wrapper，无需手工构造 MCP 载荷：

```bash
npm run privacy-control -- status
npm run privacy-control -- pause
npm run privacy-control -- resume
npm run privacy-control -- exclude-app --app "Claude"
npm run privacy-control -- exclude-app --app "Claude" --rebuild
npm run privacy-control -- remove-excluded-app --app "Claude"
```

CLI 只打印暂停状态、被排除的应用名和可操作的验证错误，不暴露检索内容。`--rebuild` 在更新排除列表后调用现有的 `rebuild-index` 工作流，以清除新排除应用已索引的明文内容。

**输入**

```json
{
  "action": "exclude-app",
  "appName": "Messages"
}
```

| 字段 | 类型 | 是否必填 | 备注 |
|------|------|---------|------|
| `action` | `status` \| `pause` \| `resume` \| `exclude-app` \| `remove-excluded-app` \| `delete-range` | 是 | 要执行的操作 |
| `appName` | string | 否 | 与 `exclude-app` 和 `remove-excluded-app` 配合使用 |
| `range` | `last_1h` \| `last_1d` \| `all` | 否 | 与 `delete-range` 配合使用 |
| `confirm` | boolean | 否 | 破坏性 delete-range 操作的确认标志 |

**输出预期**

- `structuredContent.paused` 报告采集是否已暂停
- `structuredContent.excludedApps` 列出被排除的应用
- `structuredContent.allowedDeleteRanges` 列出有效的删除范围
- `structuredContent.confirmationHint` 解释何时需要确认
- `delete-range` 时，`structuredContent.cascade` 报告派生存储级联结果：`upstreamDeleted`（删除的上游行数）、`cascade`（`ok` | `partial` | `failed`）、可选 `failedFrameIds`、可选 `reason`
- 失败路径设置 `isError: true`

## `screenpipe-control`

检查、启动或停止由本服务管理的本地 Screenpipe 录制进程。

**输入**

```json
{
  "action": "status"
}
```

| 字段 | 类型 | 是否必填 | 备注 |
|------|------|---------|------|
| `action` | `status` \| `start` \| `stop` | 是 | 要执行的操作 |

**输出预期**

- `content[0].text` 始终包含请求的 `action` 和解析后的 `running` 状态
- 当服务启动了活跃的 Screenpipe 进程时包含 `pid`
- 操作无法完成时包含 `error`
- `stop` 只终止由本 MCP 服务启动的 Screenpipe 进程

## `internal-status`

返回启动安全的运行时状态。

**输入**

```json
{}
```

**结构化输出**

```json
{
  "status": "ok",
  "mode": "http",
  "host": "127.0.0.1",
  "port": 18765,
  "pid": 12345,
  "configFile": "~/.computer-history-mcp/config.yaml",
  "retrieval": {
    "checkpointExists": true,
    "checkpointTimestamp": "2026-04-16T12:00:00.000Z",
    "vectorStoreKind": "chroma",
    "recoveryStatus": "ready"
  }
}
```

`recoveryStatus` 可能的值：

- `ready`
- `needs-rebuild`
- `degraded`

响应还包含采集/摄入可观测性块（`capture`、`ingestionMix`、`diskBudget`）以及摘要派生存储健康状况的 `workActivity` 块。参见 [排障](/zh/guide/troubleshooting#采集与摄入可观测性) 了解故障模式参考。

本工具是 `npm run service:status` 使用的主要健康探针。

## `routine-list`

列出所有已配置的本地 routine。可选按启用状态过滤。返回每个 routine 的调度计划、启用状态、prompt、recent-activity 窗口、时间戳，以及（存在时的）最近一次运行摘要。

**输入**

```json
{
  "enabled": true
}
```

| 字段 | 类型 | 是否必填 | 备注 |
|------|------|---------|------|
| `enabled` | boolean | 否 | 提供时，仅返回 `enabled` 字段与此值匹配的 routine |

**输出预期**

- `structuredContent.routines` 是 routine 对象数组；每项包含 `name`、`schedule`、`enabled`、`prompt`、`recentActivityMinutes`、`createdAt`、`updatedAt`，以及可选的 `latestRun`（`runId`、`startedAt`、`completedAt`、`status` ∈ `success` | `failed` | `skipped`、`summary`）
- `structuredContent.total` 为返回的 routine 数量
- `content[0].text` 为简短叙述（如 "3 routine(s) configured."）
- 失败路径返回 `isError: true`，`structuredContent: { routines: [], total: 0 }`

## `routine-create`

按名称创建新 routine 或更新已有 routine。调度计划必须是合法的 5 字段 cron 表达式。名称会被规范化为文件系统安全的 slug（小写字母数字加连字符）。若调度器正在运行，新定义或更新定义无需重启服务即可立即生效。

**输入**

```json
{
  "name": "morning standup",
  "prompt": "Summarize yesterday's work activity for the standup.",
  "schedule": "0 9 * * 1-5",
  "enabled": true,
  "recentActivityMinutes": 480
}
```

| 字段 | 类型 | 是否必填 | 备注 |
|------|------|---------|------|
| `name` | string（最短 1） | 是 | 规范化为小写字母数字加连字符 |
| `prompt` | string（最短 1） | 是 | routine 执行器使用的 prompt 文本 |
| `schedule` | string（最短 1） | 是 | 5 字段 cron 表达式（如 `"0 8 * * *"` 表示每天 08:00） |
| `enabled` | boolean | 否 | 默认 `true` |
| `recentActivityMinutes` | 正整数 | 否 | 回溯窗口（分钟）。省略时根据 schedule 频率自动推断：每小时→60、每天→1440、每周→10080、每月→43200。显式值始终覆盖推断。 |

**输出预期**

- `structuredContent.routine` 返回持久化的定义：`name`、`schedule`、`enabled`、`prompt`、`recentActivityMinutes`、`createdAt`、`updatedAt`
- `structuredContent.isNew` 在 routine 新建时为 `true`，更新已有 routine 时为 `false`
- `content[0].text` 说明 routine 是被创建还是更新（如 `Routine "morning-standup" created.`）
- 失败路径（无效 cron、空名称、存储错误）返回 `isError: true`

## `routine-history`

按名称返回指定 routine 的执行历史，按最新优先排序。每条记录包含运行状态、时间信息，以及输出内容或错误消息。`name` 参数与存储的（规范化后的）routine 名称精确匹配。

**输入**

```json
{
  "name": "morning-standup",
  "limit": 5
}
```

| 字段 | 类型 | 是否必填 | 备注 |
|------|------|---------|------|
| `name` | string（最短 1） | 是 | 要查询的 routine 名称（规范化后的存储名称） |
| `limit` | 1–100 正整数 | 否 | 默认 `10` |

**输出预期**

- `structuredContent.name` 回显请求的 routine 名称
- `structuredContent.runs` 是运行记录数组，最新优先；每条记录包含 `runId`、`name`、`startedAt`、`completedAt`、`status` ∈ `success` | `failed` | `skipped`、`summary`、`output`，以及可选 `error`（`message`）
- `structuredContent.total` 为返回的记录数
- `content[0].text` 为简短叙述（如 `5 run record(s) for routine "morning-standup".`）
- 无历史记录时 `runs` 为空，叙述文本会说明
- 失败路径返回 `isError: true`，`structuredContent: { name, runs: [], total: 0 }`

## 兼容性说明

- 官方 v1 交付接口是 `http://127.0.0.1:<port>/mcp` 的 Streamable HTTP
- stdio 仍存在用于兼容性和测试，但不是主要公开交付路径
- 旧版 `search-screen` 和 `recent-activity` 检索工具已移除；其替代品为 `find`、`recall` 和 `inspect`

## 相关文档

- [配置文件](/zh/reference/configuration) — 配置参考
- [通用 MCP 客户端](/zh/guide/clients/generic-mcp) — 传输和首次调用指南
- [排障](/zh/guide/troubleshooting) — 按症状诊断
