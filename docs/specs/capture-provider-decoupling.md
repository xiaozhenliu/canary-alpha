---
doc_version: 3
doc_status: deprecated
last_updated: 2026-06-14
---

# Spec: Capture Provider 解耦

> **状态：已完成。** 本 spec 的全部需求（CAP-01 ~ CAP-09）与验收标准已于 2026-06-14 前交付。关键 commit 链：`28ee077`（中立端口）→ `89c0163`（Screenpipe 收敛）→ `2eb928b`（config-driven factory）→ `4e9c928`（checkpoint 命名空间）→ `054d597`（capabilities/diagnostics）→ `7741048`（契约测试）→ `94d5511`（文档）→ `2d27a0b`（provider 类名中立化）。迁移产出的过渡期技术债已登记于 `docs/engineering/tech-debt.md`（TD-004 ~ TD-007），按各自触发条件独立收敛。

## 背景

屏幕采集当前由 Screenpipe 提供，但其开源许可对商业化不友好，且其商业化方向与本项目存在重合，未来可能切换到以无障碍树（accessibility tree）为主的其他采集工具。当前代码对 Screenpipe 的耦合分布在四种形态：HTTP 查询客户端（已有接口接缝但命名泄漏）、直接读取其 SQLite（inspect 链路）、直接写入其 SQLite（trim/retention）、进程生命周期控制；此外裸 `frameId` 已作为关联键写入 vector-store metadata 与 checkpoint 文件，`SCREENPIPE_UNAVAILABLE` 错误码已暴露给外部 agent。

## 目标

Screenpipe 收敛为 `src/services/capture/providers/screenpipe/` 目录下的一个可替换 capture provider；接入新采集工具只需新增一个 provider 目录 + 一行配置（`capture.provider`）。

## 需求

- **CAP-01**: 存在中立的 capture 领域模型与端口（`CaptureRecord`、`CaptureClient`、`CaptureFrameDetailPort`、`CaptureLifecyclePort`、`CaptureCapabilities`），上层服务只依赖这些端口。
- **CAP-02**: Screenpipe 专属知识（上游 SQLite schema、`~/.screenpipe` 路径、HTTP 响应形状、进程脚本）只允许出现在 provider 目录及白名单层（config env 映射、provider 专属诊断），由自动化边界测试守卫。
- **CAP-03**: provider 通过配置项 `capture.provider` 选择，由工厂装配；新增 provider 不要求修改任何上层服务代码。
- **CAP-04**: 持久化存储使用中立标识 `captureId`（`<provider>:frame:<id>` 格式）作为 capture 关联键；过渡期与遗留裸 `frameId` 双写、删除路径双键匹配，旧键随 retention 自然过期。
- **CAP-05**: 检索 checkpoint 按 provider 命名空间隔离，升级时无损接管既有 checkpoint（不触发全量重建索引）。
- **CAP-06**: 对外错误码中立化为 `CAPTURE_SOURCE_UNAVAILABLE`，`SCREENPIPE_UNAVAILABLE` 在兼容窗口内保留为合法别名。
- **CAP-07**: 上层按 `CaptureCapabilities` 能力标志分支（OCR、AX tree、frame detail、retention trim、process lifecycle），禁止按 provider 名分支；provider 缺失某能力时对应路径按文档化的降级行为运行。
- **CAP-08**: 存在 provider 无关的 `CaptureClient` 契约测试套件，任何 provider 实现通过同一组断言验证。
- **CAP-09**: 受治理文档记录 `capture.provider` 配置项与 provider 边界规则。

## 验收标准

1. `npm run typecheck` 与全量测试（unit、contract、integration、acceptance）全绿。
2. `grep -rn "ScreenpipeRecord\|ScreenpipeClient" src` 仅命中 deprecated 别名声明与 provider 目录。
3. 边界守卫契约测试通过（`FROM frames`、`.screenpipe`、provider 名分支等令牌被限制在白名单层），白名单每一项有注释理由。
4. 新索引数据的 vector-store metadata 同时包含 `captureId` 与遗留 `frameId`；checkpoint 文件为 `retrieval-checkpoint.screenpipe.json` 且旧文件被无损接管。
5. `status` 工具输出当前 `capture.provider` 与 capabilities。
6. 检索失败时对外错误码为 `CAPTURE_SOURCE_UNAVAILABLE`，error 对象保留 `screenpipeCode` 兼容属性。
7. 受治理文档 metadata 合规更新（`doc_version` 递增、`last_updated` 当日）。

## 范围外

- 实现第二个 capture provider（本 spec 只交付可插拔边界）。
- 视频帧 / OCR 历史数据迁移。
- `scripts/screenpipe-safe-record.js` 的改造。
- storage-diagnostics 系列类型的中立化（本质为 Screenpipe 专属诊断，原地保留）。
- trim 的完整端口化（当前以路径注入 + capability 门控覆盖；第二个 provider 需要 retention 时再抽象为 `CaptureRetentionPort`）。

## 依赖与顺序

- 无前置依赖。**建议排在所有触碰 `src/bootstrap/create-app.ts` 的新功能（含 [routines-mvp.md](./routines-mvp.md)）之前**，避免在旧边界上堆积新装配代码。
- 兼容窗口收尾（删除 deprecated 别名、`frameId` 双写、`SCREENPIPE_UNAVAILABLE` 别名）安排在本 spec 落地后一个 retention 周期 + 一个发布周期，作为独立小任务。

## 实现参考（非规范性）

**已完成的计划文档**：

- `docs/superpowers/plans/2026-06-12-capture-provider-migration.md` — 完整实施计划：六个 Stage、11 个任务。本地工作区文件（`docs/superpowers/**` 在 .gitignore 中，不入库）。全部任务已执行完毕，checkbox 状态未回勾属文档同步遗漏。
- `.kiro/specs/accessibility-capture-ingestion/` — AX 主路径修复的历史 spec（解释了现有 dual-query AX/OCR 结构的由来）。
