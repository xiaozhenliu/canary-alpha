/**
 * `LlmClient` — a shared, generic wrapper around OpenAI-compatible
 * `chat/completions` HTTP calls.
 *
 * This module is the single place in the codebase that knows how to
 * speak to a `chat/completions` endpoint. Domain-specific providers
 * (e.g. `RemoteLlmSummaryProvider`, the upcoming Routines v2 executor)
 * delegate raw HTTP work here so the error-handling, timeout, and
 * redaction logic is not duplicated.
 *
 * Design contract (mirrors the patterns established in remote-llm.ts):
 *
 *   - **Never throws** on a recoverable error — every failure path is
 *     returned as an `LlmResult` with `kind: 'error'` and a closed
 *     `LlmErrorCode` enum.
 *   - Reports `'NOT_CONFIGURED'` when `baseUrl` or `apiKey` is empty
 *     before any network I/O is attempted.
 *   - Aborts via `AbortController` after `timeoutMs` (default 30 000 ms).
 *   - Timer is always cleared in the `finally` block.
 *   - Uses `globalThis.fetch` so tests can stub it with
 *     `vi.stubGlobal('fetch', mock)`.
 *   - URL composition strips trailing slashes from `baseUrl`.
 *   - Default `max_tokens` is 4096 (generic client; domain providers
 *     that need a smaller cap pass it via `LlmCompleteOptions`).
 *   - Error messages are sanitised through `redactSecrets` imported
 *     from the canonical source in `remote-llm.ts`.
 */

import { redactSecrets } from '../work-activity/summary/remote-llm.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Closed enum of failure reasons returned by `LlmClient.complete()`.
 *
 *   - `NOT_CONFIGURED` — `baseUrl` or `apiKey` is empty; no request fired.
 *   - `TIMEOUT`        — `AbortController` fired before a full response was received.
 *   - `PROVIDER_UNAVAILABLE` — non-2xx HTTP status or a network-level error
 *     (DNS failure, ECONNRESET, TLS handshake failure, etc.).
 *   - `PARSE_FAILED`   — the endpoint responded with 2xx but the body could
 *     not be parsed as JSON or did not contain `choices[0].message.content`.
 */
export type LlmErrorCode =
  | 'NOT_CONFIGURED'
  | 'TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PARSE_FAILED';

/** Structured error payload returned inside an `LlmResult` error branch. */
export interface LlmError {
  code: LlmErrorCode;
  /** Human-readable detail; secrets are redacted before this value is set. */
  message: string;
}

/**
 * Discriminated union returned by `LlmClient.complete()`.
 *
 * Callers must narrow by `kind` before accessing the branch-specific
 * fields — the pattern mirrors `SummaryProviderResult` in `types.ts`.
 */
export type LlmResult =
  | { kind: 'ok'; text: string; latencyMs: number }
  | { kind: 'error'; error: LlmError };

/** A single message in an OpenAI-compatible `messages` array. */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Options passed to `LlmClient.complete()` per-call. */
export interface LlmCompleteOptions {
  /** OpenAI model identifier, e.g. `'deepseek-chat'` or `'gpt-4o'`. */
  model: string;
  /** The conversation turns to send. Must contain at least one message. */
  messages: LlmMessage[];
  /**
   * Sampling temperature. Defaults to `0` (deterministic).
   * Pass a value between 0 and 2 to control randomness.
   */
  temperature?: number;
  /**
   * Maximum tokens in the completion. Defaults to `4096`.
   * Domain-specific callers may pass a smaller cap if needed.
   */
  maxTokens?: number;
}

/** Interface for the generic LLM client. */
export interface LlmClient {
  /**
   * Call `chat/completions` and return a structured result.
   * This method never throws — all errors are represented as
   * `{ kind: 'error', error: LlmError }`.
   */
  complete(options: LlmCompleteOptions): Promise<LlmResult>;
}

