/**
 * Unit tests for normalizeScreenpipeRecord — task 2.5
 * Validates that frame_id → frameId and window_name → windowName are mapped
 * from the Screenpipe API response, and that missing fields degrade to undefined
 * without throwing.
 *
 * Requirements: 1.4, 3.4
 */

import { createServer } from 'node:http';

import { afterAll, describe, expect, it } from 'vitest';

import { createScreenpipeClient } from '../../../src/services/capture/providers/screenpipe/http-client.js';

// ---------------------------------------------------------------------------
// Helpers: spin up a tiny HTTP server that returns a fixed JSON payload
// ---------------------------------------------------------------------------

const cleanup: Array<() => Promise<void>> = [];

afterAll(async () => {
  while (cleanup.length > 0) {
    const stop = cleanup.pop();
    if (stop) await stop();
  }
});

async function startServer(
  payload: unknown | ((requestUrl: URL) => unknown)
): Promise<{ url: string }> {
  const server = createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.end(JSON.stringify(typeof payload === 'function' ? payload(requestUrl) : payload));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
  );

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { url: `http://127.0.0.1:${address.port}` };
}

// ---------------------------------------------------------------------------
// Tests: flat-object response shape (id / text / timestamp at top level)
// ---------------------------------------------------------------------------

describe('normalizeScreenpipeRecord — flat response shape', () => {
  it('maps frame_id and window_name from a flat response item', async () => {
    const { url } = await startServer({
      data: [
        {
          id: 'elem:42',
          text: 'hello world',
          timestamp: '2026-01-01T00:00:00.000Z',
          app_name: 'Code',
          window_name: 'design.ts — computer-history-mcp',
          frame_id: 7
        }
      ]
    });

    const client = createScreenpipeClient(url);
    const records = await client.search({ query: 'hello' });

    expect(records).toHaveLength(1);
    expect(records[0].frameId).toBe(7);
    expect(records[0].windowName).toBe('design.ts — computer-history-mcp');
  });

  it('preserves a complete accessibility tree when the response includes it', async () => {
    const tree = {
      role: 'AXWindow',
      title: 'Slack',
      children: [{ role: 'AXHeading', title: '#incident' }]
    };
    const { url } = await startServer({
      data: [
        {
          id: 'elem:43',
          text: 'message body',
          timestamp: '2026-01-01T00:00:00.000Z',
          app_name: 'Slack',
          window_name: 'Slack',
          frame_id: 8,
          accessibility_tree_json: tree
        }
      ]
    });

    const client = createScreenpipeClient(url);
    const records = await client.search({});

    expect(records).toHaveLength(1);
    expect(records[0].accessibilityTreeJson).toBe(JSON.stringify(tree));
  });

  it('degrades to undefined when frame_id is absent — no error thrown', async () => {
    const { url } = await startServer({
      data: [
        {
          id: 'elem:99',
          text: 'no frame id here',
          timestamp: '2026-01-01T00:00:00.000Z',
          app_name: 'Terminal'
          // frame_id intentionally omitted
        }
      ]
    });

    const client = createScreenpipeClient(url);
    const records = await client.search({});

    expect(records).toHaveLength(1);
    expect(records[0].frameId).toBeUndefined();
  });

  it('degrades to undefined when window_name is absent — no error thrown', async () => {
    const { url } = await startServer({
      data: [
        {
          id: 'elem:100',
          text: 'no window name here',
          timestamp: '2026-01-01T00:00:00.000Z',
          app_name: 'Terminal'
          // window_name intentionally omitted
        }
      ]
    });

    const client = createScreenpipeClient(url);
    const records = await client.search({});

    expect(records).toHaveLength(1);
    expect(records[0].windowName).toBeUndefined();
  });

  it('handles both fields absent simultaneously without throwing', async () => {
    const { url } = await startServer({
      data: [
        {
          id: 'elem:101',
          text: 'minimal record',
          timestamp: '2026-01-01T00:00:00.000Z'
        }
      ]
    });

    const client = createScreenpipeClient(url);
    const records = await client.search({});

    expect(records).toHaveLength(1);
    expect(records[0].frameId).toBeUndefined();
    expect(records[0].windowName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: nested content response shape (type: 'OCR' with content object)
// ---------------------------------------------------------------------------

describe('normalizeScreenpipeRecord — nested OCR content shape', () => {
  it('maps frame_id and window_name from nested content', async () => {
    const { url } = await startServer([
      {
        type: 'OCR',
        content: {
          frame_id: 55,
          offset_index: 0,
          text: 'ocr text',
          timestamp: '2026-01-02T00:00:00.000Z',
          app_name: 'Google Chrome',
          window_name: 'Linear — LIN-123'
        }
      }
    ]);

    const client = createScreenpipeClient(url);
    const records = await client.search({});

    expect(records).toHaveLength(1);
    expect(records[0].frameId).toBe(55);
    expect(records[0].windowName).toBe('Linear — LIN-123');
    // id should be derived from frame_id
    expect(records[0].id).toBe('frame:55:0');
  });

  it('degrades to undefined when nested content lacks frame_id and window_name', async () => {
    const { url } = await startServer([
      {
        type: 'OCR',
        content: {
          // frame_id and window_name intentionally omitted
          offset_index: 0,
          text: 'old fixture text',
          timestamp: '2026-01-02T00:00:00.000Z',
          app_name: 'Terminal'
        }
      }
    ]);

    const client = createScreenpipeClient(url);
    const records = await client.search({});

    expect(records).toHaveLength(1);
    expect(records[0].frameId).toBeUndefined();
    expect(records[0].windowName).toBeUndefined();
    // id falls back to 'frame:unknown:0'
    expect(records[0].id).toBe('frame:unknown:0');
  });
});

describe('normalizeScreenpipeRecord — AX tree-only content shape', () => {
  it('keeps an accessibility record when the complete tree has no flattened text', async () => {
    const tree = {
      role: 'AXWindow',
      title: 'Slack',
      children: [{ role: 'AXHeading', title: '#incident' }]
    };
    const { url } = await startServer([
      {
        type: 'ACCESSIBILITY',
        content: {
          frame_id: 88,
          offset_index: 0,
          timestamp: '2026-01-04T00:00:00.000Z',
          app_name: 'Slack',
          accessibility_tree_json: tree
        }
      }
    ]);

    const client = createScreenpipeClient(url);
    const records = await client.search({});

    expect(records).toHaveLength(1);
    expect(records[0].text).toBe('');
    expect(records[0].frameId).toBe(88);
    expect(records[0].accessibilityTreeJson).toBe(JSON.stringify(tree));
  });

  it('keeps OCR when an empty AX placeholder would otherwise win by frame id', async () => {
    const { url } = await startServer((requestUrl: URL) => {
      if (requestUrl.searchParams.get('content_type') === 'accessibility') {
        return [{
          type: 'ACCESSIBILITY',
          content: {
            frame_id: 89,
            offset_index: 0,
            timestamp: '2026-01-04T00:00:00.000Z',
            app_name: 'Slack',
            text: '',
            accessibility_tree_json: {}
          }
        }];
      }
      return [{
        type: 'OCR',
        content: {
          frame_id: 89,
          offset_index: 0,
          timestamp: '2026-01-04T00:00:00.000Z',
          app_name: 'Slack',
          text: 'OCR body'
        }
      }];
    });

    const client = createScreenpipeClient(url);
    const records = await client.search({});

    expect(records).toHaveLength(1);
    expect(records[0].text).toBe('OCR body');
    expect(records[0].sourceTypes).toEqual(['ocr']);
  });
});

// ---------------------------------------------------------------------------
// Tests: wrong-type field values degrade gracefully (type-safety boundary)
// ---------------------------------------------------------------------------

describe('normalizeScreenpipeRecord — wrong-type field values', () => {
  it('degrades frameId to undefined when frame_id is a string in flat shape', async () => {
    const { url } = await startServer({
      data: [
        {
          id: 'elem:200',
          text: 'text',
          timestamp: '2026-01-03T00:00:00.000Z',
          frame_id: '7' // string instead of number
        }
      ]
    });

    const client = createScreenpipeClient(url);
    const records = await client.search({});

    expect(records).toHaveLength(1);
    expect(records[0].frameId).toBeUndefined();
  });

  it('degrades windowName to undefined when window_name is a number in flat shape', async () => {
    const { url } = await startServer({
      data: [
        {
          id: 'elem:201',
          text: 'text',
          timestamp: '2026-01-03T00:00:00.000Z',
          window_name: 123 // number instead of string
        }
      ]
    });

    const client = createScreenpipeClient(url);
    const records = await client.search({});

    expect(records).toHaveLength(1);
    expect(records[0].windowName).toBeUndefined();
  });

  it('degrades frameId to undefined when nested content frame_id is a string', async () => {
    const { url } = await startServer([
      {
        type: 'OCR',
        content: {
          frame_id: '55', // string instead of number
          offset_index: 0,
          text: 'ocr text',
          timestamp: '2026-01-03T00:00:00.000Z',
          app_name: 'Terminal'
        }
      }
    ]);

    const client = createScreenpipeClient(url);
    const records = await client.search({});

    expect(records).toHaveLength(1);
    expect(records[0].frameId).toBeUndefined();
    // id falls back to 'frame:unknown:0' because frame_id is not a number
    expect(records[0].id).toBe('frame:unknown:0');
  });

  it('degrades windowName to undefined when nested content window_name is a number', async () => {
    const { url } = await startServer([
      {
        type: 'OCR',
        content: {
          frame_id: 77,
          offset_index: 0,
          text: 'ocr text',
          timestamp: '2026-01-03T00:00:00.000Z',
          app_name: 'Terminal',
          window_name: 42 // number instead of string
        }
      }
    ]);

    const client = createScreenpipeClient(url);
    const records = await client.search({});

    expect(records).toHaveLength(1);
    expect(records[0].windowName).toBeUndefined();
    // frameId should still be correctly mapped
    expect(records[0].frameId).toBe(77);
  });
});

// ---------------------------------------------------------------------------
// Tests: dual-path failure emits neutral captureCode + legacy screenpipeCode
// ---------------------------------------------------------------------------

describe('HttpScreenpipeClient error codes — dual-path failure', () => {
  it('emits CAPTURE_SOURCE_UNAVAILABLE as the primary captureCode when both paths fail', async () => {
    // Point the client at an unreachable port so both AX and OCR fetches fail.
    const client = createScreenpipeClient('http://127.0.0.1:1');
    type AugmentedError = Error & { captureCode?: string; screenpipeCode?: string };
    let caughtError: AugmentedError | undefined;
    try {
      await client.search({ query: 'test' });
    } catch (err) {
      caughtError = err as AugmentedError;
    }

    expect(caughtError).toBeDefined();
    // The neutral captureCode is the primary identifier — consumers MUST
    // prefer this property over the legacy screenpipeCode going forward.
    expect(caughtError?.captureCode).toBe('CAPTURE_SOURCE_UNAVAILABLE');
  });

  it('retains legacy screenpipeCode for the compatibility window', async () => {
    // Exactly one test verifies the backward-compat property so external
    // agents that currently match on screenpipeCode keep working until the
    // compatibility window closes.
    const client = createScreenpipeClient('http://127.0.0.1:1');
    type AugmentedError = Error & { captureCode?: string; screenpipeCode?: string };
    let caughtError: AugmentedError | undefined;
    try {
      await client.search({ query: 'legacy' });
    } catch (err) {
      caughtError = err as AugmentedError;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError?.screenpipeCode).toBe('SCREENPIPE_UNAVAILABLE');
  });
});
