---
doc_version: 9
doc_status: active
last_updated: 2026-09-04
---

# 配置文件

`computer-history-mcp` 从 `~/.computer-history-mcp/config.yaml` 读取运行时配置。

普通启动统一使用 `npm start`。应用配置或 onboarding 完成标记不存在时，它会启动或复用 Screenpipe，并转入 `npm run onboard`；onboarding 使用标准 Crimson 默认值创建应用配置，先备份任何现有配置，然后构建项目、启动托管服务、验证本地 MCP 端点，并将已验证的 `computer-history-mcp` 服务写入 Hermes 配置。`npm run setup` 在你只需要应用配置/日志目录而不运行完整 onboarding 流程时仍然可用；仅有它生成的配置不会让 `npm start` 误判安装已经完成。

## 配置文件位置

- 配置文件：`~/.computer-history-mcp/config.yaml`
- 应用主目录：`~/.computer-history-mcp/`
- onboarding 状态标记：`~/.computer-history-mcp/.onboarding-complete`
- 日志：`~/.computer-history-mcp/logs/`
- Screenpipe safe-record 维护日志：`~/.computer-history-mcp/logs/screenpipe-maintenance.jsonl`（7 天裁剪，超过 1 MB 轮转到 `screenpipe-maintenance.jsonl.1`）
- `npm run onboard` 创建的自动配置备份：`~/.computer-history-mcp/config.backup-YYYYMMDD-HHMMSS.yaml`
- `npm run onboard` 更新的 Hermes 配置：`~/.hermes/config.yaml`

