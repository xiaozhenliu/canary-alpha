import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';
import { testTempRoot } from '../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'service-start.js');

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const close = cleanup.pop();
    if (close) {
      await close();
    }
  }
});

describe('service:start script', () => {
  it('removes the installed plist when launchctl bootstrap fails', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'service-start-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const appDir = join(homeDir, '.canary-alpha-mcp');
    const launchAgentsDir = join(homeDir, 'Library', 'LaunchAgents');
    const fakeBinDir = join(homeDir, 'fake-bin');
    const launchctlPath = join(fakeBinDir, 'launchctl');
    const lsofPath = join(fakeBinDir, 'lsof');
    const distDir = join(PROJECT_ROOT, 'dist', 'src');
    const distEntrypoint = join(distDir, 'index.js');
    const plistPath = join(launchAgentsDir, 'com.canary-alpha-mcp.plist');

    await mkdir(appDir, { recursive: true });
    await mkdir(launchAgentsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    await mkdir(distDir, { recursive: true });

    // service-start.js only checks existsSync(distEntrypoint). If the real built file is
    // already present, we must not overwrite it — doing so would corrupt dist/src/index.js
    // for other tests running in parallel (e.g. config-cli acceptance tests). We write a
    // stub only when the file does not yet exist, and remove it afterwards.
    const entrypointPreExisted = await readFile(distEntrypoint, 'utf8').then(() => true).catch(() => false);
    if (!entrypointPreExisted) {
      await writeFile(distEntrypoint, 'export {};\n', 'utf8');
      cleanup.push(() => rm(distEntrypoint, { force: true }));
    }

    await writeFile(join(appDir, 'config.yaml'), [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 18765',
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
    await writeFile(launchctlPath, "#!/bin/sh\nif [ \"$1\" = \"print\" ]; then\n  echo 'Could not find service' >&2\n  exit 113\nfi\nif [ \"$1\" = \"bootstrap\" ]; then\n  echo 'bootstrap failed' >&2\n  exit 1\nfi\nexit 0\n", 'utf8');
    await writeFile(lsofPath, "#!/bin/sh\nexit 1\n", 'utf8');
    await chmod(launchctlPath, 0o755);
    await chmod(lsofPath, 0o755);

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
    expect(error?.stderr ?? '').toContain('bootstrap failed');
    const { access } = await import('node:fs/promises');
    await expect(access(plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails fast when another process is already listening on the managed port', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'service-start-port-conflict-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const appDir = join(homeDir, '.canary-alpha-mcp');
    const launchAgentsDir = join(homeDir, 'Library', 'LaunchAgents');
    const fakeBinDir = join(homeDir, 'fake-bin');
    const launchctlPath = join(fakeBinDir, 'launchctl');
    const lsofPath = join(fakeBinDir, 'lsof');
    const distDir = join(PROJECT_ROOT, 'dist', 'src');
    const distEntrypoint = join(distDir, 'index.js');
    const plistPath = join(launchAgentsDir, 'com.canary-alpha-mcp.plist');

    await mkdir(appDir, { recursive: true });
    await mkdir(launchAgentsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    await mkdir(distDir, { recursive: true });

    // service-start.js only checks existsSync(distEntrypoint). If the real built file is
    // already present, we must not overwrite it — doing so would corrupt dist/src/index.js
    // for other tests running in parallel (e.g. config-cli acceptance tests). We write a
    // stub only when the file does not yet exist, and remove it afterwards.
    const entrypointPreExisted = await readFile(distEntrypoint, 'utf8').then(() => true).catch(() => false);
    if (!entrypointPreExisted) {
      await writeFile(distEntrypoint, 'export {};\n', 'utf8');
      cleanup.push(() => rm(distEntrypoint, { force: true }));
    }

    await writeFile(join(appDir, 'config.yaml'), [
      'server:',
      '  mode: http',
      '  host: 127.0.0.1',
      '  port: 18765',
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
    await writeFile(launchctlPath, "#!/bin/sh\nif [ \"$1\" = \"print\" ]; then\n  echo 'Could not find service' >&2\n  exit 113\nfi\necho 'bootstrap should not run' >&2\nexit 1\n", 'utf8');
    await writeFile(lsofPath, "#!/bin/sh\nprintf 'p29083\\ncnode\\nnTCP 127.0.0.1:18765 (LISTEN)\\n'\n", 'utf8');
    await chmod(launchctlPath, 0o755);
    await chmod(lsofPath, 0o755);

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
    expect(error?.stderr ?? '').toContain('Port 18765 is already in use by PID 29083 (node)');
    expect(error?.stderr ?? '').toContain('Stop the existing process before starting the managed service.');
    const { access } = await import('node:fs/promises');
    await expect(access(plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
