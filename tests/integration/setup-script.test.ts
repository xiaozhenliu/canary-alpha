import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = '/Users/xz/Projects/lifecapture-mcp';
const SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'setup.js');

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const task = cleanup.pop();
    if (task) {
      await task();
    }
  }
});

describe('setup script', () => {
  it('creates the default config and points users to npm run onboard', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'setup-script-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    await mkdir(join(PROJECT_ROOT, 'node_modules'), { recursive: true });

    const result = await execFileAsync(process.execPath, [SCRIPT_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    const configPath = join(homeDir, '.screenpipe-memory-mcp', 'config.yaml');
    const configContents = await readFile(configPath, 'utf8');

    expect(configContents).toContain('port: 18765');
    expect(configContents).toContain('kind: ollama');
    expect(result.stdout).toContain('Start Screenpipe if it is not already running: npm run screenpipe:safe-record');
    expect(result.stdout).toContain('Run npm run onboard for the default-first interactive setup, build, and service start flow.');
    expect(result.stdout).toContain(configPath);
  });
});
