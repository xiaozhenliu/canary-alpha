import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEST_HTTP_AUTH_TOKEN } from './mcp-client.js';
import { testTempRoot } from './test-tmp.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIRECTORY_NAME = '.computer-history-mcp';

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

async function resolveIsolatedHome(env: NodeJS.ProcessEnv): Promise<{
  env: NodeJS.ProcessEnv;
  cleanupHome?: () => Promise<void>;
}> {
  if (Object.prototype.hasOwnProperty.call(env, 'HOME') && typeof env.HOME === 'string' && env.HOME.length > 0) {
    return { env };
  }

  // Fail-closed app-home migration must not see a developer machine that still
  // has both legacy and canonical homes when acceptance helpers omit HOME.
  const homeDir = await mkdtemp(join(testTempRoot(), 'http-server-home-'));
  await mkdir(join(homeDir, APP_DIRECTORY_NAME), { recursive: true });
  return {
    env: { ...env, HOME: homeDir },
    cleanupHome: () => rm(homeDir, { recursive: true, force: true })
  };
}

export async function startHttpServer(port = 8765, env: NodeJS.ProcessEnv = {}): Promise<StartedHttpServer> {
  const isolated = await resolveIsolatedHome(env);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--mode', 'http'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      MCP_PORT: String(port),
      CANARY_ALPHA_MCP_AUTH_TOKEN: isolated.env.CANARY_ALPHA_MCP_AUTH_TOKEN ?? TEST_HTTP_AUTH_TOKEN,
      ...isolated.env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  child.stderr?.on('data', () => {
    // Keep stderr draining during tests.
  });

  try {
    await waitForHttpServer(`http://127.0.0.1:${port}/mcp`);
  } catch (error) {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => undefined);
    }
    await isolated.cleanupHome?.();
    throw error;
  }

  return {
    process: child,
    pid: child.pid ?? -1,
    port,
    async stop(): Promise<void> {
      try {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGTERM');
          await once(child, 'exit');
        }
      } finally {
        await isolated.cleanupHome?.();
      }
    }
  };
}
