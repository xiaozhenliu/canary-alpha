import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import { killProcessGroup } from '../../../scripts/screenpipe-safe-record.js';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventuallyDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 20; i += 1) {
    if (!pidAlive(pid)) return true;
    await delay(100);
  }
  return !pidAlive(pid);
}

describe('killProcessGroup', () => {
  it('SIGTERM kills the parent process group including a child process', async () => {
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
        console.log(child.pid);
        setTimeout(() => {}, 60000);
      `
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );

    const childPid = await new Promise<number>((resolve) => {
      parent.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    });

    expect(pidAlive(parent.pid!)).toBe(true);
    expect(pidAlive(childPid)).toBe(true);

    killProcessGroup(parent.pid!, 'SIGTERM');
    await new Promise<void>((resolve) => {
      parent.once('exit', () => resolve());
      setTimeout(() => resolve(), 2_000).unref();
    });

    expect(await eventuallyDead(parent.pid!)).toBe(true);
    expect(await eventuallyDead(childPid)).toBe(true);
  });
});
