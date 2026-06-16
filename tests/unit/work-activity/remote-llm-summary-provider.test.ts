/**
 * Unit tests for `RemoteLlmSummaryProvider` (work-activity-analysis
 * task 7.3, design §6.3).
 *
 * The provider is the **opt-in** path that calls an OpenAI-compatible
 * `chat/completions` endpoint. The tests cover both axes of the
 * contract:
 *
 *   - **Outbound shape** — when fetch *is* called, the URL,
 *     method, headers, and body match design §6.3 verbatim. Body
 *     payload assertions are deep so a future refactor cannot
 *     silently drop the `temperature: 0` / `max_tokens: 200`
 *     determinism knobs.
 *   - **Failure modes** — every recoverable error (missing config,
 *     non-2xx, network throw, AbortError, malformed JSON, missing
 *     `choices[0].message.content`) MUST resolve with
 *     `kind: 'error'` and a closed-enum `code`. None of them MUST
 *     throw, which is W18 (`Graceful_Degradation`) at the unit
 *     level — and W19 (`No_Outbound_When_Default`) is enforced by
 *     the "missing config does not call fetch" test.
 *
 * The fetch global is stubbed via `vi.stubGlobal('fetch', mock)` —
 * the same pattern used in `tests/integration/onboard-config.test.ts`,
 * so the test environment matches what the MCP server sees at
 * runtime.
 *
 * **Validates: Requirements 6.2, 6.7**
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteLlmSummaryProvider } from '../../../src/services/work-activity/summary/remote-llm.js';
import type {
  SummaryProviderInput,
  SummaryProviderResult
} from '../../../src/services/work-activity/summary/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Canonical `SummaryProviderInput` used across the tests. Fields
 * mirror the shape design §6.1 specifies — the only thing the
 * tests exercise on the input is "did the provider faithfully
 * forward these into the payload".
 */
function buildInput(
  overrides: Partial<SummaryProviderInput> = {}
): SummaryProviderInput {
  return {
    kind: 'session',
    sessionId: 'session-1',
    appName: 'Code',
    contextLabel: 'main.ts',
    startedAt: '2026-05-25T10:00:00.000Z',
    endedAt: '2026-05-25T10:30:00.000Z',
    activeSeconds: 1500, // 25 minutes
    evidenceFragments: [
      {
        frameId: 1,
        timestamp: '2026-05-25T10:00:00.000Z',
        extractedText: 'first fragment'
      },
      {
        frameId: 2,
        timestamp: '2026-05-25T10:15:00.000Z',
        extractedText: 'second fragment'
      }
    ],
    ...overrides
  };
}

/**
 * Build a minimal `Response` look-alike for the fetch stub.
 * `Response` from `undici` works too, but constructing it pulls in
 * extra setup the tests do not need; this object satisfies the
 * narrow surface the provider consumes (`ok`, `status`, `json`).
 */
function buildOkResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [
          {
            message: {
              role: 'assistant',
              content
            }
          }
        ]
      };
    }
  } as unknown as Response;
}

function buildHttpErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    async json() {
      return { error: { message: `synthetic ${status}` } };
    }
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Per-test fixture
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// NOT_CONFIGURED + W19 (No_Outbound_When_Default)
// ---------------------------------------------------------------------------

