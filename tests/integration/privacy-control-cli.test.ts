import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { startEmbeddingStub } from '../helpers/embedding-stub.js';
import { startHttpServer } from '../helpers/start-http-server.js';
import { startScreenpipeStub } from '../helpers/screenpipe-stub.js';
import { writeTestConfig } from '../helpers/test-config.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'privacy-control.js');
const cleanup: Array<() => Promise<void>> = [];

async function createScreenpipeFixture(screenpipeDirectory: string): Promise<void> {
  const statements = [
    'PRAGMA page_size = 4096;',
    'PRAGMA journal_mode = DELETE;',
    'CREATE TABLE frames(id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, app_name TEXT, window_name TEXT, accessibility_text TEXT, accessibility_tree_json TEXT, full_text TEXT);',
    'CREATE TABLE elements(id INTEGER PRIMARY KEY, frame_id INTEGER NOT NULL, source TEXT NOT NULL DEFAULT \'accessibility\', role TEXT NOT NULL DEFAULT \'AXGroup\', text TEXT, properties TEXT);',
    'CREATE TABLE ocr_text(frame_id INTEGER NOT NULL, text TEXT NOT NULL, app_name TEXT NOT NULL DEFAULT \'\', window_name TEXT);',
    'CREATE VIRTUAL TABLE frames_fts_content USING fts5(full_text);',
    `INSERT INTO frames(id, timestamp, app_name, window_name, accessibility_text, accessibility_tree_json, full_text) VALUES
      (1, datetime('now', '-5 minutes'), 'Terminal', 'Claude Code', 'terminal prompt history terminal prompt history', '${'a'.repeat(3000)}', 'npm test failed in warp terminal and needs retry'),
      (2, datetime('now', '-4 minutes'), 'Terminal', 'Claude Code', 'terminal prompt history terminal prompt history', '${'b'.repeat(2800)}', 'npm test failed in warp terminal and needs retry'),
      (3, datetime('now', '-3 minutes'), 'Terminal', 'Claude Code', 'terminal prompt history terminal prompt history', '${'c'.repeat(2600)}', 'npm test failed in warp terminal and needs retry'),
      (4, datetime('now', '-2 minutes'), 'Cursor', 'Docs', 'release checklist release checklist release checklist', '${'d'.repeat(400)}', 'release checklist release checklist release checklist');`,
    `INSERT INTO elements(frame_id, source, role, text, properties) VALUES
      (1, 'accessibility', 'AXTextArea', 'element-1-${'x'.repeat(300)}', '${'p'.repeat(900)}'),
      (2, 'accessibility', 'AXTextArea', 'element-2-${'x'.repeat(300)}', '${'q'.repeat(850)}'),
      (3, 'accessibility', 'AXTextArea', 'element-3-${'x'.repeat(300)}', '${'r'.repeat(800)}'),
      (4, 'accessibility', 'AXButton', 'element-4-${'x'.repeat(120)}', '${'s'.repeat(200)}');`,
    `INSERT INTO ocr_text(frame_id, text, app_name, window_name) VALUES
      (1, 'terminal output duplicated terminal output duplicated', 'Terminal', 'Claude Code'),
      (2, 'terminal output duplicated terminal output duplicated', 'Terminal', 'Claude Code');`,
    `INSERT INTO frames_fts_content(full_text) VALUES
      ('fts content ${'y'.repeat(500)}'),
      ('fts content ${'z'.repeat(300)}');`
  ].join(' ');

  await mkdir(screenpipeDirectory, { recursive: true });
  await execFileAsync('sqlite3', [join(screenpipeDirectory, 'db.sqlite'), statements]);
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const task = cleanup.pop();
    if (task) {
      await task();
    }
  }
});