/** Construction-time configuration for `DefaultLlmClient`. */
export interface LlmClientConfig {
  /**
   * OpenAI-compatible API root URL, with or without a trailing slash.
   * The `chat/completions` path is appended automatically.
   * Empty string → `NOT_CONFIGURED` on every call.
   */
  baseUrl: string;
  /**
   * Bearer token sent in the `Authorization` header.
   * Empty string → `NOT_CONFIGURED` on every call.
   */
  apiKey: string;
  /**
   * Wall-clock timeout in milliseconds for the complete request lifecycle.
   * Defaults to 30 000 ms (30 seconds).
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 4_096;
const DEFAULT_TEMPERATURE = 0;

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Extract `choices[0].message.content` from an OpenAI-compatible response
 * body. Returns `null` if any required field is absent or the wrong type
 * so that callers can route cleanly to `PARSE_FAILED` without catching
 * a `TypeError`.
 *
 * Handles edge cases:
 *   - `json` being `null`, an array, or a primitive.
 *   - `choices` being absent or empty.
 *   - `content` being a non-string (e.g. a `{ type, text }` object
 *     returned by some local model wrappers).
 *   - Trailing whitespace from the model (trimmed; returns `null` for
 *     empty strings after trimming).
 */
export function parseAssistantContent(json: unknown): string | null {
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

// ---------------------------------------------------------------------------
// DefaultLlmClient
// ---------------------------------------------------------------------------

/**
 * Default implementation of `LlmClient`.
 *
 * Wraps a single OpenAI-compatible `chat/completions` endpoint.
 * All error paths return structured `LlmResult` values — the method
 * never propagates exceptions to callers.
 */
export class DefaultLlmClient implements LlmClient {
  constructor(private readonly config: LlmClientConfig) {}

  /**
   * POST to `<baseUrl>/chat/completions` and return a structured result.
   *
   * Failure mapping:
   *   - Empty `baseUrl` or `apiKey`  → `NOT_CONFIGURED` (no request fired)
   *   - `AbortError` (timeout)       → `TIMEOUT`
   *   - Non-2xx HTTP status          → `PROVIDER_UNAVAILABLE`
   *   - Network-level error          → `PROVIDER_UNAVAILABLE`
   *   - Malformed JSON or missing    → `PARSE_FAILED`
   *     `choices[0].message.content`
   */
  async complete(options: LlmCompleteOptions): Promise<LlmResult> {
    // Guard: NOT_CONFIGURED — no outbound if credentials are missing.
    if (!this.config.baseUrl || !this.config.apiKey) {
      return {
        kind: 'error',
        error: {
          code: 'NOT_CONFIGURED',
          message: 'llm baseUrl or apiKey is not configured'
        }
      };
    }

    const start = Date.now();
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // The timer is allocated inside the try block so the finally clause
    // safely clears it even if AbortController construction were to
    // fail (unlikely, but defensive).
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);

      // Use globalThis.fetch so vi.stubGlobal('fetch', mock) works in tests.
      const response = await globalThis.fetch(this.urlFor('chat/completions'), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildPayload(options)),
        signal: controller.signal
      });

      // Non-2xx: the endpoint is reachable but returned an error status.
      // We do not attempt to parse an OpenAI error envelope — the status
      // code is sufficient for the closed-enum branch.
      if (!response.ok) {
        return {
          kind: 'error',
          error: {
            code: 'PROVIDER_UNAVAILABLE',
            message: redactSecrets(`HTTP ${response.status}`)
          }
        };
      }

      // Parse the response body. A throw here maps to PARSE_FAILED
      // (2xx arrived but body is not valid JSON). The inner AbortError
      // check handles the edge case where the timer fires after headers
      // arrive but before the body is fully streamed.
      let json: unknown;
      try {
        json = await response.json();
      } catch (jsonError) {
        const name = (jsonError as { name?: string } | null)?.name;
        if (name === 'AbortError') {
          const message =
            (jsonError as { message?: string } | null)?.message ?? 'fetch aborted';
          return {
            kind: 'error',
            error: { code: 'TIMEOUT', message: redactSecrets(message) }
          };
        }
        return {
          kind: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: redactSecrets(
              `response JSON parse failed: ${
                (jsonError as Error)?.message ?? 'unknown'
              }`
            )
          }
        };
      }

      // Extract the assistant's reply from the OpenAI-compatible shape.
      const text = parseAssistantContent(json);
      if (text === null) {
        return {
          kind: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: 'response missing choices[0].message.content'
          }
        };
      }

      return { kind: 'ok', text, latencyMs: Date.now() - start };
    } catch (error) {
      // Two cases:
      //   1. AbortController fired → TIMEOUT (WHATWG AbortError, name === 'AbortError').
      //   2. Network-level error (DNS, TLS, ECONNRESET, etc.) → PROVIDER_UNAVAILABLE.
      const name = (error as { name?: string } | null)?.name;
      const code: LlmErrorCode =
        name === 'AbortError' ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE';
      const rawMessage =
        (error as { message?: string } | null)?.message ?? 'fetch failed';
      return {
        kind: 'error',
        error: { code, message: redactSecrets(rawMessage) }
      };
    } finally {
      // Clear the timer on every path — both success and failure — to
      // prevent Node.js from keeping the event loop alive in tests.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // ---- private helpers ----------------------------------------------------

  /**
   * Compose `<baseUrl>/<path>` while collapsing trailing slashes on
   * `baseUrl` and leading slashes on `path`. Prevents the double-slash
   * `https://api/v1//chat/completions` that results from a user pasting
   * a URL with a trailing slash into the config.
   */
  private urlFor(path: string): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const tail = path.replace(/^\/+/, '');
    return `${base}/${tail}`;
  }

  /**
   * Standard OpenAI-compatible request headers: bearer auth + JSON body.
   * `Accept` is intentionally omitted — servers default to JSON, and
   * pinning it has historically caused issues with some proxies.
   */
  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`
    };
  }

  /**
   * Build the `chat/completions` request payload from caller-supplied options.
   * Applies default values for `temperature` and `max_tokens` when not specified.
   */
  private buildPayload(options: LlmCompleteOptions): {
    model: string;
    messages: LlmMessage[];
    temperature: number;
    max_tokens: number;
  } {
    return {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS
    };
  }
}
