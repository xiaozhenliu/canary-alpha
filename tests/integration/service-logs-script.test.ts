import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = '/Users/xz/Projects/lifecapture-mcp';
const SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'service-logs.js');

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const close = cleanup.pop();
    if (close) {
      await close();
    }
  }
});

describe('service:logs script', () => {
  it('prints rotated managed service logs when service.log has been rotated away', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'service-logs-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const logDir = join(homeDir, '.screenpipe-memory-mcp', 'logs');
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, 'service.log.1'), [
      '2026-04-15T00:00:00.000Z [INFO] rotated line 1',
      '2026-04-15T00:00:01.000Z [ERROR] rotated line 2'
    ].join('\n'), 'utf8');

    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    expect(stderr).toBe('');
    expect(stdout).toContain('== service log (rotated):');
    expect(stdout).toContain('rotated line 1');
    expect(stdout).toContain('rotated line 2');
  });
});
