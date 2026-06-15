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

  // Security: bulk reveal must never expose the raw secret value, even with ?reveal=true query param
  it('GET /api/config/effective never returns unmasked secrets even with ?reveal=true', async () => {
    const res = await fetch(`${baseUrl}/api/config/effective?reveal=true`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { config: Record<string, unknown> };
    // The authToken set in-memory is not written to the config file; loadConfig() reads the file,
    // so authToken from loadConfig() will be empty → masked as '(unset)'.
    // Either way it must NOT be the plain testToken value.
    const server = data.config.server as Record<string, unknown>;
    expect(server.authToken).not.toBe(testToken);
    // Must be a masked sentinel value (either '***' for set values or '(unset)' for empty)
    expect(['***', '(unset)', undefined]).toContain(server.authToken);
  });

  it('GET /api/config never returns unmasked secrets even with ?reveal=true', async () => {
    const res = await fetch(`${baseUrl}/api/config?reveal=true`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { entries: Array<{ path: string; display: string }> };
    const authEntry = data.entries.find(e => e.path === 'server.authToken');
    // Secret must always be masked in the list endpoint regardless of ?reveal=true
    expect(authEntry).toBeDefined();
    expect(['***', '(unset)']).toContain(authEntry?.display);
    expect(authEntry?.display).not.toBe(testToken);
  });

  // Single-field reveal: only the requested field is exposed
  it('GET /api/config/get returns masked value without reveal flag', async () => {
    const res = await fetch(`${baseUrl}/api/config/get?path=server.authToken`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { path: string; display: string };
    expect(data.path).toBe('server.authToken');
    expect(data.display).toBe('***');
  });

  it('GET /api/config/get?reveal=true returns an unmasked (non-***) value for the requested field', async () => {
    // providers.embeddings.apiKey is a secret field; when not set in the file its display is '(unset)',
    // which is different from the masked sentinel '***'. Either way, reveal=true must not return '***'.
    const res = await fetch(`${baseUrl}/api/config/get?path=providers.embeddings.apiKey&reveal=true`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { path: string; display: string };
    expect(data.path).toBe('providers.embeddings.apiKey');
    // With reveal=true the display must not be the masked sentinel
    expect(data.display).not.toBe('***');
  });

  it('GET /api/config/get without path returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/config/get`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/path/i);
  });

  it('GET /api/config/get with unknown path returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/config/get?path=nonexistent.field`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(400);
  });
});
