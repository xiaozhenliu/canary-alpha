---
doc_version: 2
doc_status: deprecated
last_updated: 2026-06-15
---

# Spec: Dashboard Web UI

## 背景

canary-alpha-mcp 当前的运维与配置管理完全依赖 CLI（config 子命令 8 个、`npm run service:*` 脚本、`internal-status` MCP 工具）。随着 MCP 工具面扩展到 12 个、Routines 子系统上线、配置项日益增多，纯 CLI 操作在日常巡检和配置调整时效率递减，且不适合快速浏览全局运行时状态。需要一个轻量级的本地 Web Dashboard，把 CLI 能力可视化并提供交互式管理入口。

future-backlog.md 的"历史范围裁剪"中曾标注 "UI/dashboard —— 产品保持 MCP-only、面向 agent"。本 spec 将 dashboard 定位为**运维管理面板**而非产品功能面——它不替代 MCP 工具，而是为本地操作者提供一个浏览器可达的管控界面。

## 目标

本地操作者通过浏览器访问 `http://127.0.0.1:<port>/` 即可查看服务运行状态、管理配置、操控 Routines，无需记忆 CLI 命令或手写 MCP payload。Dashboard 必须**模块化组件化**，新增 MCP 工具或配置项时只需添加对应模块，不改动 dashboard 核心框架。

## 需求

### A. 架构与基础设施

- **DASH-01**: Dashboard 作为同进程 SPA 嵌入现有 HTTP server，复用 `node:http`，不引入 Express/Hono 等 web 框架。
- **DASH-02**: HTTP 路由分发：`/mcp` 保持 MCP 协议不变，`/api/*` 提供 REST 管理端点，`/` 及 `/*`（非 `/mcp`、非 `/api/`）提供 SPA 静态文件。
- **DASH-03**: Dashboard REST API 复用 `server.authToken` 鉴权（Bearer token），与 MCP 端点鉴权机制一致。无 authToken 时 API 返回 401。
- **DASH-04**: 前端使用 React + Vite 构建，产物输出到 `dist/dashboard/`，server 通过 `serve-static` 提供预构建文件，零运行时前端依赖。
- **DASH-05**: 前端技术栈：React 19 + Tailwind CSS v4 + shadcn/ui（Radix 原语）+ React Router（客户端路由）+ Recharts（图表）。Geist-inspired 极简暗色/亮色双主题。
- **DASH-06**: 仅监听 `127.0.0.1`——dashboard 继承现有 HTTP server 的绑定守卫约束，不新增网络暴露面。

### B. 模块化框架（核心可扩展性）

- **DASH-07**: Dashboard 采用**模块注册制**——每个功能页面（Status、Config、Routines 等）是一个独立模块，通过统一的注册接口声明 `{ id, label, icon, route, component, apiEndpoints }`。新增页面只需添加一个模块文件并注册，不修改 App shell 或路由表。
- **DASH-08**: REST API 采用**路由注册制**——每个 API handler 通过 `registerApiRoute(method, path, handler)` 注册。新增 API 只需添加一个 handler 文件并注册，不修改路由分发主函数。
- **DASH-09**: 配置管理 UI 采用 **schema-driven 动态表单生成**——从 Zod schema（`appConfigSchema`）导出 JSON Schema，前端根据 JSON Schema 递归渲染表单控件（string → input、number → number input、boolean → switch、enum → select、array → tag list、object → fieldset）。新增配置段或字段后，只要 Zod schema 更新，表单自动出现——无需手写配置 UI 组件。
- **DASH-10**: 前端组件库采用 **Compound Component 模式**——StatusCard、MetricCard、DataTable、TimelineEntry 等基础组件暴露可组合 API，页面模块用组合而非继承构建视图。

### C. Status Dashboard（状态仪表盘）

- **DASH-11**: 默认首页为 Status Dashboard，数据来源为 `BootstrapStatus`（即 `internal-status` 工具的底层服务 `bootstrapStatus.getStatus()`）。
- **DASH-12**: 状态仪表盘展示以下信息卡片（每个卡片是独立组件，可按需增删）：
  - **Server**: mode、host:port、PID、uptime、config file path
  - **Capture**: capture provider、liveness state（ok/idle/permissions-missing/unavailable）、最新帧时间戳
  - **Retrieval**: checkpoint timestamp、vector store kind、recovery status（ready/needs-rebuild/degraded）、embedding hash index size
  - **Ingestion Mix**: 过去 24h 的 source type 分布（AX/OCR 占比）
  - **Disk Budget**: screenpipe 数据库大小、budget 使用率、dominant tables 占比
  - **Work Activity**: extraction count、session count、summary worker state
  - **Providers**: embedding provider kind/model/status
- **DASH-13**: 状态卡片支持自动刷新（默认 30s 轮询）和手动刷新按钮。
- **DASH-14**: 降级状态（`BootstrapStatus.degraded`）以醒目方式展示在相关卡片上，附降级原因文本。

