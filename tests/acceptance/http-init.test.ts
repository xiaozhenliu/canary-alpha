import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connectHttpClient } from '../helpers/mcp-client.js';
import { startEmbeddingStub } from '../helpers/embedding-stub.js';
import { startScreenpipeStub } from '../helpers/screenpipe-stub.js';
import { startHttpServer } from '../helpers/start-http-server.js';
import { writeTestConfig } from '../helpers/test-config.js';
import { testTempRoot } from '../helpers/test-tmp.js';

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
      CANARY_ALPHA_MCP_AUTH_TOKEN: 'test-http-token'
    });
    cleanup.push(() => server.stop());

    const connection = await connectHttpClient(server.port, 'test-http-token');
    cleanup.push(() => connection.close());

    const tools = await connection.client.listTools();

    expect(tools.tools.length).toBeGreaterThan(0);
  });

  it('reports the serving process identity through internal-status', async () => {
    const server = await startHttpServer(8766, {
      CANARY_ALPHA_MCP_AUTH_TOKEN: 'test-http-token'
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
      captureProvider: {
        provider: string;
        capabilities: {
          providerName: string;
          ocrText: boolean;
          accessibilityTree: boolean;
          frameDetail: boolean;
          retentionTrim: boolean;
          processLifecycle: boolean;
        };
      };
    };

    expect(structured.status).toBe('ok');
    expect(structured.mode).toBe('http');
    expect(structured.port).toBe(server.port);
    expect(structured.pid).toBe(server.pid);

    // Capture provider capabilities exposed via status (Task 8, Stage 4).
    expect(structured.captureProvider.provider).toBe('screenpipe');
    expect(structured.captureProvider.capabilities.accessibilityTree).toBe(true);
  });

  it('rejects unauthenticated HTTP requests', async () => {
    const server = await startHttpServer(8767, {
      CANARY_ALPHA_MCP_AUTH_TOKEN: 'test-http-token'
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

  it('removes the runtime marker when an HTTP server shuts down', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'http-init-runtime-marker-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    const port = 8770;
    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http',
      port,
      authToken: 'test-http-token'
    });

    // Start the HTTP server with a custom HOME so markers go into the isolated temp dir.
    const server = await startHttpServer(port, {
      HOME: homeDir,
      CANARY_ALPHA_MCP_AUTH_TOKEN: 'test-http-token'
    });
    cleanup.push(() => server.stop());

    const runtimeDir = join(homeDir, '.computer-history-mcp', 'runtime-processes');

    // Verify marker was created after startup.
    const startMarkers = await readdir(runtimeDir);
    expect(startMarkers.length).toBeGreaterThan(0);

    // Shutdown the server and wait for it to exit.
    await server.stop();

    // Poll until the marker directory is empty or gone (cleanup on shutdown).
    const startedAt = Date.now();
    let remainingMarkers = ['placeholder'];
    while (Date.now() - startedAt < 10_000) {
      try {
        remainingMarkers = await readdir(runtimeDir);
      } catch {
        remainingMarkers = [];
      }

      if (remainingMarkers.length === 0) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(remainingMarkers).toEqual([]);
  });
});
