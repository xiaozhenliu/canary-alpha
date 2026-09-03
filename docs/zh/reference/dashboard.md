---
doc_version: 2
doc_status: active
last_updated: 2026-09-04
---

# 控制面板

`computer-history-mcp` 内置了一个 Web 控制面板，供本地运维人员使用。它提供基于浏览器的状态监控、配置管理、Routines 控制、活动浏览、隐私管理和日志查看功能。

控制面板**不是**产品功能入口，不替代供 AI agent 使用的 MCP 工具。它是面向运维人员的管理面板，可视化并操作 MCP 工具底层的同一套服务。

## 访问控制面板

当服务器以 HTTP 模式运行时，控制面板地址为：

```
http://127.0.0.1:<port>/
```

默认端口为 `18765`，因此通常访问 `http://127.0.0.1:18765/`。

控制面板与 MCP 协议共用同一个 HTTP 端点，无需额外进程或端口。路由优先级如下：

1. `/mcp` — MCP 协议（基于 Streamable HTTP 的 JSON-RPC）
2. `/api/*` — 控制面板 REST API（Bearer token 认证）
3. 其他路径 — SPA 静态文件（`dist/dashboard/`）

::: tip
控制面板仅在 `http` 模式下可用。`stdio` 模式下没有 HTTP 监听器，无法访问控制面板。
:::

## 认证

所有 `/api/*` 端点需要 Bearer token。token 来自 `config.yaml` 中的 `server.authToken`：

```yaml
server:
  authToken: "your-secret-token"
```

控制面板前端从浏览器读取 token，并以 `Authorization: Bearer <token>` 头注入每个 API 请求。

**Fail-closed 行为**：如果未配置 `server.authToken`，所有 API 请求都会返回 `401 Unauthorized`。这是刻意设计——没有 auth token，控制面板无法使用。

::: warning
auth token 是你与服务器之间的共享密钥，不要暴露在公开配置或版本控制中。`npm run onboard` 会自动生成随机 token。
:::

## 页面模块

控制面板包含六个页面模块，每个模块对应侧边栏的一个入口和一组专用 API 端点。

### Status（状态）

**路由**：`/`

默认首页。以卡片网格展示服务器运行状态：

| 卡片 | 信息 |
|------|------|
| **Server** | 运行模式、host:port、PID、运行时长、配置文件路径 |
| **Capture** | 采集 provider、存活状态（ok / idle / permissions-missing / unavailable）、最新帧时间戳 |
| **Retrieval** | Checkpoint 时间戳、向量存储类型、恢复状态、embedding hash index 大小 |
| **Ingestion Mix** | 过去 24 小时的数据源类型分布（AX / OCR 占比） |
| **Disk Budget** | Screenpipe 数据库大小、预算使用率、主要表占比 |
| **Work Activity** | 提取数量、会话数量、摘要 worker 状态 |
| **Providers** | Embedding provider 类型、模型、状态 |

降级的子系统会以警告标记和原因文本醒目展示。数据每 30 秒自动刷新；点击 **Refresh** 可立即刷新。

### Config（配置）

**路由**：`/config`

Schema 驱动的配置编辑器。表单由服务器的 Zod config schema 自动生成——当 schema 新增配置字段时，控制面板无需修改 UI 代码即可自动展示。

功能：

- 按 section 折叠/展开显示所有配置段（server、logging、capture、screenpipe、providers、vectorStore、retrieval、routines、trim、storage、privacy、analysis、llm、paths）
- 每个字段显示：当前值、schema 默认值、描述，以及是否被环境变量覆盖
- 敏感字段（`apiKey`、`authToken`）默认遮罩显示，点击可揭示
- 保存前进行 JSON Schema 校验
- 直接写入 `config.yaml`，使用 AST 保留写回（注释和格式不丢失）

::: info
配置修改会写入磁盘，但需要重启服务才能生效。页面会在每次保存后显示提醒。
:::

### Routines

**路由**：`/routines`

列出所有已配置的 routines，展示调度计划、启用状态、prompt、推断或显式设置的回溯窗口，以及最近一次执行状态。

- **创建**：定义新的 routine，包括名称、prompt、cron 调度（提供预设选项：每天 08:00、每小时、工作日 09:00，或自定义）、启用开关和可选回溯窗口；未提供窗口时，服务会按调度频率自动推断。
- **切换**：通过开关启用或禁用单个 routine
- **历史**：查看任意 routine 的执行历史时间线——每条记录展示 run ID、时间戳、状态（success / failed / skipped）和摘要

### Activity（活动）

**路由**：`/activity`

以时间线形式浏览工作活动会话，并支持搜索。

- **会话时间线**：展示每个会话的应用名、上下文标签、起止时间、活跃时长和摘要
- **筛选器**：日期范围选择器和应用名过滤器
- **搜索面板**：输入查询词并选择搜索模式（关键词、语义或混合），在索引帧中查找匹配内容——结果展示提取文本、相关度评分、应用名和时间戳

### Privacy（隐私）

**路由**：`/privacy`

查看和管理隐私控制。

- **暂停/恢复**：切换采集开关
- **排除应用**：查看当前排除列表，添加或移除应用
- **删除范围**：触发指定时间范围的数据删除（需二次确认）

### Logs（日志）

**路由**：`/logs`

以 tail 模式查看服务器日志文件。

- 展示最近 200 条日志记录
- 按日志级别过滤：debug、info、warn、error
- 结构化 JSON 日志条目解析后格式化展示（时间戳、级别、消息、元数据）；非 JSON 行原样显示
- 每 15 秒自动刷新

## REST API 端点

控制面板通过以下 REST 端点与服务器通信。所有端点需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/status` | 服务器状态（与 `internal-status` 工具相同的数据） |
| `GET` | `/api/config` | 列出所有配置项及来源 |
| `GET` | `/api/config/schema` | 完整配置的 JSON Schema |
| `GET` | `/api/config/effective` | 当前生效的配置值 |
| `PUT` | `/api/config/:path` | 更新某个配置字段 |
| `GET` | `/api/routines` | 列出所有 routines |
| `POST` | `/api/routines` | 创建新 routine |
| `GET` | `/api/routines/:name/history` | 某个 routine 的执行历史 |
| `GET` | `/api/activity/sessions` | 工作活动会话（支持 `from`、`to`、`app` 查询参数） |
| `POST` | `/api/activity/search` | 语义/关键词/混合搜索 |
| `GET` | `/api/privacy` | 当前隐私状态 |
| `POST` | `/api/privacy/action` | 执行隐私操作（pause、resume、exclude-app、delete-range） |
| `GET` | `/api/logs` | 最近日志记录（支持 `limit`、`level` 查询参数） |

## 与 CLI 和 MCP 工具的关系

控制面板、config CLI 和 MCP 工具是同一套底层服务的三个接口：

| 接口 | 受众 | 传输方式 |
|------|------|----------|
| MCP 工具 | AI agent | 基于 stdio 或 Streamable HTTP 的 JSON-RPC |
| Config CLI | 终端操作人员 | 直接进程调用 |
| 控制面板 | 浏览器操作人员 | 基于 HTTP 的 REST API |

它们共享相同的数据存储和服务实例。通过任一接口所做的更改对其他接口可见（配置更改需重启后生效）。
