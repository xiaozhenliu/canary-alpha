import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CaptureLifecyclePort } from '../../types.js';

export type ScreenpipeControlAction = 'status' | 'start' | 'stop';

export interface ScreenpipeControlRequest {
  action: ScreenpipeControlAction;
}

export interface ScreenpipeControlResult {
  action: ScreenpipeControlAction;
  running: boolean;
  pid?: number;
  error?: string;
}

export interface ScreenpipeControlService {
  execute(request: ScreenpipeControlRequest): Promise<ScreenpipeControlResult>;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
// File is at src/services/capture/providers/screenpipe/control-service.ts
// so we need 5 dirname calls to reach the repository root.
const repositoryRoot = dirname(dirname(dirname(dirname(dirname(scriptDirectory)))));

export class DefaultScreenpipeControlService implements ScreenpipeControlService, CaptureLifecyclePort {
  private child: ChildProcess | null = null;

  async execute(request: ScreenpipeControlRequest): Promise<ScreenpipeControlResult> {
    switch (request.action) {
      case 'status': return this.status();
      case 'start': return this.start();
      case 'stop': return this.stop();
    }
  }

  private async status(): Promise<ScreenpipeControlResult> {
    try {
      const response = await fetch('http://127.0.0.1:3030/health', { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        return { action: 'status', running: true, pid: this.child?.pid };
      }
    } catch {
      // not reachable
    }
    return { action: 'status', running: false };
  }

  private async start(): Promise<ScreenpipeControlResult> {
    const already = await this.status();
    if (already.running) {
      return { action: 'start', running: true, pid: already.pid };
    }

    try {
      this.child = spawn('node', ['scripts/screenpipe-safe-record.js'], {
        cwd: repositoryRoot,
        detached: false,
        stdio: 'ignore'
      });
      this.child.on('exit', () => { this.child = null; });
      // Wait briefly for Screenpipe to start
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const check = await this.status();
      return { action: 'start', running: check.running, pid: this.child?.pid };
    } catch (error) {
      return { action: 'start', running: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async stop(): Promise<ScreenpipeControlResult> {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
      return { action: 'stop', running: false };
    }
    return { action: 'stop', running: false, error: 'No Screenpipe process managed by this server.' };
  }
}