### D. Configuration Manager（配置管理）

- **DASH-15**: 配置管理页面展示当前生效的全部配置项，按 section 折叠/展开（server、logging、capture、screenpipe、providers.embeddings、vectorStore、retrieval、routines、trim、storage、privacy、analysis、llm、paths）。
- **DASH-16**: 每个配置项显示：当前值、schema 默认值、是否被环境变量覆盖（标注 env var 名）、字段描述。
- **DASH-17**: 敏感字段（apiKey、api_key、authToken）默认遮罩显示（`***`），提供 reveal toggle。
- **DASH-18**: 配置编辑：用户修改配置项后，前端对完整配置做 JSON Schema 校验；校验通过后调用 REST API 写入 `config.yaml`（复用 `ConfigFileStore` 的 AST 保留写回能力）。失败时显示校验错误，不允许提交非法配置。
- **DASH-19**: 配置保存后，页面提示"需要重启服务才能生效"并提供一键重启按钮（调用 `service:stop` + `service:start` 等效逻辑）。
- **DASH-20**: 数组字段（如 `privacy.excludeApps`、`privacy.secureAxRoles`）渲染为 tag list 组件，支持添加/删除单项。

### E. Routines Manager（Routines 管理）

- **DASH-21**: Routines 页面列出所有已配置的 routines（数据来源：`RoutineStore.listRoutines()`），展示 name、schedule（cron 表达式 + 人类可读下次执行时间）、enabled state、latest run status/summary。
- **DASH-22**: 支持创建新 routine 和编辑已有 routine（对应 `routine-create` 工具的输入 schema）。Cron 表达式提供预设快捷选项（每天 8:00、每小时、工作日 9:00 等）和自定义输入。
- **DASH-23**: 支持查看单个 routine 的执行历史时间线（数据来源：`RoutineStore.getHistory()`），每条记录展示 runId、时间、status（success/failed/skipped）、summary。
- **DASH-24**: 支持通过 toggle switch 启用/禁用单个 routine。

### F. Activity Browser（活动浏览器）

- **DASH-25**: Activity 页面以时间线形式展示 work-activity sessions（数据来源：`recall` 服务的 `granularity=session`）。每个 session 展示 appName、contextLabel、startedAt、endedAt、activeSeconds、summary。
- **DASH-26**: 支持日期范围选择器和 appName 过滤器。
- **DASH-27**: 支持向量检索测试面板：输入 query → 调用 `find` 服务 → 展示匹配结果列表（extractedText、score、appName、timestamp）。

### G. Privacy Controls（隐私控制）

- **DASH-28**: Privacy 页面展示当前隐私状态：是否 paused、排除应用列表、可用的 delete ranges。
- **DASH-29**: 支持 pause/resume collection toggle、管理排除应用列表（添加/删除）、触发 delete-range（需二次确认）。

### H. Log Viewer（日志查看器）

- **DASH-30**: Logs 页面展示 `service.log` 的最近 N 行内容（tail 模式），支持按日志级别过滤（debug/info/warn/error）。
- **DASH-31**: 日志条目按结构化 JSON 解析后格式化展示（timestamp、level、message、metadata），非 JSON 行原样展示。

## 验收标准

### 架构

1. `http.ts` 路由分发正确区分 `/mcp`（MCP 协议）、`/api/*`（REST）、其他路径（SPA 静态文件），三路互不干扰。
2. 所有 `/api/*` 端点要求 Bearer token 鉴权，无 token 或 token 不匹配时返回 401。
3. SPA 静态文件从 `dist/dashboard/` 提供，客户端路由刷新时 fallback 到 `index.html`。
4. Dashboard 不引入 Express/Hono 等 web 框架，路由分发在 `node:http` 层完成。

### 模块化

5. 添加一个新的 dashboard 页面模块（含前端 page + 后端 API handler），不需要修改 App shell、路由分发主函数或其他现有模块的代码——只需新建模块文件并在注册表中添加一行。
6. 在 `appConfigSchema` 中新增一个配置段后，dashboard 的配置管理 UI 自动渲染该段的表单，无需编写新的 UI 组件。
7. schema-driven 表单正确处理以下 Zod 类型：`z.string()`、`z.number()`、`z.boolean()`、`z.enum([...])`、`z.array(z.string())`、`z.object({...})`（递归嵌套），每种类型渲染为对应的 UI 控件。

### 功能

8. Status Dashboard 展示 `BootstrapStatus` 的全部主要字段（server、capture、retrieval、ingestion、disk、work-activity、providers），降级状态醒目标识。
9. 配置管理页面可以读取、编辑、保存配置；保存后 `config.yaml` 文件内容正确更新；非法值被校验拦截。
10. Routines 页面可以列出 routines、创建新 routine、查看执行历史。
11. Activity Browser 可以按日期范围加载 sessions 并展示时间线。
12. Privacy 页面可以 pause/resume、管理排除应用列表。
13. Log Viewer 可以展示日志并按级别过滤。

