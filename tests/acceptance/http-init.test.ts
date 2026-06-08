import { afterEach, describe, expect, it } from 'vitest';

import { connectHttpClient } from '../helpers/mcp-client.js';
import { startHttpServer } from '../helpers/start-http-server.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const close = cleanup.pop();
    if (close) {
      await close();
    }
  }
});

describe('http MCP initialization', () => {
  it('connects a real MCP client over streamable HTTP', async () => {
    const server = await startHttpServer(8765, {
      SCREENPIPE_MEMORY_MCP_AUTH_TOKEN: 'test-http-token'
    });
    cleanup.push(() => server.stop());

    const connection = await connectHttpClient(server.port, 'test-http-token');
    cleanup.push(() => connection.close());

    const tools = await connection.client.listTools();

    expect(tools.tools.length).toBeGreaterThan(0);
  });

  it('reports the serving process identity through internal-status', async () => {
    const server = await startHttpServer(8766, {
      SCREENPIPE_MEMORY_MCP_AUTH_TOKEN: 'test-http-token'
    });
    cleanup.push(() => server.stop());

    const connection = await connectHttpClient(server.port, 'test-http-token');
    cleanup.push(() => connection.close());

    const result = await connection.client.callTool({
      name: 'internal-status',
      arguments: {}
    });

    const structured = result.structuredContent as {
      status: string;
      mode: string;
      host: string;
      port: number;
      pid: number;
      configFile: string;
    };

    expect(structured.status).toBe('ok');
    expect(structured.mode).toBe('http');
    expect(structured.port).toBe(server.port);
    expect(structured.pid).toBe(server.pid);
  });

  it('rejects unauthenticated HTTP requests', async () => {
    const server = await startHttpServer(8767, {
      SCREENPIPE_MEMORY_MCP_AUTH_TOKEN: 'test-http-token'
    });
    cleanup.push(() => server.stop());

    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'unauth', method: 'ping' })
    });

    expect(response.status).toBe(401);
  });
});
