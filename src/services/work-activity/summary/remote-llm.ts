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
 *   - Delegates HTTP transport, timeout, and error mapping to
 *     `DefaultLlmClient` — the shared generic wrapper so logic is not
 *     duplicated across providers (Routines v2, future providers).
 *   - Builds the OpenAI-compatible payload exactly as design §6.3
 *     specifies: `model`, `messages: [{role:system,...},{role:user,...}]`,
 *     `temperature: 0`, `max_tokens: 200`. The system prompt is
 *     verbatim from the design doc — Chinese-language summaries with
 *     a "证据不足" fallback clause keeping the model honest.
 *
 * **Validates: Requirements 6.2, 6.7**
 */

import type {
  SummaryProvider,
  SummaryProviderInput,
  SummaryProviderResult,
  SummaryProviderError
} from './types.js';
import { DefaultLlmClient, type LlmClient } from '../../llm/llm-client.js';

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, replacement: 'Bearer [REDACTED]' },
  { pattern: /\bsk-[A-Za-z0-9]{20,}/g, replacement: '[REDACTED_API_KEY]' },
  { pattern: /\bghp_[A-Za-z0-9]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { pattern: /\bgho_[A-Za-z0-9]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { pattern: /\bghu_[A-Za-z0-9]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { pattern: /\bghs_[A-Za-z0-9]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { pattern: /\bghr_[A-Za-z0-9]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { pattern: /\bxoxb-[A-Za-z0-9\-]+/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { pattern: /\bxoxp-[A-Za-z0-9\-]+/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { pattern: /\bAIza[A-Za-z0-9\-_]{35}/g, replacement: '[REDACTED_GOOGLE_KEY]' },
  { pattern: /\bAKIA[A-Z0-9]{16}/g, replacement: '[REDACTED_AWS_KEY]' },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

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

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * `RemoteLlmSummaryProvider`: design §6.3.
 *
 * Marked `readonly kind = 'remote-llm'` so observability can branch
 * on the provider identity without `instanceof` checks (`internal-status.providers.summary.kind`,
 * R8.3).
 *
 * HTTP transport, timeout management, and error mapping are delegated to
 * `DefaultLlmClient`. The provider's responsibility is restricted to
 * building the domain-specific payload (system/user messages, token cap)
 * and mapping the generic `LlmResult` back to `SummaryProviderResult`.
 */
export class RemoteLlmSummaryProvider implements SummaryProvider {
  readonly kind = 'remote-llm' as const;

  private readonly llmClient: LlmClient;

  constructor(private readonly config: RemoteLlmSummaryProviderConfig) {
    this.llmClient = new DefaultLlmClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs
    });
  }

  /**
   * Generate a summary by calling the configured OpenAI-compatible
   * `chat/completions` endpoint via the shared `LlmClient`. Every
   * failure path is captured and returned as a structured error —
   * the method never throws on a recoverable error.
   */
  async generate(input: SummaryProviderInput): Promise<SummaryProviderResult> {
    const payload = this.buildPayload(input);

    const result = await this.llmClient.complete({
      model: payload.model,
      messages: payload.messages,
      temperature: payload.temperature,
      maxTokens: payload.max_tokens
    });

    if (result.kind === 'ok') {
      return { kind: 'ok', text: result.text, latencyMs: result.latencyMs };
    }

    // Map LlmErrorCode → SummaryProviderError code. The string literals are
    // identical across both enums so the cast is safe.
    return {
      kind: 'error',
      error: {
        code: result.error.code as SummaryProviderError['code'],
        message: result.error.message
      }
    };
  }

  // ---- helpers ---------------------------------------------------------

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
      .map((fragment) => `- [${fragment.timestamp}] ${redactSecrets(fragment.extractedText)}`)
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
}
