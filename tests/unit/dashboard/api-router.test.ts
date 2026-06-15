import { describe, it, expect, vi } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { ApiRouter, sendJson } from '../../../src/dashboard/api-router.js';
import type { AppContext } from '../../../src/types/app-config.js';

function createMockRequest(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  Object.assign(req.headers, headers);
  return req;
}

function createMockResponse(): ServerResponse & { _body: string; _statusCode: number } {
  const socket = new Socket();
  const res = new ServerResponse(createMockRequest('GET', '/')) as ServerResponse & { _body: string; _statusCode: number };
  res._body = '';
  res._statusCode = 200;
  const origEnd = res.end.bind(res);
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === 'string') res._body = chunk;
    if (Buffer.isBuffer(chunk)) res._body = chunk.toString();
    res._statusCode = res.statusCode;
    return origEnd(chunk);
  }) as typeof res.end;
  return res;
}

const mockApp = {
  config: { server: { authToken: 'test-token' } },
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  services: {}
} as unknown as AppContext;

describe('ApiRouter', () => {
  it('returns false for non-/api/ paths', async () => {
    const router = new ApiRouter();
    const req = createMockRequest('GET', '/mcp');
    const res = createMockResponse();
    const handled = await router.handle(req, res, mockApp);
    expect(handled).toBe(false);
  });

  it('returns 401 for missing auth token', async () => {
    const router = new ApiRouter();
    router.register('GET', '/test', async (ctx) => sendJson(ctx.res, 200, { ok: true }));
    const req = createMockRequest('GET', '/api/test');
    const res = createMockResponse();
    const handled = await router.handle(req, res, mockApp);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for wrong auth token', async () => {
    const router = new ApiRouter();
    router.register('GET', '/test', async (ctx) => sendJson(ctx.res, 200, { ok: true }));
    const req = createMockRequest('GET', '/api/test', { authorization: 'Bearer wrong-token' });
    const res = createMockResponse();
    const handled = await router.handle(req, res, mockApp);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });

  it('dispatches to registered handler with valid token', async () => {
    const router = new ApiRouter();
    router.register('GET', '/test', async (ctx) => sendJson(ctx.res, 200, { ok: true }));
    const req = createMockRequest('GET', '/api/test', { authorization: 'Bearer test-token' });
    const res = createMockResponse();
    const handled = await router.handle(req, res, mockApp);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for unregistered routes', async () => {
    const router = new ApiRouter();
    const req = createMockRequest('GET', '/api/unknown', { authorization: 'Bearer test-token' });
    const res = createMockResponse();
    const handled = await router.handle(req, res, mockApp);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });

  it('extracts path params from :param segments', async () => {
    const router = new ApiRouter();
    let capturedParams: Record<string, string> = {};
    router.register('GET', '/items/:id/detail', async (ctx) => {
      capturedParams = ctx.req.params;
      sendJson(ctx.res, 200, { ok: true });
    });
    const req = createMockRequest('GET', '/api/items/42/detail', { authorization: 'Bearer test-token' });
    const res = createMockResponse();
    await router.handle(req, res, mockApp);
    expect(capturedParams.id).toBe('42');
  });

  it('extracts query parameters', async () => {
    const router = new ApiRouter();
    let capturedQuery: URLSearchParams | undefined;
    router.register('GET', '/search', async (ctx) => {
      capturedQuery = ctx.req.query;
      sendJson(ctx.res, 200, { ok: true });
    });
    const req = createMockRequest('GET', '/api/search?q=hello&limit=10', { authorization: 'Bearer test-token' });
    const res = createMockResponse();
    await router.handle(req, res, mockApp);
    expect(capturedQuery?.get('q')).toBe('hello');
    expect(capturedQuery?.get('limit')).toBe('10');
  });
});

describe('sendJson', () => {
  it('sets correct headers and status', () => {
    const res = createMockResponse();
    sendJson(res, 201, { created: true });
    expect(res.statusCode).toBe(201);
    expect(res.getHeader('content-type')).toBe('application/json');
  });
});
