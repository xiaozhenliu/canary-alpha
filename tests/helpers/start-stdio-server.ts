import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface StartedServerProcess {
  process: ChildProcess;
  stop(): Promise<void>;
}

function createServerProcess(args: string[], env: NodeJS.ProcessEnv = {}): StartedServerProcess {
  const child = spawn('npx', ['tsx', 'src/index.ts', ...args], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  child.stderr?.on('data', () => {
    // Keep the pipe flowing for debugging visibility without polluting test output.
  });

  return {
    process: child,
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.killed) {
        return;
      }

      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  };
}

export function startStdioServer(env: NodeJS.ProcessEnv = {}): StartedServerProcess {
  return createServerProcess(['--mode', 'stdio'], env);
}