describe('RemoteLlmSummaryProvider — NOT_CONFIGURED', () => {
  it('returns NOT_CONFIGURED error without calling fetch when baseUrl is empty', async () => {
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: '',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result).toEqual<SummaryProviderResult>({
      kind: 'error',
      error: {
        code: 'NOT_CONFIGURED',
        message: 'llm baseUrl or apiKey is not configured'
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns NOT_CONFIGURED error without calling fetch when apiKey is empty', async () => {
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('NOT_CONFIGURED');
    }
    // The "no outbound when not configured" guarantee is the
    // mechanical floor of W19 for the half-configured remote-llm
    // case.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Outbound shape (HTTP 200 path) + W17-adjacent payload determinism
// ---------------------------------------------------------------------------

describe('RemoteLlmSummaryProvider — outbound request shape', () => {
  it('POSTs to {baseUrl}/chat/completions with bearer auth and OpenAI-compatible body', async () => {
    fetchMock.mockResolvedValueOnce(buildOkResponse('在 Code 中工作约 25 分钟。'));
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      {
        method: string;
        headers: Record<string, string>;
        body: string;
        signal?: AbortSignal;
      }
    ];

    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.signal).toBeDefined();

    const body = JSON.parse(init.body) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature: number;
      max_tokens: number;
    };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(200);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');

    // System prompt: verbatim from design §6.3 — exact-equality
    // assertion so a refactor cannot silently drift the prompt and
    // break the Faithfulness_Evaluation goldens (task 12.3).
    expect(body.messages[0].content).toBe(
      '你是一个工作日志摘要助手。基于提供的会话证据片段，用 1-2 句中文总结用户在该会话内做了什么。' +
        '仅根据证据陈述事实；如果证据不足以判断具体内容，输出 "证据不足，仅记录会话边界"。'
    );

    // User message must reference the structured input fields
    // (app, context, time window, minute count, evidence list).
    const userContent = body.messages[1].content;
    expect(userContent).toContain('应用：Code');
    expect(userContent).toContain('窗口：main.ts');
    expect(userContent).toContain('2026-05-25T10:00:00.000Z → 2026-05-25T10:30:00.000Z');
    expect(userContent).toContain('活跃 25 分钟');
    expect(userContent).toContain('first fragment');
    expect(userContent).toContain('second fragment');
  });

  it('collapses trailing slash on baseUrl when composing the URL', async () => {
    fetchMock.mockResolvedValueOnce(buildOkResponse('ok'));
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    await provider.generate(buildInput());

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('rounds activeSeconds to whole minutes in the user message', async () => {
    fetchMock.mockResolvedValueOnce(buildOkResponse('ok'));
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    // 89 seconds → Math.round(89/60) = 1 minute
    await provider.generate(buildInput({ activeSeconds: 89 }));

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[1].content).toContain('活跃 1 分钟');
  });
});

// ---------------------------------------------------------------------------
// HTTP 200 happy path + latencyMs
// ---------------------------------------------------------------------------

describe('RemoteLlmSummaryProvider — happy path', () => {
  it('returns ok with the assistant content and a non-negative latencyMs', async () => {
    fetchMock.mockResolvedValueOnce(buildOkResponse('在 Code 中工作约 25 分钟。'));
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.text).toBe('在 Code 中工作约 25 分钟。');
      // Date.now() arithmetic always yields >= 0 in test envs;
      // a negative value would mean a timer regression.
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('trims trailing whitespace/newlines from the assistant content', async () => {
    fetchMock.mockResolvedValueOnce(buildOkResponse('  trimmed  \n'));
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.text).toBe('trimmed');
    }
  });
});

// ---------------------------------------------------------------------------
// PROVIDER_UNAVAILABLE — non-2xx and network throw
// ---------------------------------------------------------------------------

describe('RemoteLlmSummaryProvider — PROVIDER_UNAVAILABLE (W18 / R6.7)', () => {
  it('returns PROVIDER_UNAVAILABLE on HTTP 500 without throwing', async () => {
    fetchMock.mockResolvedValueOnce(buildHttpErrorResponse(500));
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(result.error.message).toBe('HTTP 500');
    }
  });

  it('returns PROVIDER_UNAVAILABLE on HTTP 4xx without throwing', async () => {
    fetchMock.mockResolvedValueOnce(buildHttpErrorResponse(401));
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(result.error.message).toBe('HTTP 401');
    }
  });

  it('returns PROVIDER_UNAVAILABLE when fetch rejects with a network Error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(result.error.message).toBe('connection refused');
    }
  });

  it('does not crash when fetch rejects with a non-Error throwable', async () => {
    // Some HTTP libraries reject with strings or DOMException-shaped
    // values. The provider must coerce those into the error envelope
    // rather than letting the exception propagate.
    fetchMock.mockRejectedValueOnce('boom');
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('PROVIDER_UNAVAILABLE');
      // Default fallback message because a string throwable has no
      // `.message`.
      expect(result.error.message).toBe('fetch failed');
    }
  });
});

// ---------------------------------------------------------------------------
// TIMEOUT (AbortError)
// ---------------------------------------------------------------------------

