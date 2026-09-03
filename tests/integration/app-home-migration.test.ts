import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/load-config.js';
import { testTempRoot } from '../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = join(import.meta.dirname, '..', '..');
const SETUP_SCRIPT = join(PROJECT_ROOT, 'scripts', 'setup.js');

const cleanup: Array<() => Promise<void>> = [];

const LEGACY_CONFIG = [
  'server:',
  '  mode: http',
  '  host: 127.0.0.1',
  '  port: 18765',
  '  authToken: legacy-migration-token',
  'logging:',
  '  level: info',
  'screenpipe:',
  '  url: http://127.0.0.1:3030',
  'providers:',
  '  embeddings:',
  '    kind: openai-compatible',
  '    baseUrl: http://127.0.0.1:11434/v1',
  '    model: test-model',
  'vectorStore:',
  '  kind: chroma',
  'retrieval:',
  '  freshnessWindowMinutes: 15',
  '  pollIntervalSeconds: 30',
  '  maxCatchUpBatches: 3',
  '  maxCatchUpRecords: 500'
].join('\n');

afterEach(async () => {
  while (cleanup.length > 0) {
    const task = cleanup.pop();
    if (task) {
      await task();
    }
  }
});

describe('app home migration integration', () => {
  it('migrates legacy app home when setup runs', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'legacy-setup-migration-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const legacyDir = join(homeDir, '.canary-alpha-mcp');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'config.yaml'), LEGACY_CONFIG, 'utf8');
    await mkdir(join(PROJECT_ROOT, 'node_modules'), { recursive: true });

    await execFileAsync(process.execPath, [SETUP_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, HOME: homeDir }
    });

    const migratedConfig = join(homeDir, '.computer-history-mcp', 'config.yaml');
    expect(existsSync(migratedConfig)).toBe(true);
    expect(existsSync(legacyDir)).toBe(false);
    await expect(readFile(migratedConfig, 'utf8')).resolves.toContain('legacy-migration-token');
  });

  it('migrates legacy app home when the server loads config directly', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'legacy-load-config-migration-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const legacyDir = join(homeDir, '.canary-alpha-mcp');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'config.yaml'), LEGACY_CONFIG, 'utf8');

    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const config = await loadConfig(undefined);
      expect(config.server.authToken).toBe('legacy-migration-token');
    } finally {
      process.env.HOME = originalHome;
    }

    const migratedConfig = join(homeDir, '.computer-history-mcp', 'config.yaml');

    expect(existsSync(migratedConfig)).toBe(true);
    expect(existsSync(legacyDir)).toBe(false);
  });

  it('fails closed when loadConfig sees both legacy and canonical homes', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'both-homes-load-config-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    await mkdir(join(homeDir, '.canary-alpha-mcp'), { recursive: true });
    await mkdir(join(homeDir, '.computer-history-mcp'), { recursive: true });
    await writeFile(join(homeDir, '.computer-history-mcp', 'config.yaml'), LEGACY_CONFIG, 'utf8');

    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      await expect(loadConfig(undefined)).rejects.toThrow(/both .* exist/i);
    } finally {
      process.env.HOME = originalHome;
    }
  });
});