如果已完成 onboarding 并想稍后修改设置，使用 [`config` CLI](#用-config-cli-管理配置)（或直接编辑 `~/.computer-history-mcp/config.yaml`），然后用 `npm run service:stop && npm run service:start` 重启托管服务。

## 首次运行默认行为

除非需要询问托管 provider 凭证，`npm run onboard` 使用以下默认值：

```yaml
server:
  mode: http
  host: 127.0.0.1
  port: 18765

logging:
  level: info

screenpipe:
  url: http://localhost:3030
  binaryPath: screenpipe
  dataDirectory: ~/.screenpipe

providers:
  embeddings:
    kind: ollama
    baseUrl: http://localhost:11434/v1
    model: nomic-embed-text

vectorStore:
  kind: chroma

retrieval:
  freshnessWindowMinutes: 15
  pollIntervalSeconds: 30
  maxCatchUpBatches: 3
  maxCatchUpRecords: 500
```

如果 Ollama 在 `http://localhost:11434/v1` 不可达，或配置的 `nomic-embed-text` 模型缺失，onboarding 会打印可操作的本地模型提示并回退到托管 OpenAI 兼容 provider，只询问：

- API 密钥
- base URL（默认：`https://api.deepseek.com`）
- 模型名（默认：`text-embedding-3-large` 占位符；替换为你的托管 provider 暴露的嵌入模型）

标准 onboarding 路径不需要填写用户名、auth-mode、Hermes 片段粘贴或手动编辑 YAML。

## Hermes 客户端配置

本地 MCP 服务验证后，`npm run onboard` 将本服务合并到 `~/.hermes/config.yaml`，同时保留其他 Hermes 设置和其他 MCP 服务：

```yaml
mcp_servers:
  computer-history-mcp:
    url: http://127.0.0.1:18765/mcp
    enabled: true
    tools:
      include:
        - internal-status
        - find
        - recall
        - inspect
        - memory-read
        - memory-write
        - file-analyze
        - privacy-control
        - routine-list
        - routine-history
```

自动 Hermes 配置步骤只接受 `127.0.0.1` 的 MCP 端点，并暴露全部 10 个 onboarding 白名单工具；`screenpipe-control` 和 `routine-create` 会保持为手动启用，因为它们能改变采集或创建后台调度任务。如果现有 Hermes 配置是无效的 YAML，onboarding 会明确失败并保持文件不变。

## 手动 setup

`npm run setup` 写入相同的默认配置结构和日志目录，但不启动服务。

## 用 config CLI 管理配置

无需手动编辑 `config.yaml`，你可以用内置的 `config` 子命令管理每一个字段。它在写入前按类型强制转换并校验取值、保留你的注释与格式、对密钥脱敏，并提示环境变量覆盖。它不会启动完整服务（不初始化 vector store 或运行时），因此速度快，即使其余配置已损坏也能继续工作。

从已构建的服务运行：

```bash
npm run build            # 首次构建出 dist/
node dist/src/index.js config <命令> ...
```

| 命令 | 作用 |
|------|------|
| `config list [--reveal]` | 打印所有生效字段。回落到 schema 默认值的标注 `(default)`，被环境变量覆盖的标注 `(overridden by env <VAR>)`。 |
| `config get <path> [--reveal]` | 读取单个点路径，例如 `config get providers.embeddings.model`。 |
| `config set <path> <value>` | 写入单个字段。取值会按类型强制转换，并在写入前对整个文件重新校验；配置文件不存在时自动创建。 |
| `config set <path> -- <value>` | 同上，用 `--` 终止符让以 `-` 开头的取值（例如负数 `analysis.embeddings.minScore`）不被当作 flag。 |
| `config unset <path>` | 删除一个可选字段，使其回落到 schema 默认值。必填字段不可 unset。 |
| `config add <path> <item>` | 向数组字段就地追加一项，保留注释。 |
| `config remove <path> <item>` | 从数组字段移除一项。 |
| `config validate` | 用 schema 校验当前 `config.yaml`，逐字段打印错误，失败时退出码非零。 |
| `config path` | 打印 `config.yaml` 的绝对路径。 |

标志：

- `--reveal` —— 以明文显示密钥字段（`providers.embeddings.apiKey`、`llm.api_key`、`screenpipe.apiKey`、`server.authToken`），而非 `***`。会打印警告，因为密钥会进入终端历史。
- `--` —— 终止符，其后的所有 token 都按字面值处理；用于以 `-` 开头的取值。

说明：

- **默认脱敏**：`list` 和 `get` 默认遮蔽密钥，仅 `--reveal` 显示。
- **运行时以环境变量为准**：若某字段当前被环境变量（例如 `MCP_PORT`）覆盖，CLI 会提示你，因此看似"没生效"的 `set` 会被解释，而不是静默。
- **计算路径只读**：`paths.*` 等派生值不是文件字段，不能 `set`。

执行 `set`、`unset`、`add`、`remove` 之后，重启托管服务使改动生效：`npm run service:stop && npm run service:start`。

## 配置字段

### `server`

| 字段 | 类型 | 默认值 | 备注 |
|------|------|--------|------|
| `mode` | `stdio` \| `http` | `http` | 官方 Crimson 交付使用 `http`。 |
| `host` | string | `127.0.0.1` | `service:start` 拒绝非本地主机。 |
| `port` | 正整数 | `8765` | schema 默认值为 `8765`，但官方 setup/onboarding 路径写入 `18765` 以使托管本地 HTTP 服务使用可预测的端点。 |

### `logging`

| 字段 | 类型 | 默认值 | 备注 |
|------|------|--------|------|
| `level` | `debug` \| `info` \| `warn` \| `error` | `info` | 控制服务日志详细程度。 |

### `capture`

| 字段 | 类型 | 默认值 | 备注 |
|------|------|--------|------|
| `provider` | `screenpipe` | `screenpipe` | 屏幕记忆采集、inspect、trim 与录制进程控制由哪个 capture provider 支撑。当前仅支持 `screenpipe`；新增 provider 需要在 `src/services/capture/providers/` 下新建目录并增加 enum 成员。 |
| `livenessThresholdSeconds` | 正整数 | `120` | 最新帧在该阈值内视为采集存活（`ok`），超过则采集状态判定为 `idle`。 |
| `permissionsGracePeriodSeconds` | 非负整数 | `60` | 录制进程启动后的宽限期，超过该时间仍无帧才报告 `permissions-missing`。 |
| `ocrLanguages` | 语言名数组 | `['english']` | OCR 识别语言，作为重复的 `screenpipe record --language <name>` 参数传给录制进程。取值为 screenpipe `Language` 名的常用子集（上游共约 76 种）：`english`、`chinese`、`japanese`、`korean`、`french`、`german`、`spanish`、`russian`、`portuguese`、`italian`、`arabic`。**顺序即优先级**——在 macOS 上 Apple Vision 以**第一个**语言作为 OCR 主模式（基于内部 OCR 调研）。设为 `[chinese, english]` 即启用中文优先采集。取值是语言名（如 `chinese`），不是 Apple locale 码（`zh-Hans`）。本轮 dashboard 对该字段只读显示。 |

```yaml
capture:
  # Which capture provider backs screen-memory ingestion.
  # Currently supported: screenpipe (default).
  provider: screenpipe
  # OCR 识别语言（顺序即优先级；首语言在 macOS 上是 Apple Vision 主模式）。默认仅英文。
  ocrLanguages:
    - chinese
    - english
```

通过 CLI 设置 OCR 语言用 `config add`（它是**追加**而非替换——每种语言执行一次；**第一个**加入的语言成为 Apple Vision 主模式）：

```bash
node dist/src/index.js config add capture.ocrLanguages chinese
node dist/src/index.js config add capture.ocrLanguages english
```

### `screenpipe`

`screenpipe` capture provider 的专属配置块（类比 `providers.embeddings` 之于 embedding provider），仅在 `capture.provider` 为 `screenpipe` 时生效。

| 字段 | 类型 | 默认值 | 备注 |
|------|------|--------|------|
| `url` | string | schema 中未设置；onboarding 写入 `http://localhost:3030` | 正常 Crimson 流程中必须指向可达的本地 Screenpipe 服务。 |
| `binaryPath` | 非空字符串 | `screenpipe` | recorder 可执行文件名或路径，支持展开 `~/`。用带版本的绝对路径选择开发构建，无需覆盖全局稳定命令。 |
| `dataDirectory` | 非空字符串 | `~/.screenpipe` | 同时传给 `screenpipe record --data-dir`，并供索引、inspect、诊断、隐私删除、trim 和维护读取。支持展开 `~/`；禁止两个同时运行的 recorder 共用该目录。 |

### `providers.embeddings`

| 字段 | 类型 | 默认值 | 备注 |
|------|------|--------|------|
| `kind` | string | schema 中为 `openai-compatible`；Ollama 可达时 onboarding 写入 `ollama` | 代码接受任意字符串，官方示例使用 `ollama` 和 OpenAI 兼容 provider。 |
| `baseUrl` | string | schema 中未设置 | 嵌入 API base URL。Ollama 可用时 onboarding 默认 `http://localhost:11434/v1`，否则使用托管 OpenAI 兼容端点。 |
| `model` | string | schema 中未设置 | 嵌入模型名。Ollama 时默认 `nomic-embed-text`，否则使用你选择的托管 provider 的嵌入模型。 |
| `apiKey` | string | 未设置 | 本地 provider（如 Ollama）通常不需要；托管 provider 通常需要。此凭证仅用于嵌入端点，与 LLM 摘要路径使用的 DeepSeek 密钥无关。 |
| `concurrency` | 正整数 | `2` | 限制共享运行时 provider 的并发嵌入请求数。对有严格并发或速率限制的托管 provider 可降低此值。 |

### LLM provider（摘要生成）

嵌入层和 LLM 层独立配置：

- **嵌入**（`providers.embeddings`）接受任何 OpenAI 兼容 API 端点。本地默认为 `http://localhost:11434/v1` 的 Ollama；任何托管 OpenAI 兼容 provider 同样适用。
- **LLM 摘要**（`analysis.summary.provider`）默认使用本地 `template` provider。选择 `remote-llm` 时，摘要 worker 调用 `llm.{base_url, api_key, model}` 描述的 DeepSeek chat 端点。标准值为 `https://api.deepseek.com`、`${DEEPSEEK_API_KEY}`、`deepseek-chat`。完整块参见 `config.yaml.example`。

简而言之：嵌入端点自由选择，但 `remote-llm` 摘要路径仅支持 DeepSeek。

### `vectorStore`

| 字段 | 类型 | 默认值 | 备注 |
|------|------|--------|------|
| `kind` | string | `chroma` | 当前 Crimson 存储契约假设 Chroma 风格的本地持久化。 |
| `path` | string | 未设置 | 可选的自定义检索制品路径。省略时检索制品存放在应用主目录下。 |

### `retrieval`

| 字段 | 类型 | 默认值 | 备注 |
|------|------|--------|------|
| `freshnessWindowMinutes` | 正整数 | `15` | 检索响应中使用的新鲜度目标。 |
| `pollIntervalSeconds` | 正整数 | `30` | 后台检索轮询间隔。 |
| `maxCatchUpBatches` | 正整数 | `3` | 限制每个周期的追赶工作量。 |
| `maxCatchUpRecords` | 正整数 | `500` | 限制追赶期间处理的记录数。 |

### `routines`

控制本地 routines 引擎。Routine 是按 cron 调度在后台运行的任务，每个 routine 携带一个 `prompt` 字段；调度器将该 prompt 与从近期屏幕活动中检索到的证据一起发送给已配置的 LLM，并将结果存入执行历史。若未配置 LLM，则使用模板兜底方案。

| 字段 | 类型 | 默认值 | 备注 |
|------|------|--------|------|
| `enabled` | boolean | `false` | 为 `false` 时不调度或执行任何 routine。设为 `true` 以激活调度器。 |
| `definitionsPath` | string | `~/.computer-history-mcp/routines/definitions/` | routine 定义 JSON 文件的持久化目录，支持 `~/` 展开。省略时使用应用主目录下的默认路径。 |
| `historyPath` | string | `~/.computer-history-mcp/routines/history/` | routine 执行历史 JSON 文件的持久化目录（每 routine 一个文件，最新优先）。支持 `~/` 展开。省略时使用应用主目录下的默认路径。 |

默认存储结构：

```
~/.computer-history-mcp/
  routines/
    definitions/   ← 每个 routine 一个 JSON 文件（以 slug 命名）
    history/       ← 每个 routine 一个 JSON 文件（执行记录，最新优先）
```

使用默认路径启用 routines：

```yaml
routines:
  enabled: true
```

自定义存储路径：

```yaml
routines:
  enabled: true
  definitionsPath: ~/my-data/routines/definitions
  historyPath: ~/my-data/routines/history
```

**尚未支持** —— 手动触发 routine 运行、routine 输出作为 MCP resources、跨机器同步。这些需求在项目待办中跟踪，留待后续版本实现。

## 环境变量覆盖

加载器可通过环境变量覆盖配置值：

- `MCP_MODE`
- `MCP_PORT`
- `MCP_LOG_LEVEL`
- `SCREENPIPE_BASE_URL`

通过 `npm run service:start` 启动服务时，托管服务脚本还会注入 launchd 专用的端口覆盖。

## 示例：本地 Ollama

```yaml
server:
  mode: http
  host: 127.0.0.1
  port: 18765

logging:
  level: info

screenpipe:
  url: http://localhost:3030

providers:
  embeddings:
    kind: ollama
    baseUrl: http://localhost:11434/v1
    model: nomic-embed-text

vectorStore:
  kind: chroma

retrieval:
  freshnessWindowMinutes: 15
  pollIntervalSeconds: 30
  maxCatchUpBatches: 3
  maxCatchUpRecords: 500
```

## 示例：托管 OpenAI 兼容嵌入

以下示例通用使用 OpenAI 兼容 API 格式——`apiKey` 是嵌入端点的凭证，与 `remote-llm` 摘要 provider 使用的 DeepSeek 密钥无关。

```yaml
server:
  mode: http
  host: 127.0.0.1
  port: 18765

logging:
  level: info

screenpipe:
  url: http://localhost:3030

providers:
  embeddings:
    kind: openai-compatible
    baseUrl: https://api.example-embeddings.com/v1
    model: your-embedding-model
    apiKey: sk-your-key
    concurrency: 2

vectorStore:
  kind: chroma
```

## 验证行为

- `npm run onboard` 在本地 Screenpipe 无法在默认端点访问时提前失败。
- `npm run onboard` 优先使用本地 Ollama（可达且配置的嵌入模型已安装时）；否则提示输入托管 provider 凭证。
- `npm run onboard` 在服务启动后运行首次实时 MCP 验证（`internal-status`、`recall`、`find`），然后写入 Hermes 配置。
- 如果配置文件存在但不符合 schema，启动失败并报 `Invalid config file` 错误。
- `service:start` 拒绝 `127.0.0.1` 以外的任何 `server.host`。

## 相关文档

- [MCP 工具](/zh/reference/tools) — 工具集参考
- [排障](/zh/guide/troubleshooting) — 按症状诊断
- [隐私与数据](/zh/reference/privacy) — 数据本地化和隐私控制
