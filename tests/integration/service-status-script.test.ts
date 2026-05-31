import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';
import { testTempRoot } from '../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'service-status.js');

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const close = cleanup.pop();
    if (close) {
      await close();
    }
  }
});

describe('service:status script', () => {
  it('reports launchd state even when config.yaml is malformed', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'service-status-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const appDir = join(homeDir, '.canary-alpha-mcp');
    const launchAgentsDir = join(homeDir, 'Library', 'LaunchAgents');
    const fakeBinDir = join(homeDir, 'fake-bin');
    const launchctlPath = join(fakeBinDir, 'launchctl');

    await mkdir(appDir, { recursive: true });
    await mkdir(launchAgentsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });

    await writeFile(join(appDir, 'config.yaml'), 'server: [broken\n', 'utf8');
    await writeFile(join(launchAgentsDir, 'com.canary-alpha-mcp.plist'), [
      '<plist>',
      '  <dict>',
      '    <key>EnvironmentVariables</key>',
      '    <dict>',
      '      <key>SCREENPIPE_MEMORY_MCP_SERVER_HOST</key>',
      '      <string>127.0.0.1</string>',
      '      <key>SCREENPIPE_MEMORY_MCP_SERVER_PORT</key>',
      '      <string>18765</string>',
      '    </dict>',
      '  </dict>',
      '</plist>'
    ].join('\n'), 'utf8');

    await writeFile(launchctlPath, "#!/bin/sh\nif [ \"$1\" = \"print\" ]; then\n  echo 'gui/501/com.canary-alpha-mcp = {'\n  echo '    state = waiting'\n  echo '}'\n  exit 0\nfi\nexit 1\n", 'utf8');
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
    expect(error?.stderr ?? '').toBe('');
    expect(error?.stdout ?? '').toContain('launchctl: loaded');
    expect(error?.stdout ?? '').toContain('endpoint: http://127.0.0.1:18765/mcp (unhealthy)');
    expect(error?.stdout ?? '').toContain('config: invalid (');
  });

  it('reports launchd state even when managed MCP_PORT is malformed', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'service-status-bad-managed-port-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const appDir = join(homeDir, '.canary-alpha-mcp');
    const launchAgentsDir = join(homeDir, 'Library', 'LaunchAgents');
    const fakeBinDir = join(homeDir, 'fake-bin');
    const launchctlPath = join(fakeBinDir, 'launchctl');

    await mkdir(appDir, { recursive: true });
    await mkdir(launchAgentsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });

    await writeFile(join(appDir, 'config.yaml'), [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 8765',
      'logging:',
      '  level: info',
      'screenpipe:',
      '  url: http://127.0.0.1:3030',
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      '    baseUrl: http://127.0.0.1:11434/v1',
      '    model: acceptance-embedding-model',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n'), 'utf8');
    await writeFile(join(launchAgentsDir, 'com.canary-alpha-mcp.plist'), [
      '<plist>',
      '  <dict>',
      '    <key>EnvironmentVariables</key>',
      '    <dict>',
      '      <key>MCP_PORT</key>',
      '      <string>broken</string>',
      '      <key>SCREENPIPE_MEMORY_MCP_SERVER_HOST</key>',
      '      <string>127.0.0.1</string>',
      '      <key>SCREENPIPE_MEMORY_MCP_SERVER_PORT</key>',
      '      <string>18765</string>',
      '    </dict>',
      '  </dict>',
      '</plist>'
    ].join('\n'), 'utf8');

    await writeFile(launchctlPath, "#!/bin/sh\nif [ \"$1\" = \"print\" ]; then\n  echo 'gui/501/com.canary-alpha-mcp = {'\n  echo '    state = waiting'\n  echo '}'\n  exit 0\nfi\nexit 1\n", 'utf8');
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
    expect(error?.stderr ?? '').toBe('');
    expect(error?.stdout ?? '').toContain('launchctl: loaded');
    expect(error?.stdout ?? '').toContain('endpoint: http://127.0.0.1:18765/mcp (unhealthy)');
    expect(error?.stdout ?? '').toContain('managed environment: invalid (Invalid MCP_PORT value: broken)');
  });

  it('reports launchd state even when the frozen managed port is malformed', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'service-status-bad-frozen-port-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const appDir = join(homeDir, '.canary-alpha-mcp');
    const launchAgentsDir = join(homeDir, 'Library', 'LaunchAgents');
    const fakeBinDir = join(homeDir, 'fake-bin');
    const launchctlPath = join(fakeBinDir, 'launchctl');

    await mkdir(appDir, { recursive: true });
    await mkdir(launchAgentsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });

    await writeFile(join(appDir, 'config.yaml'), [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 8765',
      'logging:',
      '  level: info',
      'screenpipe:',
      '  url: http://127.0.0.1:3030',
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      '    baseUrl: http://127.0.0.1:11434/v1',
      '    model: acceptance-embedding-model',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n'), 'utf8');
    await writeFile(join(launchAgentsDir, 'com.canary-alpha-mcp.plist'), [
      '<plist>',
      '  <dict>',
      '    <key>EnvironmentVariables</key>',
      '    <dict>',
      '      <key>SCREENPIPE_MEMORY_MCP_SERVER_PORT</key>',
      '      <string>broken</string>',
      '    </dict>',
      '  </dict>',
      '</plist>'
    ].join('\n'), 'utf8');

    await writeFile(launchctlPath, "#!/bin/sh\nif [ \"$1\" = \"print\" ]; then\n  echo 'gui/501/com.canary-alpha-mcp = {'\n  echo '    state = waiting'\n  echo '}'\n  exit 0\nfi\nexit 1\n", 'utf8');
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
    expect(error?.stderr ?? '').toBe('');
    expect(error?.stdout ?? '').toContain('launchctl: loaded');
    expect(error?.stdout ?? '').toContain('endpoint: http://127.0.0.1:8765/mcp (unhealthy)');
    expect(error?.stdout ?? '').toContain('managed environment: invalid (Invalid MCP_PORT value: broken)');
  });

  it('surfaces launchctl execution errors instead of reporting not loaded', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'service-status-launchctl-error-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const appDir = join(homeDir, '.canary-alpha-mcp');
    const fakeBinDir = join(homeDir, 'fake-bin');
    const launchctlPath = join(fakeBinDir, 'launchctl');

    await mkdir(appDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(join(appDir, 'config.yaml'), [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 8765',
      'logging:',
      '  level: info',
      'screenpipe:',
      '  url: http://127.0.0.1:3030',
      'providers:',
      '  embeddings:',
      '    kind: openai-compatible',
      '    baseUrl: http://127.0.0.1:11434/v1',
      '    model: acceptance-embedding-model',
      'vectorStore:',
      '  kind: chroma',
      'retrieval:',
      '  freshnessWindowMinutes: 15',
      '  pollIntervalSeconds: 30',
      '  maxCatchUpBatches: 3',
      '  maxCatchUpRecords: 500'
    ].join('\n'), 'utf8');
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
    expect(error?.stderr ?? '').toBe('');
    expect(error?.stdout ?? '').toContain('launchctl: error');
    expect(error?.stdout ?? '').toContain('launchctl error: launchctl unavailable');
  });
});
