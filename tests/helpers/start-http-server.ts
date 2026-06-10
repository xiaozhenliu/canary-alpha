import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEST_HTTP_AUTH_TOKEN } from './mcp-client.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface StartedHttpServer {
  process: ChildProcess;
  pid: number;
  port: number;
  stop(): Promise<void>;
}

async function waitForHttpServer(url: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'health-check', method: 'ping' })
      });

      if (response.status >= 400 || response.status < 500 || response.status >= 500) {
        return;
      }
    } catch {
      // Server not ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`HTTP server did not start at ${url} within ${timeoutMs}ms`);
}

export async function startHttpServer(port = 8765, env: NodeJS.ProcessEnv = {}): Promise<StartedHttpServer> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--mode', 'http'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      MCP_PORT: String(port),
      CANARY_ALPHA_MCP_AUTH_TOKEN: env.CANARY_ALPHA_MCP_AUTH_TOKEN ?? TEST_HTTP_AUTH_TOKEN,
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  child.stderr?.on('data', () => {
    // Keep stderr draining during tests.
  });

  await waitForHttpServer(`http://127.0.0.1:${port}/mcp`);

  return {
    process: child,
    pid: child.pid ?? -1,
    port,
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.killed) {
        return;
      }

      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  };
}