describe('RemoteLlmSummaryProvider — TIMEOUT', () => {
  it('returns TIMEOUT when fetch rejects with AbortError', async () => {
    // Simulate an AbortController-triggered abort by rejecting the
    // fetch with a DOMException-shaped object. We cannot simply
    // throw from the mock because the production code's
    // `setTimeout(controller.abort)` will not fire on a mock that
    // resolves synchronously — but the *effect* is identical: an
    // AbortError reaches the catch block.
    const abortError = Object.assign(new Error('The operation was aborted.'), {
      name: 'AbortError'
    });
    fetchMock.mockRejectedValueOnce(abortError);

    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      timeoutMs: 50
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('TIMEOUT');
    }
  });

  it('actually wires the AbortSignal into fetch', async () => {
    fetchMock.mockResolvedValueOnce(buildOkResponse('ok'));
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      timeoutMs: 1000
    });

    await provider.generate(buildInput());

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { signal?: AbortSignal }
    ];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // The signal MUST not be already aborted on a fresh request.
    expect(init.signal!.aborted).toBe(false);
  });

  it('actually aborts the AbortSignal after timeoutMs and clears its timer', async () => {
    // Fake-timer-driven proof that the production timer (a) actually
    // aborts the signal, and (b) is cleared by the time `generate`
    // resolves. Without this, the previous AbortError tests only
    // verified the catch block — not that anything in production
    // would ever produce an AbortError in real usage.
    vi.useFakeTimers();

    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          capturedSignal = init.signal;
          // Reject with an AbortError when the consumer aborts —
          // mirrors what `node:undici` does for a real `fetch`.
          init.signal?.addEventListener('abort', () => {
            reject(
              Object.assign(new Error('The operation was aborted.'), {
                name: 'AbortError'
              })
            );
          });
        })
    );

    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      timeoutMs: 50
    });

    const generatePromise = provider.generate(buildInput());

    // Advance past the timeout. The provider's setTimeout fires,
    // which calls `controller.abort()`, which rejects the fetch
    // mock with an AbortError, which the catch block maps to
    // `TIMEOUT`.
    await vi.advanceTimersByTimeAsync(60);

    const result = await generatePromise;

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('TIMEOUT');
    }
    expect(capturedSignal?.aborted).toBe(true);
    // The abort timer must be cleared by the time the call resolves
    // (production uses `try/finally`); otherwise we leak handles.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns TIMEOUT when AbortError fires during response.json() (after headers)', async () => {
    // Edge case from design §6.3: the timer can fire after headers
    // arrive but before the body is consumed. `response.json()` then
    // rejects with `AbortError` from inside the body-stream reader.
    // The provider MUST classify that as `TIMEOUT`, not `PARSE_FAILED` —
    // it is still the timeout firing.
    const abortError = Object.assign(new Error('aborted during body read'), {
      name: 'AbortError'
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      async json() {
        throw abortError;
      }
    } as unknown as Response);

    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('TIMEOUT');
      expect(result.error.message).toBe('aborted during body read');
    }
  });
});

// ---------------------------------------------------------------------------
// PARSE_FAILED — malformed JSON / missing slots
// ---------------------------------------------------------------------------

describe('RemoteLlmSummaryProvider — PARSE_FAILED', () => {
  it('returns PARSE_FAILED when the response body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError('Unexpected token');
      }
    } as unknown as Response);

    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('PARSE_FAILED');
    }
  });

  it('returns PARSE_FAILED when choices is missing', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      async json() {
        return { id: 'cmpl-1' };
      }
    } as unknown as Response);

    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('PARSE_FAILED');
    }
  });

  it('returns PARSE_FAILED when choices[0].message.content is missing', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              message: {
                role: 'assistant'
                // no `content` field
              }
            }
          ]
        };
      }
    } as unknown as Response);

    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('PARSE_FAILED');
    }
  });

  it('returns PARSE_FAILED when content is empty after trimming', async () => {
    fetchMock.mockResolvedValueOnce(buildOkResponse('   \n  '));
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('PARSE_FAILED');
    }
  });

  it('returns PARSE_FAILED when content is not a string', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              message: {
                role: 'assistant',
                content: { type: 'text', text: 'wrong shape' }
              }
            }
          ]
        };
      }
    } as unknown as Response);

    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const result = await provider.generate(buildInput());

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.code).toBe('PARSE_FAILED');
    }
  });
});

// ---------------------------------------------------------------------------
// Graceful_Degradation (W18) — never throws
// ---------------------------------------------------------------------------

describe('RemoteLlmSummaryProvider — Graceful_Degradation (W18)', () => {
  it('never throws across every error mode', async () => {
    const provider = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });

    const errorModes: Array<() => void> = [
      () => fetchMock.mockResolvedValueOnce(buildHttpErrorResponse(500)),
      () => fetchMock.mockResolvedValueOnce(buildHttpErrorResponse(401)),
      () => fetchMock.mockRejectedValueOnce(new Error('ECONNRESET')),
      () => fetchMock.mockRejectedValueOnce('weird'),
      () => fetchMock.mockRejectedValueOnce(
        Object.assign(new Error('aborted'), { name: 'AbortError' })
      ),
      () =>
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          async json() {
            throw new SyntaxError('bad json');
          }
        } as unknown as Response),
      () =>
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          async json() {
            return null;
          }
        } as unknown as Response)
    ];

    for (const setupMode of errorModes) {
      fetchMock.mockReset();
      setupMode();

      // The promise MUST NOT reject — every error path is captured
      // in the result envelope.
      const result = await provider.generate(buildInput());
      expect(result.kind).toBe('error');
    }
  });
});
