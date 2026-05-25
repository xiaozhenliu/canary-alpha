import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'service-stop.js');

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const close = cleanup.pop();
    if (close) {
      await close();
    }
  }
});

describe('service:stop script', () => {
  it('fails instead of reporting success when launchctl cannot inspect the service', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'service-stop-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const launchAgentsDir = join(homeDir, 'Library', 'LaunchAgents');
    const fakeBinDir = join(homeDir, 'fake-bin');
    const launchctlPath = join(fakeBinDir, 'launchctl');
    const plistPath = join(launchAgentsDir, 'com.screenpipe-memory-mcp.plist');

    await mkdir(launchAgentsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(plistPath, '<plist/>', 'utf8');
    await writeFile(launchctlPath, "#!/bin/sh\necho 'launchctl unavailable' >&2\nexit 1\n", 'utf8');
    await chmod(launchctlPath, 0o755);

    let error: { stdout?: string; stderr?: string; code?: number } | undefined;
    try {
      await execFileAsync(process.execPath, [SCRIPT_PATH], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: homeDir,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`
        }
      });
    } catch (caught) {
      error = caught as { stdout?: string; stderr?: string; code?: number };
    }

    expect(error).toBeDefined();
    expect(error?.code).toBe(1);
    expect(error?.stderr ?? '').toContain('launchctl unavailable');
    const { access } = await import('node:fs/promises');
    await expect(access(plistPath)).resolves.toBeUndefined();
  });
});
