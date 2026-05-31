/**
 * `RemoteLlmSummaryProvider` — calls an OpenAI-compatible
 * `chat/completions` endpoint to summarise a single session
 * (work-activity-analysis task 7.3, design §6.3).
 *
 * The provider is the **opt-in** alternative to the deterministic
 * template provider (task 7.2). It is selected when
 * `analysis.summary.provider === 'remote-llm'` AND `llm.base_url` /
 * `llm.api_key` are populated. When the user keeps the default
 * `template`, this file's code path MUST NEVER be reached and MUST
 * NEVER make outbound HTTP — that invariant is enforced by the
 * registry (task 7.4) and exercised by both the unit tests in this
 * task and W19 (`No_Outbound_When_Default`).
 *
 * The `generate` method honours design §6.3's exact contract:
 *
 *   - **Never throws** on a recoverable error (network failure,
 *     non-2xx, malformed JSON, timeout) — every failure path is
 *     converted into a `SummaryProviderResult` with `kind: 'error'`
 *     and a closed `code` enum, which is W18 (`Graceful_Degradation`)
 *     wired to a single switch statement at the worker layer.
 *   - Reports `'NOT_CONFIGURED'` when `baseUrl` or `apiKey` is empty
 *     **without** firing a request — also W19's mechanism so a
 *     misconfigured `remote-llm` setting never leaks credentials or
 *     traffic.
 *   - Aborts via `AbortController` after `timeoutMs` (default
 *     30_000) so a hung remote endpoint cannot block `recall`
 *     callers indefinitely. The abort is reliable: the timer is
 *     cleared on both success and failure, and the abort branch is
 *     identified by `error.name === 'AbortError'` (the WHATWG
 *     standard for `fetch + AbortController`).
 *   - Builds the OpenAI-compatible payload exactly as design §6.3
 *     specifies: `model`, `messages: [{role:system,...},{role:user,...}]`,
 *     `temperature: 0`, `max_tokens: 200`. The system prompt is
 *     verbatim from the design doc — Chinese-language summaries with
 *     a "证据不足" fallback clause keeping the model honest.
 *
 * Implementation notes:
 *
 *   - URL composition: design §6.3 says "调用 `chat/completions`",
 *     and we compose `${baseUrl}/chat/completions` while collapsing
 *     any trailing slash on `baseUrl` to avoid `https://api/v1//chat/completions`.
 *     This matches what every OpenAI-compatible server (DashScope,
 *     LM Studio, Ollama's openai endpoint, vLLM) expects.
 *   - The `fetch` global is referenced as `globalThis.fetch` so unit
 *     tests can stub it with `vi.stubGlobal('fetch', mock)` — the
 *     pattern already used in `tests/integration/onboard-config.test.ts`.
 *   - Latency is wall-clock from the moment the request is dispatched
 *     to the moment a response (or abort) is observed; the
 *     observability layer (R8.3 `lastLatencyMs`) reads this value off
 *     the success branch only — failure paths do not surface latency
 *     because they are not "endpoint healthy" measurements.
 *   - `parseAssistantContent` returns `null` rather than throwing so
 *     a malformed response routes cleanly to the `'PARSE_FAILED'`
 *     branch. JSON shapes from non-OpenAI-compatible servers (or
 *     locally-run wrappers that drop `choices`) are common enough
 *     that this is the more defensive choice.
 *
 * **Validates: Requirements 6.2, 6.7**
 */

