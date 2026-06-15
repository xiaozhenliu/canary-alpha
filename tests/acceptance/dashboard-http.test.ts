import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/bootstrap/create-app.js';
import { startHttpTransport } from '../../src/transports/http.js';
import type { AppContext } from '../../src/types/app-config.js';
import type { Server } from 'node:http';

describe('Dashboard HTTP integration', () => {
  let app: AppContext;
  let baseUrl: string;
  let server: Server;
  const testToken = 'test-dashboard-token-abc123';

  beforeAll(async () => {
    app = await createApp({
      mode: 'http', port: 0, logLevel: 'error', startIndexingPoller: false
    });
    (app.config.server as Record<string, unknown>).authToken = testToken;
    const transport = await startHttpTransport(app);
    baseUrl = `http://127.0.0.1:${transport.address.port}`;
    server = transport.server;
  });

  afterAll(() => {
    server?.close();
  });

  it('GET /api/status requires auth', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(401);
  });

  it('GET /api/status returns status with valid token', async () => {
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('GET /api/config/schema returns JSON schema', async () => {
    const res = await fetch(`${baseUrl}/api/config/schema`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.type).toBe('object');
    expect(data.properties?.server).toBeDefined();
  });

  it('GET /api/config/effective returns typed config', async () => {
    const res = await fetch(`${baseUrl}/api/config/effective`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.config).toBeDefined();
    expect(typeof data.config.server).toBe('object');
  });

  it('GET /api/routines returns routines list', async () => {
    const res = await fetch(`${baseUrl}/api/routines`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.routines).toBeDefined();
    expect(Array.isArray(data.routines)).toBe(true);
  });

  it('GET /api/logs returns log entries', async () => {
    const res = await fetch(`${baseUrl}/api/logs`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toBeDefined();
    expect(typeof data.total).toBe('number');
  });

  it('GET / serves SPA or 404 when not built', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect([200, 404]).toContain(res.status);
  });

  it('GET /mcp still handles MCP protocol', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: { capabilities: {} }, id: 1 })
    });
    expect(res.status).not.toBe(404);
  });

  it('returns 404 for unknown API routes', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(404);
  });
});
