import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DefaultLlmClient,
  parseAssistantContent,
  type LlmCompleteOptions
} from '../../../src/services/llm/llm-client.js';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: LlmCompleteOptions = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }]
};

const VALID_CONFIG = {
  baseUrl: 'https://api.example.com',
  apiKey: 'test-api-key'
};

/** Build a minimal fetch stub that returns a successful OpenAI-compatible response. */
function makeSuccessfulFetch(content = 'Hello') {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content } }]
      })
  });
}

// ---------------------------------------------------------------------------
// Test suite: DefaultLlmClient.complete()
// ---------------------------------------------------------------------------

describe('DefaultLlmClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // 1. Successful call
  // -------------------------------------------------------------------------
  describe('successful call', () => {
    it('returns kind=ok with text and non-negative latencyMs', async () => {
      vi.stubGlobal('fetch', makeSuccessfulFetch('Hello'));

      const client = new DefaultLlmClient(VALID_CONFIG);
      const result = await client.complete(DEFAULT_OPTIONS);

      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.text).toBe('Hello');
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('calls fetch exactly once with the expected URL and method', async () => {
      const mockFetch = makeSuccessfulFetch();
      vi.stubGlobal('fetch', mockFetch);

      const client = new DefaultLlmClient(VALID_CONFIG);
      await client.complete(DEFAULT_OPTIONS);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/chat/completions');
      expect(init.method).toBe('POST');
    });
  });

  // -------------------------------------------------------------------------
  // 2. NOT_CONFIGURED when baseUrl is empty
  // -------------------------------------------------------------------------
  describe('NOT_CONFIGURED when baseUrl is empty', () => {
    it('returns NOT_CONFIGURED error without calling fetch', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const client = new DefaultLlmClient({ baseUrl: '', apiKey: 'some-key' });
      const result = await client.complete(DEFAULT_OPTIONS);

      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error.code).toBe('NOT_CONFIGURED');
      }
      // fetch must NOT be called when not configured
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3. NOT_CONFIGURED when apiKey is empty
  // -------------------------------------------------------------------------
  describe('NOT_CONFIGURED when apiKey is empty', () => {
    it('returns NOT_CONFIGURED error without calling fetch', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const client = new DefaultLlmClient({ baseUrl: 'https://api.example.com', apiKey: '' });
      const result = await client.complete(DEFAULT_OPTIONS);

      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error.code).toBe('NOT_CONFIGURED');
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 4. TIMEOUT via AbortController
  // -------------------------------------------------------------------------
  describe('TIMEOUT via AbortController', () => {
    it('returns TIMEOUT when fetch hangs past timeoutMs', async () => {
      // Fetch never resolves; AbortController will fire after 50ms and
      // cause fetch to throw an AbortError.
      const mockFetch = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise<never>((_resolve, reject) => {
            // Listen for the abort signal so the promise rejects with AbortError.
            const signal = init?.signal as AbortSignal | undefined;
            if (signal) {
              signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                reject(err);
              });
            }
          })
      );
      vi.stubGlobal('fetch', mockFetch);

      const client = new DefaultLlmClient({ ...VALID_CONFIG, timeoutMs: 50 });
      const result = await client.complete(DEFAULT_OPTIONS);

      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error.code).toBe('TIMEOUT');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. PROVIDER_UNAVAILABLE on non-2xx HTTP
  // -------------------------------------------------------------------------
  describe('PROVIDER_UNAVAILABLE on non-2xx HTTP', () => {
    it('returns PROVIDER_UNAVAILABLE with message containing HTTP 500', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 500 })
      );

      const client = new DefaultLlmClient(VALID_CONFIG);
      const result = await client.complete(DEFAULT_OPTIONS);

      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error.code).toBe('PROVIDER_UNAVAILABLE');
        expect(result.error.message).toContain('HTTP 500');
      }
    });

    it('returns PROVIDER_UNAVAILABLE with message containing HTTP 429', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 429 })
      );

      const client = new DefaultLlmClient(VALID_CONFIG);
      const result = await client.complete(DEFAULT_OPTIONS);

      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error.code).toBe('PROVIDER_UNAVAILABLE');
        expect(result.error.message).toContain('HTTP 429');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 6. PARSE_FAILED on malformed response body
  // -------------------------------------------------------------------------
  describe('PARSE_FAILED on malformed response body', () => {
    it('returns PARSE_FAILED when response body has no choices field', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [] }) // no `choices` key
        })
      );

      const client = new DefaultLlmClient(VALID_CONFIG);
      const result = await client.complete(DEFAULT_OPTIONS);

      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error.code).toBe('PARSE_FAILED');
      }
    });

    it('returns PARSE_FAILED when choices array is empty', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ choices: [] })
        })
      );

      const client = new DefaultLlmClient(VALID_CONFIG);
      const result = await client.complete(DEFAULT_OPTIONS);

      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error.code).toBe('PARSE_FAILED');
      }
    });

    it('returns PARSE_FAILED when response.json() throws a SyntaxError', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected token'))
        })
      );

      const client = new DefaultLlmClient(VALID_CONFIG);
      const result = await client.complete(DEFAULT_OPTIONS);

      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error.code).toBe('PARSE_FAILED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 7. API-key redaction in error messages
  // -------------------------------------------------------------------------
  describe('API-key redaction in error messages', () => {
    it('redacts sk- API key pattern from network error messages', async () => {
      // The raw error message embeds what looks like an API key.
      const rawKey = 'sk-abcdefghij0123456789ABCD'; // 20+ chars after sk-
      const mockFetch = vi.fn().mockRejectedValue(
        new Error(`unauthorized: token=${rawKey}`)
      );
      vi.stubGlobal('fetch', mockFetch);

      const client = new DefaultLlmClient(VALID_CONFIG);
      const result = await client.complete(DEFAULT_OPTIONS);

      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        // The raw key must NOT appear in the message.
        expect(result.error.message).not.toContain(rawKey);
        // The placeholder MUST appear.
        expect(result.error.message).toContain('[REDACTED_API_KEY]');
      }
    });

    it('does not redact an API key that is too short (< 20 chars)', async () => {
      // Pattern requires 20+ alphanumeric chars after 'sk-'.
      const shortKey = 'sk-short123';
      const mockFetch = vi.fn().mockRejectedValue(new Error(`token=${shortKey}`));
      vi.stubGlobal('fetch', mockFetch);

      const client = new DefaultLlmClient(VALID_CONFIG);
      const result = await client.complete(DEFAULT_OPTIONS);

      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        // Short key does not match the redaction pattern, so it stays.
        expect(result.error.message).toContain(shortKey);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Test suite: parseAssistantContent (exported pure function)
// ---------------------------------------------------------------------------

describe('parseAssistantContent', () => {
  it('returns null for null input', () => {
    expect(parseAssistantContent(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseAssistantContent(undefined)).toBeNull();
  });

  it('returns null for a string input', () => {
    expect(parseAssistantContent('just a string')).toBeNull();
  });

  it('returns null for a number input', () => {
    expect(parseAssistantContent(42)).toBeNull();
  });

  it('extracts content from a valid OpenAI response', () => {
    const json = { choices: [{ message: { content: 'Hello' } }] };
    expect(parseAssistantContent(json)).toBe('Hello');
  });

  it('returns null when choices is an empty array', () => {
    const json = { choices: [] };
    expect(parseAssistantContent(json)).toBeNull();
  });

  it('returns null when message has no content field', () => {
    const json = { choices: [{ message: {} }] };
    expect(parseAssistantContent(json)).toBeNull();
  });

  it('returns null when content is whitespace-only', () => {
    const json = { choices: [{ message: { content: '  ' } }] };
    expect(parseAssistantContent(json)).toBeNull();
  });

  it('trims leading/trailing whitespace from valid content', () => {
    const json = { choices: [{ message: { content: '  trimmed  ' } }] };
    expect(parseAssistantContent(json)).toBe('trimmed');
  });

  it('returns null when choices key is absent', () => {
    expect(parseAssistantContent({})).toBeNull();
  });

  it('returns null when choices is not an array', () => {
    expect(parseAssistantContent({ choices: 'not-array' })).toBeNull();
  });

  it('returns null when message.content is a non-string value', () => {
    const json = { choices: [{ message: { content: { type: 'text', text: 'hi' } } }] };
    expect(parseAssistantContent(json)).toBeNull();
  });

  it('returns null when choices[0] has no message', () => {
    const json = { choices: [{}] };
    expect(parseAssistantContent(json)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test suite: Structural check (AC #12)
// Verify that RemoteLlmSummaryProvider imports DefaultLlmClient from llm-client.
// ---------------------------------------------------------------------------

describe('Structural check: RemoteLlmSummaryProvider imports DefaultLlmClient', () => {
  it('remote-llm.ts has an import referencing llm-client', () => {
    // Resolve the path relative to the repository root via import.meta.url.
    // The test file lives at tests/unit/llm/llm-client.test.ts, so
    // three levels up is the repo root.
    const remoteLlmPath = new URL(
      '../../../src/services/work-activity/summary/remote-llm.ts',
      import.meta.url
    ).pathname;

    const source = fs.readFileSync(remoteLlmPath, 'utf8');

    // The import specifier ends with 'llm-client.js' (ESM explicit extension).
    // Match: from '../../llm/llm-client.js'  or  from "./llm/llm-client.js"
    expect(source).toMatch(/from\s+['"].*llm-client(?:\.js)?['"]/);

    // The import must reference DefaultLlmClient by name.
    expect(source).toContain('DefaultLlmClient');
  });
});
