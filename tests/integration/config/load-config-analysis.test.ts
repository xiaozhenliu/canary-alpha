import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config/load-config.js';
import { APP_DIRECTORY_NAME } from '../../../src/config/paths.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

// ---------------------------------------------------------------------------
// Task 1.1 — loadConfig 对 analysis: / llm: / paths.derivedDatabase 的接线
// ---------------------------------------------------------------------------

async function writeConfigForHome(homeDir: string, yaml: string) {
  const appDir = join(homeDir, APP_DIRECTORY_NAME);
  const configPath = join(appDir, 'config.yaml');
  await mkdir(appDir, { recursive: true });
  await writeFile(configPath, yaml, 'utf8');
  return configPath;
}

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe('loadConfig analysis / llm / paths.derivedDatabase (task 1.1)', () => {
  it('falls back to default derivedDatabase path under app directory when config.yaml is absent', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-derived-default-'));
    process.env.HOME = homeDir;

    const config = await loadConfig();

    expect(config.paths.derivedDatabase).toBe(
      join(homeDir, APP_DIRECTORY_NAME, 'derived.sqlite')
    );
    expect(config.analysis.sessions.idleThresholdSeconds).toBe(120);
    expect(config.analysis.summary.provider).toBe('template');
    expect(config.analysis.summary.remoteLlmTimeoutMs).toBe(30_000);
    expect(config.analysis.embeddings.topK).toBe(20);
    expect(config.analysis.embeddings.minScore).toBe(0.0);
    expect(config.llm.model).toBe('deepseek-chat');
    expect(config.llm.base_url).toBeUndefined();
    expect(config.llm.api_key).toBeUndefined();
  });

  it('respects user-provided analysis / llm / paths.derivedDatabase from config.yaml', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-derived-override-'));
    process.env.HOME = homeDir;

    const customPath = join(homeDir, 'custom-derived.sqlite');
    const yaml = [
      'analysis:',
      '  sessions:',
      '    idleThresholdSeconds: 300',
      '  summary:',
      '    provider: remote-llm',
      '    remoteLlmTimeoutMs: 60000',
      '  embeddings:',
      '    topK: 50',
      '    minScore: 0.25',
      'llm:',
      '  base_url: http://127.0.0.1:11434/v1',
      '  api_key: sk-test-token',
      '  model: gpt-4o',
      'paths:',
      `  derivedDatabase: ${customPath}`
    ].join('\n');

    await writeConfigForHome(homeDir, yaml);

    const config = await loadConfig();

    expect(config.analysis.sessions.idleThresholdSeconds).toBe(300);
    expect(config.analysis.summary.provider).toBe('remote-llm');
    expect(config.analysis.summary.remoteLlmTimeoutMs).toBe(60_000);
    expect(config.analysis.embeddings.topK).toBe(50);
    expect(config.analysis.embeddings.minScore).toBe(0.25);

    expect(config.llm.base_url).toBe('http://127.0.0.1:11434/v1');
    expect(config.llm.api_key).toBe('sk-test-token');
    expect(config.llm.model).toBe('gpt-4o');

    expect(config.paths.derivedDatabase).toBe(customPath);
  });

  it('expands ~/ prefix in paths.derivedDatabase against the resolved home directory', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-derived-tilde-'));
    process.env.HOME = homeDir;

    const yaml = [
      'paths:',
      '  derivedDatabase: ~/custom/derived.sqlite'
    ].join('\n');

    await writeConfigForHome(homeDir, yaml);

    const config = await loadConfig();

    expect(config.paths.derivedDatabase).toBe(join(homeDir, 'custom/derived.sqlite'));
  });

  it('keeps existing config.yaml without analysis: / llm: sections backward compatible', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'load-config-backward-compat-'));
    process.env.HOME = homeDir;

    // Mimic a pre-task-1.1 config.yaml that has no analysis / llm sections.
    const yaml = [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 8765',
      'logging:',
      '  level: info',
      'privacy:',
      '  excludeApps:',
      '    - 1Password',
      '    - Keychain Access'
    ].join('\n');

    await writeConfigForHome(homeDir, yaml);

    const config = await loadConfig();

    // Old fields preserved
    expect(config.privacy.excludeApps).toContain('1Password');
    expect(config.server.port).toBe(8765);

    // New analysis / llm fields populated with defaults
    expect(config.analysis.sessions.idleThresholdSeconds).toBe(120);
    expect(config.analysis.summary.provider).toBe('template');
    expect(config.llm.model).toBe('deepseek-chat');
    expect(config.paths.derivedDatabase).toBe(
      join(homeDir, APP_DIRECTORY_NAME, 'derived.sqlite')
    );
  });
});
