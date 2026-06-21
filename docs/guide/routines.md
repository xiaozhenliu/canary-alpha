---
doc_version: 1
doc_status: active
last_updated: 2026-06-16
---

# Routines

Routines are background tasks that run automatically on a cron schedule. Each routine carries a plain-language `prompt`; when the schedule fires, the server retrieves relevant screen activity for the configured time window, sends the evidence to an LLM alongside your prompt, and saves the generated briefing to the execution history.

Typical use cases: morning standup prep, competitor research digest, end-of-day work summary, weekly project recap.

## Prerequisites

### 1. Enable the scheduler

Routines are disabled by default. Add the following to `~/.canary-alpha-mcp/config.yaml`:

```yaml
routines:
  enabled: true
```

### 2. Configure an LLM

Routines call an OpenAI-compatible `chat/completions` endpoint to produce their briefings. Add the `llm` block to your config:

```yaml
llm:
  base_url: https://api.deepseek.com
  api_key: ${DEEPSEEK_API_KEY}
  model: deepseek-chat
```

Any OpenAI-compatible provider works — DeepSeek, OpenAI, a local Ollama instance, etc. If `base_url` or `api_key` is absent, the executor falls back to a deterministic template (session counts and durations only, no LLM call).

### 3. Restart the service

```bash
npm run down && npm run up
```

## Creating a routine

Routines are created through the `routine-create` MCP tool. Ask your connected agent:

> "Create a routine called 'morning-standup' that runs at 9 AM on weekdays and summarizes what I worked on yesterday."

The agent calls `routine-create` and the scheduler picks it up immediately — no restart needed.

### Fields

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Normalized to a slug (e.g. `morning standup` → `morning-standup`) |
| `prompt` | yes | Plain-language instruction for the LLM |
| `schedule` | yes | 5-field cron expression |
| `enabled` | no | Defaults to `true` |
| `recentActivityMinutes` | no | Look-back window in minutes; auto-inferred from schedule when omitted |

### Cron schedule reference

| Pattern | Meaning |
|---------|---------|
| `0 9 * * 1-5` | Weekdays at 09:00 |
| `0 8 * * *` | Every day at 08:00 |
| `0 17 * * 5` | Fridays at 17:00 |
| `0 9 * * 1` | Mondays at 09:00 |
| `0 9 1 * *` | 1st of each month at 09:00 |

### Automatic look-back window

When `recentActivityMinutes` is not supplied, the server infers a sensible default from the cron schedule:

| Schedule frequency | Inferred window |
|--------------------|-----------------|
| Sub-daily (e.g. hourly) | 60 minutes |
| Daily | 1 440 minutes (24 h) |
| Weekly | 10 080 minutes (7 days) |
| Monthly | 43 200 minutes (30 days) |

You can always override this by setting `recentActivityMinutes` explicitly.

## How execution works

When a scheduled routine fires:

1. **Retrieve evidence** — `FindService` runs a keyword search over recent screen activity using terms derived from your prompt; `RecallService` fetches the session overview for the same window. Both run in parallel.
2. **Assemble context** — Evidence is deduplicated by content and truncated to stay within token budget (~6 000 chars for evidence, ~2 000 chars for session overview).
3. **Call the LLM** — The server sends a structured prompt containing your routine's `prompt` text, the activity overview, and the retrieved evidence fragments to the configured LLM endpoint.
4. **Save the result** — The LLM response is stored as a `RoutineRunRecord` with a `summary` (first line) and `output` (full response). Status is `success`, `failed`, or `skipped` (overlap guard, privacy pause).

## Viewing results

Ask your agent to fetch the history:

> "Show me the last 5 runs of the morning-standup routine."

The agent calls `routine-history` and returns the run records with their generated briefings.

You can also view and manage routines from the [Dashboard](/reference/dashboard) at `http://127.0.0.1:<port>/`.

## Example prompts

```
Summarize what I worked on yesterday for the morning standup.
```

```
List any competitor products or pricing I looked at this week.
```

```
What bugs or error messages did I encounter today?
```

```
Recap the project decisions and open questions from this week.
```

## Privacy

Routines retrieve screen content and send it to the configured LLM endpoint. When the privacy guard is paused (`privacy-control` tool), routines refuse to run and log a `skipped` record rather than sending data to the LLM. See [Privacy & Data](/reference/privacy) for details.

## Troubleshooting

**Routine shows `failed` status** — Check the `error` field in the run record. Common causes: LLM endpoint unreachable, invalid API key, or no activity data in the look-back window.

**Output looks like a session table instead of a briefing** — The LLM is not configured. Add the `llm` block to `config.yaml` and restart.

**Routine never fires** — Verify `routines.enabled: true` in config, and confirm the service restarted after the config change. Check `npm run service:logs` for scheduler startup messages.
