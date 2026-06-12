---
doc_version: 1
doc_status: active
last_updated: 2026-06-12
---

# 隐私与数据

## 数据本地化

`canary-alpha-mcp` 在设计上完全本地化：

- 托管 HTTP 服务仅绑定 `127.0.0.1`，拒绝来自其他机器的连接。
- 所有派生数据（索引、配置、日志）存储在本机的 `~/.canary-alpha-mcp/` 下。
- 服务除你配置的嵌入端点（默认为本地 Ollama）外，不向任何外部网络发出请求。
- 无遥测，无使用报告。

## 采集内容

Screenpipe 负责采集你的屏幕活动，`canary-alpha-mcp` 读取并索引这些数据，不控制 Screenpipe 采集什么。

使用 `npm run screenpipe:safe-record` 启动 Screenpipe 时，本仓库的 wrapper 会应用更安全的本地开发默认值：

- **PII 去除**：已启用
- **保留期**：有界本地保留
- **忽略的窗口**：针对 macOS 常见低价值系统 UI 的窄范围默认集
- **忽略的应用**：针对高风险本地应用的小型仓库管理集
- **音频采集**：默认禁用——通过 `--audio-device`、`--use-system-default-audio` 或 `--experimental-coreaudio-system-audio` 选择启用
- **视觉采集**：默认禁用——通过 `--monitor-id`、`--use-all-monitors` 或 `--included-windows` 选择启用
- **音频转录**：即使启用音频也默认关闭——通过 `--audio-transcription-engine` 选择启用；显式的 `--disable-audio` 会覆盖 wrapper 的音频意图默认值

如果使用 Screenpipe 桌面应用，采集设置在 Screenpipe 应用偏好设置中控制。

## 运行时隐私控制

`privacy-control` MCP 工具允许任何已连接的 agent 在运行时检查和修改采集控制：

```json
{ "action": "status" }
```

返回当前采集状态、暂停状态和被排除的应用列表。

```json
{ "action": "pause" }
```

立即暂停 Screenpipe 采集。

```json
{ "action": "resume" }
```

恢复采集。

```json
{ "action": "exclude-app", "app": "AppName" }
```

将应用添加到排除列表。传入 `"rebuild": true` 可在排除后同时重建检索索引。

相同操作也可通过命令行的 `scripts/privacy-control.js` 脚本执行：

```bash
node scripts/privacy-control.js status
node scripts/privacy-control.js pause
node scripts/privacy-control.js resume
node scripts/privacy-control.js exclude-app --app "Claude"
```

## 存储与保留

| 路径 | 内容 |
|------|------|
| `~/.canary-alpha-mcp/config.yaml` | 服务配置 |
| `~/.canary-alpha-mcp/logs/` | 服务日志和维护记录 |
| `~/.canary-alpha-mcp/logs/screenpipe-maintenance.jsonl` | 维护运行记录 |
| `~/.screenpipe/` | Screenpipe 原始采集数据（由 Screenpipe 管理） |

**维护日志轮转**：`screenpipe-maintenance.jsonl` 裁剪保留最近 7 天，超过 1 MB 时轮转到 `screenpipe-maintenance.jsonl.1`。

`~/.screenpipe/` 下的 Screenpipe 原始数据由 Screenpipe 本身管理。要删除已采集的范围，使用带适当删除操作的 `privacy-control` 工具，或通过 Screenpipe 桌面应用直接管理。