describe('privacy-control CLI', () => {
  it('maps status to the privacy-control MCP tool and prints a compact state summary with plaintext hotspots', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'privacy-control-cli-status-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipeDir = join(homeDir, '.screenpipe');
    await createScreenpipeFixture(screenpipeDir);

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http',
      port: 28765
    });

    const server = await startHttpServer(28765, { HOME: homeDir });
    cleanup.push(() => server.stop());

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT_PATH, 'status'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        MCP_PORT: '28765'
      }
    });

    expect(stdout).toContain('Paused: no');
    expect(stdout).toContain('Excluded apps: none');
    expect(stdout).toContain('Plaintext hotspots:');
    expect(stdout).toContain('Hotspot fields:');
    expect(stdout).toContain('Hotspot apps:');
  });

  it('maps pause and resume to MCP actions and surfaces success without unrelated content', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'privacy-control-cli-pause-resume-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http',
      port: 18766
    });

    const server = await startHttpServer(18766, { HOME: homeDir });
    cleanup.push(() => server.stop());

    const pauseResult = await execFileAsync(process.execPath, [SCRIPT_PATH, 'pause'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        MCP_PORT: '18766'
      }
    });
    const pausedStatePath = join(homeDir, '.canary-alpha-mcp', 'privacy-state.json');
    const pausedState = JSON.parse(await readFile(pausedStatePath, 'utf8')) as { paused: boolean };

    const resumeResult = await execFileAsync(process.execPath, [SCRIPT_PATH, 'resume'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        MCP_PORT: '18766'
      }
    });
    const resumedState = JSON.parse(await readFile(pausedStatePath, 'utf8')) as { paused: boolean };

    expect(pauseResult.stdout).toContain('Collection paused.');
    expect(pauseResult.stdout).not.toContain('content');
    expect(pauseResult.stdout).not.toContain('structuredContent');
    expect(pausedState.paused).toBe(true);

    expect(resumeResult.stdout).toContain('Collection resumed.');
    expect(resumeResult.stdout).not.toContain('content');
    expect(resumeResult.stdout).not.toContain('structuredContent');
    expect(resumedState.paused).toBe(false);
  });

  it('runs delete-range last_1h after explicit confirm and prints compact completion output', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'privacy-control-cli-delete-range-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http',
      port: 18771
    });

    const server = await startHttpServer(18771, { HOME: homeDir });
    cleanup.push(() => server.stop());

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT_PATH, 'delete-range', '--range', 'last_1h', '--confirm'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        MCP_PORT: '18771'
      }
    });

    const statePath = join(homeDir, '.canary-alpha-mcp', 'privacy-state.json');
    const persistedState = JSON.parse(await readFile(statePath, 'utf8')) as {
      suppressedRanges?: Array<{ from: string; to: string }>;
    };

    expect(stdout).toContain('Delete range applied: last_1h.');
    expect(stdout).not.toContain('structuredContent');
    expect(stdout).not.toContain('content');
    expect(persistedState.suppressedRanges).toHaveLength(1);
  });

  it('surfaces confirm guidance for delete-range without dumping payloads', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'privacy-control-cli-delete-range-confirm-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http',
      port: 18772
    });

    const server = await startHttpServer(18772, { HOME: homeDir });
    cleanup.push(() => server.stop());

    let error: { stdout?: string; stderr?: string; code?: number } | undefined;
    try {
      await execFileAsync(process.execPath, [SCRIPT_PATH, 'delete-range', '--range', 'last_1h'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: homeDir,
          MCP_PORT: '18772'
        }
      });
    } catch (caught) {
      error = caught as { stdout?: string; stderr?: string; code?: number };
    }

    expect(error).toBeDefined();
    expect(error?.code).toBe(1);
    expect(error?.stdout ?? '').toBe('');
    expect(error?.stderr ?? '').toContain('Delete range (last_1h) requires confirmation. Re-run with --confirm.');
    expect(error?.stderr ?? '').not.toContain('structuredContent');
    expect(error?.stderr ?? '').not.toContain('content');
    expect(error?.stderr ?? '').not.toContain('confirm=true');
  });

  it('surfaces unavailable wider delete ranges without dumping payloads', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'privacy-control-cli-delete-range-unavailable-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http',
      port: 18773
    });

    const server = await startHttpServer(18773, { HOME: homeDir });
    cleanup.push(() => server.stop());

    let error: { stdout?: string; stderr?: string; code?: number } | undefined;
    try {
      await execFileAsync(process.execPath, [SCRIPT_PATH, 'delete-range', '--range', 'last_1d', '--confirm'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: homeDir,
          MCP_PORT: '18773'
        }
      });
    } catch (caught) {
      error = caught as { stdout?: string; stderr?: string; code?: number };
    }

    expect(error).toBeDefined();
    expect(error?.code).toBe(1);
    expect(error?.stdout ?? '').toBe('');
    expect(error?.stderr ?? '').toContain('Delete range (last_1d) is unavailable in the current backend.');
    expect(error?.stderr ?? '').not.toContain('structuredContent');
    expect(error?.stderr ?? '').not.toContain('content');
  });

  it('runs rebuild-index after exclude-app --rebuild and prints compact completion output', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'privacy-control-cli-rebuild-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http',
      port: 18769
    });

    const server = await startHttpServer(18769, { HOME: homeDir });
    cleanup.push(() => server.stop());

    const fakeBinDir = join(homeDir, 'fake-bin');
    const commandsPath = join(homeDir, 'commands.log');
    await mkdir(fakeBinDir, { recursive: true });
    const npmPath = join(fakeBinDir, 'npm');
    await writeFile(npmPath, [
      '#!/bin/sh',
      `printf '%s\n' "$3" >> "${commandsPath}"`,
      'if [ "$1" = "run" ] && [ "$2" = "--silent" ] && [ "$3" = "service:stop" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "run" ] && [ "$2" = "--silent" ] && [ "$3" = "rebuild-index" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "run" ] && [ "$2" = "--silent" ] && [ "$3" = "service:start" ]; then',
      '  exit 0',
      'fi',
      'exit 1'
    ].join('\n'), 'utf8');
    await import('node:fs/promises').then(({ chmod }) => chmod(npmPath, 0o755));

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT_PATH, 'exclude-app', '--app', 'Claude', '--rebuild'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        MCP_PORT: '18769',
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`
      },
      maxBuffer: 10 * 1024 * 1024
    });

    const statePath = join(homeDir, '.canary-alpha-mcp', 'privacy-state.json');
    const persistedState = JSON.parse(await readFile(statePath, 'utf8')) as { excludedApps: string[] };
    const commands = (await readFile(commandsPath, 'utf8')).trim().split('\n').filter(Boolean);

    expect(stdout).toContain('Excluded app: Claude');
    expect(stdout).toContain('Rebuild complete.');
    expect(stdout).not.toContain('structuredContent');
    expect(stdout).not.toContain('content');
    expect(persistedState.excludedApps).toContain('Claude');
    expect(commands).toEqual(['service:stop', 'rebuild-index', 'service:start']);
  });

  it('surfaces rebuild failures after exclude-app --rebuild while preserving the exclude-app update', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'privacy-control-cli-rebuild-fail-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http',
      port: 18770
    });

    const server = await startHttpServer(18770, { HOME: homeDir });
    cleanup.push(() => server.stop());

    const fakeBinDir = join(homeDir, 'fake-bin');
    const commandsPath = join(homeDir, 'commands.log');
    await mkdir(fakeBinDir, { recursive: true });
    const npmPath = join(fakeBinDir, 'npm');
    await writeFile(npmPath, [
      '#!/bin/sh',
      `printf '%s\n' "$3" >> "${commandsPath}"`,
      'if [ "$1" = "run" ] && [ "$2" = "--silent" ] && [ "$3" = "service:stop" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "run" ] && [ "$2" = "--silent" ] && [ "$3" = "service:start" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "run" ] && [ "$2" = "--silent" ] && [ "$3" = "rebuild-index" ]; then',
      "  echo 'rebuild-index failed hard' >&2",
      '  exit 1',
      'fi',
      'exit 1'
    ].join('\n'), 'utf8');
    await import('node:fs/promises').then(({ chmod }) => chmod(npmPath, 0o755));

    let error: { stdout?: string; stderr?: string; code?: number } | undefined;
    try {
      await execFileAsync(process.execPath, [SCRIPT_PATH, 'exclude-app', '--app', 'Claude', '--rebuild'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: homeDir,
          MCP_PORT: '18770',
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`
        },
        maxBuffer: 10 * 1024 * 1024
      });
    } catch (caught) {
      error = caught as { stdout?: string; stderr?: string; code?: number };
    }

    const statePath = join(homeDir, '.canary-alpha-mcp', 'privacy-state.json');
    const persistedState = JSON.parse(await readFile(statePath, 'utf8')) as { excludedApps: string[] };
    const commands = (await readFile(commandsPath, 'utf8')).trim().split('\n').filter(Boolean);

    expect(error).toBeDefined();
    expect(error?.code).toBe(1);
    expect(error?.stderr ?? '').toContain('Excluded app: Claude');
    expect(error?.stderr ?? '').toContain('Rebuild failed: rebuild-index failed hard');
    expect(error?.stderr ?? '').not.toContain('structuredContent');
    expect(error?.stderr ?? '').not.toContain('content');
    expect(persistedState.excludedApps).toContain('Claude');
    expect(commands).toEqual(['service:stop', 'rebuild-index', 'service:start']);
  });

  it('fails fast when exclude-app is missing --app and makes no MCP call', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'privacy-control-cli-missing-app-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    let error: { stdout?: string; stderr?: string; code?: number } | undefined;
    try {
      await execFileAsync(process.execPath, [SCRIPT_PATH, 'exclude-app'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: homeDir
        }
      });
    } catch (caught) {
      error = caught as { stdout?: string; stderr?: string; code?: number };
    }

    const statePath = join(homeDir, '.canary-alpha-mcp', 'privacy-state.json');

    expect(error).toBeDefined();
    expect(error?.code).toBe(1);
    expect(error?.stdout ?? '').toBe('');
    expect(error?.stderr ?? '').toContain('Usage: npm run privacy-control -- exclude-app --app <name> [--rebuild]');
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('surfaces MCP validation responses as actionable non-zero exits without dumping payloads', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'privacy-control-cli-validation-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({ records: [] });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'http',
      port: 18768
    });

    const server = await startHttpServer(18768, { HOME: homeDir });
    cleanup.push(() => server.stop());

    let error: { stdout?: string; stderr?: string; code?: number } | undefined;
    try {
      await execFileAsync(process.execPath, [SCRIPT_PATH, 'exclude-app', '--app', '   '], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: homeDir,
          MCP_PORT: '18768'
        }
      });
    } catch (caught) {
      error = caught as { stdout?: string; stderr?: string; code?: number };
    }

    expect(error).toBeDefined();
    expect(error?.code).toBe(1);
    expect(error?.stderr ?? '').toContain('App name is required for exclude-app.');
    expect(error?.stderr ?? '').not.toContain('structuredContent');
    expect(error?.stderr ?? '').not.toContain('content');
    expect(error?.stderr ?? '').not.toContain('excludedApps');
  });
});