### 质量

14. 前端构建产物（`dist/dashboard/`）gzip 后总大小 ≤ 150KB。
15. `npm run build` 同时构建 server TypeScript 和 dashboard 前端，单命令产出完整可运行产物。
16. typecheck 覆盖前端和后端代码。

## 范围外

| 项 | 原因 |
|---|---|
| 用户认证/多用户 | 本地单用户场景，复用 authToken 即可 |
| WebSocket 实时推送 | MVP 用轮询；WebSocket 可作为后续优化 |
| Dashboard 内直接调用 MCP 工具 | Dashboard 调用底层服务，不经过 MCP 协议层 |
| 移动端适配 | 本地开发者工具，桌面浏览器即可 |
| 国际化 (i18n) | MVP 仅中文 + 英文标识符混合，与项目其余部分一致 |
| Server-side rendering | 本地 SPA，无 SEO 需求 |
| E2E browser 测试 | MVP 阶段用 API 集成测试 + 手工验收覆盖 |

## 依赖与顺序

- **无前置 spec 依赖**——所有底层服务（bootstrap-status、config、routines、work-activity、privacy）已就绪。
- **建议分组交付顺序**：

  | 组 | 内容 | 范围 |
  |---|---|---|
  | A | 架构基础设施 | DASH-01 ~ DASH-06、验收 1~4 |
  | B | 模块化框架 + Status | DASH-07 ~ DASH-14、验收 5~8 |
  | C | Config Manager | DASH-15 ~ DASH-20、验收 6, 9 |
  | D | Routines + Activity + Privacy + Logs | DASH-21 ~ DASH-31、验收 10~13 |
  | E | 构建集成与质量收尾 | 验收 14~16 |

  A → B → C/D（C 和 D 可并行）→ E。

- 开发方式遵循项目约束：禁止 TDD，按"实现 → 补测试 → 运行验证"推进。

## 实现参考（非规范性）

- `docs/superpowers/plans/2026-06-15-dashboard-web-ui.md` — 完整实施计划（18 个 Task，按 A→B→C→D→E 分组交付）

### 前端目录结构建议

```
dashboard/                    # 独立的前端源码目录（Vite 项目）
  src/
    App.tsx                   # Shell: sidebar + content area + theme toggle
    main.tsx                  # Entry: React root mount
    lib/
      api-client.ts           # fetch wrapper with auth token injection
      schema-to-form.ts       # JSON Schema → React form component 生成器
    modules/                  # 模块注册制——每个子目录是一个独立页面模块
      registry.ts             # 模块注册表：{ id, label, icon, route, component }[]
      status/
        StatusPage.tsx
        cards/                # 每个状态卡片是独立组件
          ServerCard.tsx
          CaptureCard.tsx
          RetrievalCard.tsx
          ...
      config/
        ConfigPage.tsx
        SchemaForm.tsx         # schema-driven 表单渲染器
      routines/
        RoutinesPage.tsx
        RoutineEditor.tsx
        RoutineHistory.tsx
      activity/
        ActivityPage.tsx
        SessionTimeline.tsx
        SearchPanel.tsx
      privacy/
        PrivacyPage.tsx
      logs/
        LogsPage.tsx
    components/               # 共享 Compound Components
      StatusCard.tsx
      MetricCard.tsx
      DataTable.tsx
      TimelineEntry.tsx
      TagList.tsx
      SecretField.tsx
```

### 后端 API 路由建议

```
src/
  dashboard/
    api/
      registry.ts             # API 路由注册表
      routes/
        status.ts              # GET /api/status → bootstrapStatus.getStatus()
        config.ts              # GET /api/config, PUT /api/config/:path
        routines.ts            # GET /api/routines, POST /api/routines, GET /api/routines/:name/history
        activity.ts            # GET /api/activity/sessions, POST /api/activity/search
        privacy.ts             # GET /api/privacy, POST /api/privacy/action
        logs.ts                # GET /api/logs
    serve-static.ts            # 从 dist/dashboard/ 提供预构建 SPA
```

### 关键设计决策

| 决策 | 理由 |
|------|------|
| 同进程嵌入而非独立应用 | 复用 authToken、绑定守卫、AppContext 中的全部服务实例——零额外进程开销 |
| schema-driven 配置表单 | 项目配置段持续增长（当前 14 个 section），手写 UI 不可维护；Zod → JSON Schema 可自动化 |
| 模块注册制 | 未来必增的模块（Meetings、Calendar、MCP Resources 等）不应要求修改框架代码 |
| REST API 而非复用 MCP 协议 | MCP 协议面向 agent，JSON-RPC 语义不适合浏览器 SPA；REST 是浏览器原生场景 |
| Recharts 做图表 | shadcn/ui 官方 chart 组件底层即 Recharts，生态一致，无额外学习成本 |
| 轮询而非 WebSocket | MVP 场景（30s 刷新状态）轮询完全够用，避免 WebSocket 状态管理复杂度 |
