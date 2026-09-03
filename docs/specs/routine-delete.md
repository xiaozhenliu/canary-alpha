---
doc_version: 1
doc_status: active
last_updated: 2026-06-17
---

# Spec: Routine Delete

## 背景

Routines MVP（v2.4.0，[routines-mvp.md](./routines-mvp.md)）与 Routines v2（v2.7.0，[routines-v2-llm-execution.md](./routines-v2-llm-execution.md)）均只定义了创建与更新操作（ROUT-02），从未规定删除路径。这是一个规格遗漏，不是有意推迟的决策。

当前状态：用户可通过 MCP 工具 `routine-create`（create or update）和 Dashboard 表单管理 routine，但无法删除任何 routine——无论通过 MCP 还是 Dashboard。唯一的替代手段是直接删除 `~/.computer-history-mcp/routines/definitions/` 下的定义文件，这对 MCP 客户端用户不可接受，对 Dashboard 用户完全不可见。

`FileRoutineStore` 内部已把定义（`definitions/`）与执行历史（`history/`）分开存储，因此删除操作天然需要区分两个行为：移除定义（必然）与清除历史（可选）。

## 目标

用户可通过 MCP 工具和 Dashboard 删除已有 routine；删除定义时默认保留执行历史，支持可选清除。

## 需求

### ROUT-D01 MCP 删除工具

User can delete a routine definition by name through a new MCP tool `routine-delete`.

- Input: `name`（routine slug，必填）；`purge_history`（boolean，可选，默认 `false`）。
- `name` 必须是已存在的 routine slug；不存在时工具返回结构化错误，不抛出未处理异常。
- 当 `purge_history` 为 `false`（默认）时，仅删除定义文件，历史文件保留。
- 当 `purge_history` 为 `true` 时，同时删除定义文件与该 routine 的所有历史文件。
- 删除后调度器立即刷新（`scheduler.refresh()`），确保对应 cron job 取消，无需重启服务。

### ROUT-D02 Dashboard API 端点

Dashboard REST API 提供 `DELETE /routines/:name` 端点。

- Path param `name` 为 routine slug。
- Query param `purge_history=true` 触发历史清除；省略或为其他值则仅删除定义。
- 成功返回 HTTP 204 No Content；routine 不存在返回 HTTP 404 及结构化错误体。
- 端点需要 Bearer token 认证（与其他 `/api/*` 路由一致）。

### ROUT-D03 Dashboard UI 删除操作

Dashboard Routines 页面为每个 routine 提供删除操作。

- 删除操作须有二次确认（`window.confirm` 或内联确认步骤均可），防止误触。
- 确认后调用 `DELETE /routines/:name`（不带 `purge_history`，即仅删除定义）。
- 操作完成后刷新列表；失败时在页面内展示错误信息。
- Dashboard 不提供 `purge_history` 选项（高级用法留给 MCP 工具）。

### ROUT-D04 调度器同步

删除操作（无论来自 MCP 还是 Dashboard API）完成后，若调度器正在运行，须立即调用 `scheduler.refresh()` 使删除生效。

- 被删除 routine 的下一个计划触发时间不得再执行。
- 若 routine 当前正在执行，当次运行不中断，但不再安排后续运行。

## 验收标准

以下条款必须为真，全部可自动化检验：

1. `routine-delete` MCP 工具以存在的 routine slug 调用后，`store.readDefinition(name)` 返回 `undefined`。
2. `routine-delete` MCP 工具以不存在的 slug 调用后，返回 `isError: true` 的结构化错误，不抛出未捕获异常。
3. `purge_history: false`（默认）时，删除后 `store.listRuns(name, 100)` 仍返回历史记录。
4. `purge_history: true` 时，删除后 `store.listRuns(name, 100)` 返回空数组，历史文件不存在于磁盘。
5. `DELETE /routines/:name` 返回 204；对不存在的 name 返回 404。
6. 无 Bearer token 调用 `DELETE /routines/:name` 返回 401。
7. 删除后，`GET /routines` 返回的列表中不再包含该 routine。
8. 删除后调度器刷新，该 routine 的 cron job 不再触发（integration test 可通过 spy `scheduler.refresh` 验证调用发生）。
9. Dashboard Routines 页面点击删除、二次确认后，列表中该 routine 消失（前端行为测试或 e2e 验收）。

## 范围外

| 项 | 原因 |
|---|---|
| 批量删除（一次删除多个 routine） | YAGNI——当前数据量不需要 |
| 撤销 / 软删除 / 归档 | 增加状态机复杂度，超出当前需求 |
| Dashboard 提供 `purge_history` 选项 | 高级用法留给 MCP 工具；Dashboard 面向普通运维 |
| 删除正在执行的 routine 时中止执行 | 当次执行不中断，行为明确；中止需要可取消异步机制，超出范围 |

## 依赖与顺序

- 前置：[routines-mvp.md](./routines-mvp.md)（`FileRoutineStore` 持久化契约）— 已完成。
- 前置：[routines-v2-llm-execution.md](./routines-v2-llm-execution.md)（`PromptDrivenExecutor`、`RoutineScheduler.refresh()`）— 已完成。
- 本 spec 无外部依赖，可独立实施。
- 实施后需同步更新：`docs/reference/tools.md`（新增 `routine-delete` 工具）、`docs/zh/reference/tools.md`、`docs/reference/dashboard.md`（`DELETE /routines/:name` 端点）、`CHANGELOG.md`、`package.json`（版本 bump）。

## 实现参考（非规范性）

- 定义文件存储路径：`~/.computer-history-mcp/routines/definitions/<slug>.json`（`src/services/routines/file-routine-store.ts`）
- 历史文件存储路径：`~/.computer-history-mcp/routines/history/<slug>/`（同文件）
- 调度器刷新入口：`src/services/routines/scheduler.ts` — `RoutineScheduler.refresh()`
- Dashboard API 路由注册：`src/dashboard/routes/routines.ts`
- MCP 工具注册：`src/mcp/register-tools.ts`，工具实现放 `src/mcp/tools/routine-delete.ts`
