---
doc_version: 1
doc_status: active
last_updated: 2026-06-16
---

# Routines（定时任务）

Routine 是按 cron 调度自动运行的后台任务。每个 routine 携带一条自然语言 `prompt`；调度触发时，服务会在配置的时间窗口内检索相关的屏幕活动，将证据与你的 prompt 一起发送给 LLM，并将生成的简报存入执行历史。

典型使用场景：早会准备、竞品动态摘要、每日工作总结、周度项目回顾。

## 前置条件

### 1. 启用调度器

Routines 默认关闭。在 `~/.computer-history-mcp/config.yaml` 中添加：

```yaml
routines:
  enabled: true
```

### 2. 配置 LLM

Routine 调用 OpenAI 兼容的 `chat/completions` 接口生成简报。在配置中添加 `llm` 块：

```yaml
llm:
  base_url: https://api.deepseek.com
  api_key: ${DEEPSEEK_API_KEY}
  model: deepseek-chat
```

任何 OpenAI 兼容的 provider 均可——DeepSeek、OpenAI、本地 Ollama 等。若 `base_url` 或 `api_key` 缺失，执行器会降级为确定性模板（仅含会话计数和时长，不调用 LLM）。

### 3. 重启服务

```bash
npm run down && npm run up
```

## 创建 Routine

Routine 通过 `routine-create` MCP 工具创建。向已连接的 agent 描述需求即可：

> "创建一个叫 'morning-standup' 的 routine，工作日早上 9 点运行，总结一下我昨天做了什么。"

Agent 会调用 `routine-create`，调度器立即生效——无需重启服务。

### 字段说明

| 字段 | 是否必填 | 说明 |
|------|----------|------|
| `name` | 是 | 规范化为 slug（如 `morning standup` → `morning-standup`） |
| `prompt` | 是 | 给 LLM 的自然语言指令 |
| `schedule` | 是 | 5 字段 cron 表达式 |
| `enabled` | 否 | 默认 `true` |
| `recentActivityMinutes` | 否 | 回溯窗口（分钟）；省略时自动从调度频率推断 |

### Cron 调度参考

| 表达式 | 含义 |
|--------|------|
| `0 9 * * 1-5` | 工作日 09:00 |
| `0 8 * * *` | 每天 08:00 |
| `0 17 * * 5` | 每周五 17:00 |
| `0 9 * * 1` | 每周一 09:00 |
| `0 9 1 * *` | 每月 1 日 09:00 |

### 自动推断回溯窗口

未设置 `recentActivityMinutes` 时，服务根据 cron 调度频率自动推断合理的默认值：

| 调度频率 | 推断窗口 |
|----------|----------|
| 次日级以上（如每小时） | 60 分钟 |
| 每日 | 1 440 分钟（24 小时） |
| 每周 | 10 080 分钟（7 天） |
| 每月 | 43 200 分钟（30 天） |

也可通过显式设置 `recentActivityMinutes` 覆盖推断结果。

## 执行流程

调度触发后：

1. **检索证据** — `FindService` 根据 prompt 中的关键词对近期屏幕活动进行关键词检索；`RecallService` 在同一时间窗口内获取会话概览。两者并行执行。
2. **组装上下文** — 证据按内容去重并截断，控制在 token 预算内（证据约 6 000 字符，会话概览约 2 000 字符）。
3. **调用 LLM** — 服务将包含你的 `prompt`、活动概览和证据片段的结构化请求发送至已配置的 LLM 接口。
4. **保存结果** — LLM 响应存储为 `RoutineRunRecord`，包含 `summary`（首行）和 `output`（完整响应）。状态为 `success`、`failed` 或 `skipped`（重叠保护、隐私暂停）。

## 查看结果

向 agent 请求执行历史：

> "查看 morning-standup routine 最近 5 次的执行结果。"

Agent 调用 `routine-history` 并返回包含生成简报的执行记录。

也可在 [Dashboard](/zh/reference/dashboard) (`http://127.0.0.1:<port>/`) 中查看和管理 routine。

## Prompt 示例

```
总结一下我昨天的工作内容，用于早会汇报。
```

```
列出我本周看过的竞品或竞品定价信息。
```

```
整理我今天遇到的 bug 或报错信息。
```

```
回顾本周的项目决策和待确认事项。
```

## 隐私

Routine 会检索屏幕内容并发送至已配置的 LLM 接口。当隐私守护暂停时（`privacy-control` 工具），routine 拒绝运行，并记录一条 `skipped` 记录，而不会向 LLM 发送任何数据。详见[隐私与数据](/zh/reference/privacy)。

## 排障

**Routine 显示 `failed` 状态** — 查看运行记录中的 `error` 字段。常见原因：LLM 接口不可达、API Key 无效、或回溯窗口内没有活动数据。

**输出是会话统计表而非简报** — LLM 未配置。在 `config.yaml` 中添加 `llm` 块并重启服务。

**Routine 从未触发** — 确认配置中 `routines.enabled: true`，并确认配置更改后服务已重启。运行 `npm run service:logs` 查看调度器启动日志。