import type {
  SummaryProvider,
  SummaryProviderInput,
  SummaryProviderResult
} from './types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Construction-time configuration for the remote provider. Mirrors
 * design §6.3 verbatim. The fields are kept narrow on purpose — any
 * routing logic ("is this configured?", "should we fall back?")
 * lives at the registry layer (task 7.4) so the provider stays a
 * single-responsibility wrapper around `fetch`.
 *
 *   - `baseUrl`   — OpenAI-compatible API root, with or without a
 *     trailing slash. The `chat/completions` path is appended in
 *     {@link RemoteLlmSummaryProvider#urlFor}.
 *   - `apiKey`    — Bearer token sent in the `Authorization` header.
 *     Empty / undefined values trigger `NOT_CONFIGURED` before any
 *     network I/O.
 *   - `model`     — Model identifier passed verbatim in the request
 *     body. The registry (task 7.4) defaults this to
 *     `'deepseek-chat'` when `llm.model` is not set, so this provider
 *     does not duplicate the default.
 *   - `timeoutMs` — optional wall-clock timeout for the whole
 *     request lifecycle. Defaults to 30 seconds (design §6.3).
 */
export interface RemoteLlmSummaryProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * `RemoteLlmSummaryProvider`: design §6.3.
 *
 * Marked `readonly kind = 'remote-llm'` so observability can branch
 * on the provider identity without `instanceof` checks (`internal-status.providers.summary.kind`,
 * R8.3).
 */
export class RemoteLlmSummaryProvider implements SummaryProvider {
  readonly kind = 'remote-llm' as const;

  constructor(private readonly config: RemoteLlmSummaryProviderConfig) {}

  /**
   * Generate a summary by calling the configured OpenAI-compatible
   * `chat/completions` endpoint. Every failure path is captured and
   * returned as a structured error — the method never throws on a
   * recoverable error. See the closed-enum branches in the
   * implementation for the exact mapping.
   */
  async generate(input: SummaryProviderInput): Promise<SummaryProviderResult> {
    // ---- guard: NOT_CONFIGURED -----------------------------------------
    // Empty base URL or API key → no outbound. This branch is the
    // mechanical floor of W19 (`No_Outbound_When_Default`) for the
    // case where the user *did* select `remote-llm` but never wired
    // up credentials — the surrounding registry would normally hand
    // back the template provider, but the defensive check here
    // protects direct call sites (e.g. integration tests) from
    // leaking traffic to a half-configured endpoint.
    if (!this.config.baseUrl || !this.config.apiKey) {
      return {
        kind: 'error',
        error: {
          code: 'NOT_CONFIGURED',
          message: 'llm.base_url 或 llm.api_key 未配置'
        }
      };
    }

    const start = Date.now();
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // The timer is allocated lazily inside the try block so a
    // theoretical host-API throw (`new AbortController()` /
    // `setTimeout` failing) still resolves with a structured error
    // envelope rather than escaping. The `finally` clause clears
    // the timer on every path including the abort branch — leaving
    // it dangling slows tests by keeping the event loop alive.
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);

      // We intentionally read `globalThis.fetch` rather than the
      // module-level `fetch` global so vitest's `vi.stubGlobal('fetch', …)`
      // takes effect during tests. Node ≥ 18 ships `fetch` on
      // `globalThis`; the project's `engines.node = ">=22"` confirms
      // we never need a polyfill.
      const response = await globalThis.fetch(this.urlFor('chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.buildPayload(input)),
        signal: controller.signal
      });

      // Non-2xx → PROVIDER_UNAVAILABLE. We do not try to parse the
      // body for an OpenAI-style error envelope — the worker layer
      // only needs the closed enum to decide on the fallback path,
      // and the HTTP status code is the most diagnostic single
      // datum to surface in logs.
      if (!response.ok) {
        return {
          kind: 'error',
          error: {
            code: 'PROVIDER_UNAVAILABLE',
            message: `HTTP ${response.status}`
          }
        };
      }

      // JSON parsing is its own potential failure source. We treat a
      // throw here as PARSE_FAILED rather than PROVIDER_UNAVAILABLE
      // because the endpoint *did* respond — it just gave us
      // something we cannot consume. This separation lets
      // observability distinguish "remote LLM down" from "remote LLM
      // returning malformed payloads".
      //
      // Edge case: if the abort timer fires *after* headers arrive but
      // *before* the body is fully consumed, `response.json()` rejects
      // with an `AbortError`. Without the explicit name check below
      // that would be misclassified as `PARSE_FAILED`, when in fact
      // it is the timeout firing — design §6.3 maps `AbortError` to
      // `TIMEOUT` regardless of which fetch stage observes it.
      let json: unknown;
      try {
        json = await response.json();
      } catch (jsonError) {
        const name = (jsonError as { name?: string } | null)?.name;
        if (name === 'AbortError') {
          const message =
            (jsonError as { message?: string } | null)?.message ?? 'fetch failed';
          return {
            kind: 'error',
            error: { code: 'TIMEOUT', message }
          };
        }
        return {
          kind: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: `response JSON parse failed: ${
              (jsonError as Error)?.message ?? 'unknown'
            }`
          }
        };
      }

      const text = this.parseAssistantContent(json);
      if (text === null) {
        return {
          kind: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: 'response 缺少 choices[0].message.content'
          }
        };
      }

      return { kind: 'ok', text, latencyMs: Date.now() - start };
    } catch (error) {
      // The two cases we care about:
      //   1. AbortController fired → timeout. The WHATWG fetch spec
      //      surfaces an `AbortError` (DOMException-shaped, with
      //      `name === 'AbortError'`).
      //   2. Anything else (DNS failure, TLS failure, ECONNRESET,
      //      etc.) → PROVIDER_UNAVAILABLE.
      //
      // Some runtimes throw plain strings or non-Error values from
      // failed fetch calls (the embedding-service tests exercise
      // this exact pattern). We protect against that with optional
      // chaining on `.name` and fall back to the generic message
      // string.
      const name = (error as { name?: string } | null)?.name;
      const code = name === 'AbortError' ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE';
      const message =
        (error as { message?: string } | null)?.message ?? 'fetch failed';
      return {
        kind: 'error',
        error: { code, message }
      };
    } finally {
      // Always clear the timeout — both happy and error paths leave
      // the timer dangling otherwise, which leaks Node `Timeout`
      // handles and slows tests. Guarded with a presence check
      // because the timer is allocated lazily inside the try block.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // ---- helpers ---------------------------------------------------------

  /**
   * Compose `${baseUrl}/${path}` while collapsing any trailing
   * slashes on `baseUrl` and any leading slashes on `path`. This
   * keeps the URL literally `https://api/v1/chat/completions` even
   * if a user pasted `https://api/v1/` in `config.yaml`.
   */
  private urlFor(path: string): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const tail = path.replace(/^\/+/, '');
    return `${base}/${tail}`;
  }

  /**
   * The standard OpenAI-compatible header set: bearer auth +
   * JSON content type. We intentionally do not set `Accept` — most
   * servers default to JSON, and pinning it has historically
   * tripped up legacy proxies (the OpenAI SDK does not pin it
   * either).
   */
  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`
    };
  }

  /**
   * Build the `chat/completions` request payload exactly as design
   * §6.3 prescribes. The system prompt is verbatim from the design
   * doc to keep the eval golden answers stable across refactors.
   *
   * `temperature: 0` and `max_tokens: 200` are also fixed — the
   * deterministic temperature is what makes the
   * Faithfulness_Evaluation script (task 12.3) reproducible across
   * runs, and 200 tokens fits the "1-2 sentences" guidance the
   * system prompt asks for.
   */
  private buildPayload(input: SummaryProviderInput): {
    model: string;
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    temperature: 0;
    max_tokens: 200;
  } {
    const evidenceJoined = input.evidenceFragments
      .map((fragment) => `- [${fragment.timestamp}] ${fragment.extractedText}`)
      .join('\n');

    const minutes = Math.round(input.activeSeconds / 60);

    return {
      model: this.config.model,
      messages: [
        {
          role: 'system',
          content:
            '你是一个工作日志摘要助手。基于提供的会话证据片段，用 1-2 句中文总结用户在该会话内做了什么。' +
            '仅根据证据陈述事实；如果证据不足以判断具体内容，输出 "证据不足，仅记录会话边界"。'
        },
        {
          role: 'user',
          content:
            `应用：${input.appName}\n窗口：${input.contextLabel}\n` +
            `时间：${input.startedAt} → ${input.endedAt}（活跃 ${minutes} 分钟）\n\n` +
            `证据片段：\n${evidenceJoined}`
        }
      ],
      temperature: 0,
      max_tokens: 200
    };
  }

  /**
   * Pluck `choices[0].message.content` out of an OpenAI-compatible
   * response, returning `null` if any required slot is missing or
   * the wrong type. We accept extra trim-able whitespace from the
   * model (Chinese-language replies frequently come back with a
   * trailing newline) but otherwise return the model's text
   * verbatim.
   *
   * Defensive shape:
   *
   *   - `json` may be any structurally non-conformant value
   *     (`null`, an array, a primitive). Each `&&` guard rejects
   *     such inputs without letting a `TypeError` bubble up.
   *   - `content` is required to be a string; some lookalike
   *     servers return `content: { type, text }` objects. We treat
   *     those as `PARSE_FAILED` by returning `null`.
   */
  private parseAssistantContent(json: unknown): string | null {
    if (!json || typeof json !== 'object') return null;
    const choices = (json as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const first = choices[0];
    if (!first || typeof first !== 'object') return null;
    const message = (first as { message?: unknown }).message;
    if (!message || typeof message !== 'object') return null;
    const content = (message as { content?: unknown }).content;
    if (typeof content !== 'string') return null;
    const trimmed = content.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
}
