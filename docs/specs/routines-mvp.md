---
doc_version: 1
doc_status: active
last_updated: 2026-06-12
---

# Spec: Routines MVP（剩余范围）

## 背景

Routines 让本地 MCP server 在后台按 cron 调度执行确定性任务（首个内置任务为 `daily_summary`），并把定义与执行历史以文件形式持久化在本地 app 目录。配置与存储目录的地基已完成（原 ROUT-09、ROUT-10，2026-05-02 随 GSD Phase 6 交付：操作者可通过配置开关 routines 并覆写存储路径，setup 会创建默认目录）。本 spec 收敛剩余的全部 MVP 范围。

## 目标

MCP client 可以创建、列出、巡检本地 routines；启用的 routines 按 cron 在后台确定性执行且不重叠，定义与历史跨重启留存。

## 需求

需求编号沿用项目需求池原始命名（PRD / `.planning/REQUIREMENTS.md` 历史归档）。

### A. 持久化（原 GSD Phase 7 范围）

- **ROUT-04**: Routine names are normalized to filesystem-safe slugs and persisted as local definition records.
- **ROUT-05**: Routine execution history is persisted locally newest-first and remains available across server restarts.

### B. 调度执行（原 GSD Phase 8 范围）

- **ROUT-06**: Enabled routines execute in the background on their configured cron schedule when routines are enabled in config.
- **ROUT-07**: Scheduler does not overlap concurrent runs of the same routine.
- **ROUT-08**: The built-in `daily_summary` routine produces a deterministic report from existing recent activity data without introducing a new LLM provider.

### C. MCP 工具（原 GSD Phase 9 范围）

- **ROUT-01**: User can list configured local routines through MCP and see each routine's schedule, enabled state, prompt, recent-activity window, timestamps, and latest run summary when present.
- **ROUT-02**: User can create or update a local routine through MCP by providing a name, prompt, and cron schedule.
- **ROUT-03**: User can inspect recent execution history for a named routine through MCP.

### D. 交付与验证（原 GSD Phase 10 范围）

- **ROUT-11**: Maintained docs describe routine tools, config defaults, storage paths, and the routines MVP scope.
- **ROUT-12**: Automated integration, contract, acceptance, typecheck, and build coverage verify the routines MVP end to end.

## 验收标准

以下条款必须为真（迁移自原 roadmap Success Criteria，逐条可自动化检验）：

**持久化**
1. 当 routine 名称包含空格、混合大小写或标点时，持久化的定义文件使用文件系统安全的 slug。
2. server 重启后，已持久化的 routine 定义仍可从本地定义存储读取。
3. 执行历史按 newest-first 存储，server 重启后仍可读取。

**调度执行**
4. routines 启用时，已配置的 routines 按其 cron 计划在后台执行。
5. 当上一次运行尚未结束而下一次触发到达时，第二次运行被跳过（记录 skip），而不是并发重叠。
6. 内置 `daily_summary` 从既有 recent-activity 数据产出可读摘要，不要求新的 LLM provider 或远程执行面。

**MCP 工具**
7. MCP client 可通过提供 name、prompt、cron schedule 创建新 routine 或更新既有 routine。
8. MCP client 可列出已配置 routines，并看到每个 routine 的 schedule、enabled 状态、prompt、recent-activity 窗口、时间戳，以及（存在时的）最近一次运行摘要。
9. MCP client 可按名称请求某 routine 的近期执行历史，获得结构化的 newest-first 结果。

**交付验证**
10. 维护文档说明 `routine-list` / `routine-create` / `routine-history` 工具、routines 配置默认值、存储路径与 MVP 范围边界。
11. contract、integration、acceptance、typecheck、build 自动化检查对 routines MVP 端到端全部通过。
12. 文档化的 MVP 面**不包含**：meetings、calendar、手动触发运行、MCP routine resources、任意 LLM-backed 执行。

## 范围外

| 项 | 原因 |
|---|---|
| 手动触发 routine 执行（ROUT-F01） | 远期需求池，见 [future-backlog.md](./future-backlog.md) |
| routine 输出暴露为 MCP resources（ROUT-F02） | 同上 |
| 任意 LLM-backed prompt routines（ROUT-F03） | MVP 必须保持确定性、复用既有 `recentActivity` |
| 跨机器/远程 agent 同步（ROUT-F04） | local-first MVP |
| meetings / calendar 工具 | 独立远期需求，见 future-backlog |

## 依赖与顺序

- 内部顺序：A（持久化）→ B（调度）→ C（工具）→ D（验证）。B 依赖 A 的存储契约，C 依赖 B 的运行时行为，D 收尾。
- 外部依赖：建议在 [capture-provider-decoupling.md](./capture-provider-decoupling.md) **之后**实施——两者都重构 `src/bootstrap/create-app.ts` 的装配区（调度器从 bootstrap 接线），先完成 capture 解耦可避免在旧边界上堆新接线。
- 开发方式遵循项目约束：禁止 TDD，按"实现 → 补测试 → 运行验证"推进；自动化验收覆盖要求不变。

## 实现参考（非规范性）

- `docs/plan/v1.1-routines-mvp-implementation-plan.md` — 既有的完整实现计划（任务分解、代码草案、文件清单）。**注意**：该计划基于 capture 解耦前的 bootstrap 结构编写，执行时若 capture-provider-decoupling 已落地，bootstrap 接线部分需按新结构调整。
- `.planning/phases/06-*/` — 已完成的配置与 setup 地基的历史执行记录。
