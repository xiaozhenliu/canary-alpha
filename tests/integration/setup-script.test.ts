import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  APP_DIRECTORY_NAME,
  resolveAppDirectory,
  resolveRoutineDefinitionsDirectory,
  resolveRoutineHistoryDirectory,
  resolveRoutinesDirectory
} from '../../src/config/paths.js';
import { testTempRoot } from '../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(TEST_DIRECTORY, '..', '..');
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
    const homeDir = await mkdtemp(join(testTempRoot(), 'setup-script-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    await mkdir(join(PROJECT_ROOT, 'node_modules'), { recursive: true });

    const result = await execFileAsync(process.execPath, [SCRIPT_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    const configPath = join(homeDir, APP_DIRECTORY_NAME, 'config.yaml');
    const configContents = await readFile(configPath, 'utf8');

    expect(configContents).toContain('port: 18765');
    expect(configContents).toContain('kind: ollama');
    expect(result.stdout).toContain('Run npm start; it selects onboarding, build recovery, or fast resume automatically.');
    expect(result.stdout).toContain(configPath);
  });

  it('uses the canonical app home and exposes routines default path helpers under it', () => {
    expect(APP_DIRECTORY_NAME).toBe('.computer-history-mcp');
    expect(resolveAppDirectory()).toBe(join(process.env.HOME ?? '', '.computer-history-mcp'));
    expect(resolveRoutinesDirectory()).toBe(join(process.env.HOME ?? '', '.computer-history-mcp', 'routines'));
    expect(resolveRoutineDefinitionsDirectory()).toBe(join(process.env.HOME ?? '', '.computer-history-mcp', 'routines', 'definitions'));
    expect(resolveRoutineHistoryDirectory()).toBe(join(process.env.HOME ?? '', '.computer-history-mcp', 'routines', 'history'));
  });
});
