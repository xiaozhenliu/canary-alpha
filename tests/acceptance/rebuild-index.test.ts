import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { connectHttpClient, connectStdioClient } from '../helpers/mcp-client.js';
import { startEmbeddingStub } from '../helpers/embedding-stub.js';
import { startScreenpipeStub } from '../helpers/screenpipe-stub.js';
import { writeTestConfig } from '../helpers/test-config.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const execFileAsync = promisify(execFile);

async function reserveFreePort(): Promise<number> {
  const server = createNetServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to reserve a TCP port for rebuild-index acceptance test.');
  }

  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  return port;
}

describe('rebuild-index acceptance', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    delete process.env.HOME;

    while (cleanup.length > 0) {
      const task = cleanup.pop();
      if (task) {
        await task();
      }
    }
  });

  it('preserves the existing retrieval state when rebuild-index fails before recovery completes', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-preserve-on-failure-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const retrievalStateDir = join(homeDir, 'retrieval-state');
    await mkdir(retrievalStateDir, { recursive: true });

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'rebuild-fixture-1',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub({ fail: true });
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      vectorStorePath: retrievalStateDir
    });

    const checkpointPath = join(retrievalStateDir, 'retrieval-checkpoint.json');
    const vectorStorePath = join(retrievalStateDir, 'vector-store.json');

    const checkpointBefore = JSON.stringify({
      cursor: 'existing-record',
      timestamp: '2026-04-13T08:00:00.000Z'
    }, null, 2);
    const vectorStoreBefore = JSON.stringify({
      records: [
        {
          id: 'existing-record',
          text: 'Existing semantic note',
          timestamp: '2026-04-13T08:00:00.000Z',
          appName: 'Claude',
          embedding: [1, 0, 0]
        }
      ]
    }, null, 2);

    await writeFile(checkpointPath, checkpointBefore, 'utf8');
    await writeFile(vectorStorePath, vectorStoreBefore, 'utf8');

    await expect(execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    })).rejects.toThrow();

    expect(await readFile(checkpointPath, 'utf8')).toBe(checkpointBefore);
    expect(await readFile(vectorStorePath, 'utf8')).toBe(vectorStoreBefore);
  });

  it('reports needs-rebuild in the rebuild summary when no historical records exist to recover', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-empty-history-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const retrievalStateDir = join(homeDir, 'retrieval-state');
    await mkdir(retrievalStateDir, { recursive: true });

    const screenpipe = await startScreenpipeStub({
      records: []
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      vectorStorePath: retrievalStateDir
    });

    const rebuild = await execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    const summary = JSON.parse(rebuild.stdout) as {
      command: string;
      reset: string[];
      fetched: number;
      indexed: number;
      checkpointBefore: string;
      checkpointAfter: string;
      recoveryStatus: string;
    };

    expect(summary.command).toBe('rebuild-index');
    expect(summary.reset).toEqual(['vector-store.json', 'retrieval-checkpoint.json']);
    expect(summary.fetched).toBe(0);
    expect(summary.indexed).toBe(0);
    expect(summary.checkpointBefore).toBe('none');
    expect(summary.checkpointAfter).toBe('none');
    expect(summary.recoveryStatus).toBe('needs-rebuild');
  });

  it('reports ready in the rebuild summary when recovery succeeds with an intentionally empty vector store', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-empty-but-valid-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const retrievalStateDir = join(homeDir, 'retrieval-state');
    await mkdir(retrievalStateDir, { recursive: true });
    await mkdir(join(homeDir, '.canary-alpha-mcp'), { recursive: true });

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'excluded-recovery-record',
          text: 'Recovery record excluded by privacy policy',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      vectorStorePath: retrievalStateDir
    });

    await writeFile(
      join(homeDir, '.canary-alpha-mcp', 'privacy-state.json'),
      JSON.stringify({ paused: false, excludedApps: ['Claude'], suppressedRanges: [] }, null, 2),
      'utf8'
    );

    const rebuild = await execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    const summary = JSON.parse(rebuild.stdout) as {
      fetched: number;
      indexed: number;
      recoveryStatus: string;
    };

    expect(summary.fetched).toBe(1);
    expect(summary.indexed).toBe(0);
    expect(summary.recoveryStatus).toBe('ready');
  });

  it('replaces only retrieval artifacts when using the default app-home storage directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-default-app-home-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const appDir = join(homeDir, '.canary-alpha-mcp');
    const memoryDir = join(appDir, 'memory');
    await mkdir(memoryDir, { recursive: true });

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'default-home-record',
          text: 'Recovered default app home record',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    const configPath = await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio'
    });

    const privacyStatePath = join(appDir, 'privacy-state.json');
    const memoryPath = join(memoryDir, 'memory.md');
    const userMemoryPath = join(memoryDir, 'user.md');
    const sentinelPath = join(appDir, 'sentinel.json');
    const checkpointPath = join(appDir, 'retrieval-checkpoint.json');
    const vectorStorePath = join(appDir, 'vector-store.json');

    await writeFile(privacyStatePath, JSON.stringify({ paused: false, excludedApps: ['Mail'] }, null, 2), 'utf8');
    await writeFile(memoryPath, '# durable memory\n', 'utf8');
    await writeFile(userMemoryPath, '# durable user memory\n', 'utf8');
    await writeFile(sentinelPath, JSON.stringify({ keep: true }, null, 2), 'utf8');
    await writeFile(checkpointPath, JSON.stringify({
      cursor: 'stale-checkpoint',
      timestamp: '2026-04-13T08:00:00.000Z'
    }, null, 2), 'utf8');
    await writeFile(vectorStorePath, '{"records":[', 'utf8');

    const configBefore = await readFile(configPath, 'utf8');
    const privacyBefore = await readFile(privacyStatePath, 'utf8');
    const memoryBefore = await readFile(memoryPath, 'utf8');
    const userMemoryBefore = await readFile(userMemoryPath, 'utf8');
    const sentinelBefore = await readFile(sentinelPath, 'utf8');

    const rebuild = await execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    const summary = JSON.parse(rebuild.stdout) as {
      fetched: number;
      indexed: number;
      recoveryStatus: string;
    };

    expect(summary.fetched).toBe(1);
    expect(summary.indexed).toBe(1);
    expect(summary.recoveryStatus).toBe('ready');

    expect(await readFile(configPath, 'utf8')).toBe(configBefore);
    expect(await readFile(privacyStatePath, 'utf8')).toBe(privacyBefore);
    expect(await readFile(memoryPath, 'utf8')).toBe(memoryBefore);
    expect(await readFile(userMemoryPath, 'utf8')).toBe(userMemoryBefore);
    expect(await readFile(sentinelPath, 'utf8')).toBe(sentinelBefore);

    const rebuiltCheckpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
      cursor: string;
      timestamp: string;
    };
    const rebuiltVectorStore = JSON.parse(await readFile(vectorStorePath, 'utf8')) as {
      records: Array<{ id: string }>;
    };

    expect(rebuiltCheckpoint).toEqual({
      cursor: 'default-home-record',
      timestamp: '2026-04-13T09:00:00.000Z'
    });
    expect(rebuiltVectorStore.records.map((record) => record.id)).toEqual(['default-home-record']);
  });

  it('accumulates fetched and indexed totals across multiple rebuild passes', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-multi-pass-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const retrievalStateDir = join(homeDir, 'retrieval-state');
    await mkdir(retrievalStateDir, { recursive: true });

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'rebuild-fixture-1',
          text: 'Recovered semantic retrieval fixture one',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'rebuild-fixture-2',
          text: 'Recovered semantic retrieval fixture two',
          timestamp: '2026-04-13T09:01:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'rebuild-fixture-3',
          text: 'Recovered semantic retrieval fixture three',
          timestamp: '2026-04-13T09:02:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      vectorStorePath: retrievalStateDir,
      maxCatchUpBatches: 1,
      maxCatchUpRecords: 1
    });

    const rebuild = await execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    const summary = JSON.parse(rebuild.stdout) as {
      fetched: number;
      indexed: number;
      checkpointBefore: string;
      checkpointAfter: string;
      recoveryStatus: string;
    };

    expect(summary.fetched).toBe(3);
    expect(summary.indexed).toBe(3);
    expect(summary.checkpointBefore).toBe('none');
    expect(summary.checkpointAfter).toContain('2026-04-13T09:02:00.000Z');
    expect(summary.recoveryStatus).toBe('ready');
  });

  it('fails rebuild-index instead of skipping records when a forced backlog page has embedding omissions', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-partial-embedding-failure-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const retrievalStateDir = join(homeDir, 'retrieval-state');
    await mkdir(retrievalStateDir, { recursive: true });

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'rebuild-fixture-1',
          text: 'Good rebuild fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        },
        {
          id: 'rebuild-fixture-2',
          text: 'Bad rebuild fixture',
          timestamp: '2026-04-13T09:01:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub({
      failOnInputs: ['Bad rebuild fixture']
    });
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      vectorStorePath: retrievalStateDir,
      maxCatchUpBatches: 1,
      maxCatchUpRecords: 2
    });

    const checkpointPath = join(retrievalStateDir, 'retrieval-checkpoint.json');
    const vectorStorePath = join(retrievalStateDir, 'vector-store.json');
    const checkpointBefore = JSON.stringify({
      cursor: 'existing-record',
      timestamp: '2026-04-13T08:00:00.000Z'
    }, null, 2);
    const vectorStoreBefore = JSON.stringify({
      records: [
        {
          id: 'existing-record',
          text: 'Existing semantic note',
          timestamp: '2026-04-13T08:00:00.000Z',
          appName: 'Claude',
          embedding: [1, 0, 0]
        }
      ]
    }, null, 2);

    await writeFile(checkpointPath, checkpointBefore, 'utf8');
    await writeFile(vectorStorePath, vectorStoreBefore, 'utf8');

    await expect(execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    })).rejects.toThrow('rebuild-index detected embedding failures while rebuilding backlog page at offset 0');

    expect(await readFile(checkpointPath, 'utf8')).toBe(checkpointBefore);
    expect(await readFile(vectorStorePath, 'utf8')).toBe(vectorStoreBefore);
  });

  it('refuses to rebuild while a live stdio server process shares the same retrieval artifacts', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-live-stdio-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'live-stdio-record',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio'
    });

    const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--mode', 'stdio'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    cleanup.push(async () => {
      if (server.exitCode !== null || server.killed) {
        return;
      }

      server.kill('SIGTERM');
      await once(server, 'exit');
    });
    server.stderr?.on('data', () => {
      // Keep stderr drained during test.
    });

    const runtimeDir = join(homeDir, '.canary-alpha-mcp', 'runtime-processes');
    const startedAt = Date.now();
    let runtimeMarkers: string[] = [];
    while (Date.now() - startedAt < 10_000) {
      try {
        runtimeMarkers = await readdir(runtimeDir);
        if (runtimeMarkers.length > 0) {
          break;
        }
      } catch {
        // Marker directory not ready yet.
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(runtimeMarkers.length).toBeGreaterThan(0);

    await expect(execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    })).rejects.toThrow('Refusing to run rebuild-index while live MCP server processes are active');
  });

  it('refuses to rebuild when another install shares the same retrieval artifacts directory', async () => {
    const sharedRetrievalDir = await mkdtemp(join(tmpdir(), 'rebuild-index-shared-retrieval-'));
    cleanup.push(() => rm(sharedRetrievalDir, { recursive: true, force: true }));

    const serverHomeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-shared-server-home-'));
    cleanup.push(() => rm(serverHomeDir, { recursive: true, force: true }));

    const rebuildHomeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-shared-rebuild-home-'));
    cleanup.push(() => rm(rebuildHomeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'shared-retrieval-record',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(serverHomeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      vectorStorePath: sharedRetrievalDir
    });

    await writeTestConfig(rebuildHomeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      vectorStorePath: sharedRetrievalDir
    });

    const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--mode', 'stdio'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: serverHomeDir
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    cleanup.push(async () => {
      if (server.exitCode !== null || server.killed) {
        return;
      }

      server.kill('SIGTERM');
      await once(server, 'exit');
    });
    server.stderr?.on('data', () => {
      // Keep stderr drained during test.
    });

    const runtimeDir = join(sharedRetrievalDir, 'runtime-processes');
    const startedAt = Date.now();
    let runtimeMarkers: string[] = [];
    while (Date.now() - startedAt < 10_000) {
      try {
        runtimeMarkers = await readdir(runtimeDir);
        if (runtimeMarkers.length > 0) {
          break;
        }
      } catch {
        // Marker directory not ready yet.
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(runtimeMarkers.length).toBeGreaterThan(0);

    await expect(execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: rebuildHomeDir
      }
    })).rejects.toThrow('Refusing to run rebuild-index while live MCP server processes are active for retrieval artifacts at');
  });

  it('refuses to rebuild while a markerless stdio server started without --mode is still active for the same config', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-markerless-stdio-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'markerless-stdio-record',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio'
    });

    const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    cleanup.push(async () => {
      if (server.exitCode !== null || server.killed) {
        return;
      }

      server.kill('SIGTERM');
      await once(server, 'exit');
    });
    server.stderr?.on('data', () => {
      // Keep stderr drained during test.
    });

    const runtimeDir = join(homeDir, '.canary-alpha-mcp', 'runtime-processes');
    const startedAt = Date.now();
    let runtimeMarkers: string[] = [];
    while (Date.now() - startedAt < 10_000) {
      try {
        runtimeMarkers = await readdir(runtimeDir);
        if (runtimeMarkers.length > 0) {
          break;
        }
      } catch {
        // Marker directory not ready yet.
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(runtimeMarkers.length).toBeGreaterThan(0);
    await Promise.all(runtimeMarkers.map((fileName) => rm(join(runtimeDir, fileName), { force: true })));

    await expect(execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    })).rejects.toThrow('Refusing to run rebuild-index while legacy MCP server processes are active');
  });

  it('refuses to rebuild while a markerless process started from the built entrypoint is still active for the same config', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-markerless-built-entrypoint-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'markerless-built-entrypoint-record',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      port: 8765
    });

    const server = spawn('bash', ['-lc', `exec -a 'HOME=${homeDir} dist/src/index.js --mode http' sleep 30`], {
      cwd: PROJECT_ROOT,
      stdio: 'ignore'
    });
    cleanup.push(async () => {
      if (server.exitCode !== null || server.killed) {
        return;
      }

      server.kill('SIGTERM');
      await once(server, 'exit');
    });

    await expect(execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    })).rejects.toThrow('Refusing to run rebuild-index while legacy MCP server processes are active');
  });

  it('refuses to rebuild while a markerless legacy process uses an equivalent retrieval path spelling', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-markerless-normalized-path-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const retrievalStateDir = join(homeDir, 'retrieval-state');
    await mkdir(retrievalStateDir, { recursive: true });

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'markerless-normalized-path-record',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      vectorStorePath: `${retrievalStateDir}/`
    });

    const server = spawn('bash', ['-lc', `exec -a 'HOME=${homeDir} src/index.ts --mode stdio' sleep 30`], {
      cwd: PROJECT_ROOT,
      stdio: 'ignore'
    });
    cleanup.push(async () => {
      if (server.exitCode !== null || server.killed) {
        return;
      }

      server.kill('SIGTERM');
      await once(server, 'exit');
    });

    await expect(execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    })).rejects.toThrow('Refusing to run rebuild-index while legacy MCP server processes are active');
  });

  it('refuses to rebuild when a markerless tsx server uses --tsconfig before the entrypoint', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-markerless-tsx-tsconfig-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'markerless-tsx-tsconfig-record',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio'
    });

    const server = spawn('bash', ['-lc', `exec -a 'HOME=${homeDir} tsx --tsconfig tsconfig.json src/index.ts --mode stdio' sleep 30`], {
      cwd: PROJECT_ROOT,
      stdio: 'ignore'
    });
    cleanup.push(async () => {
      if (server.exitCode !== null || server.killed) {
        return;
      }

      server.kill('SIGTERM');
      await once(server, 'exit');
    });

    await expect(execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    })).rejects.toThrow('Refusing to run rebuild-index while legacy MCP server processes are active');
  });

  it('ignores unrelated commands that only mention src/index.ts in argv', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-non-entrypoint-argv-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'non-entrypoint-argv-record',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio'
    });

    const unrelatedProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'src/index.ts'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      },
      stdio: 'ignore'
    });
    cleanup.push(async () => {
      if (unrelatedProcess.exitCode !== null || unrelatedProcess.killed) {
        return;
      }

      unrelatedProcess.kill('SIGTERM');
      await once(unrelatedProcess, 'exit');
    });

    const rebuild = await execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    const summary = JSON.parse(rebuild.stdout) as {
      command: string;
      fetched: number;
      indexed: number;
      recoveryStatus: string;
    };

    expect(summary.command).toBe('rebuild-index');
    expect(summary.fetched).toBe(1);
    expect(summary.indexed).toBe(1);
    expect(summary.recoveryStatus).toBe('ready');
  });

  it('refuses to rebuild while a markerless HTTP server process is still active for the same config', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-markerless-http-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const managedPort = await reserveFreePort();

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'markerless-http-record',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      port: 8765
    });

    const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--mode', 'http'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        MCP_PORT: String(managedPort)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    cleanup.push(async () => {
      if (server.exitCode !== null || server.killed) {
        return;
      }

      server.kill('SIGTERM');
      await once(server, 'exit');
    });
    let stderr = '';
    server.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const runtimeDir = join(homeDir, '.canary-alpha-mcp', 'runtime-processes');
    const startedAt = Date.now();
    let runtimeMarkers: string[] = [];
    while (Date.now() - startedAt < 10_000) {
      if (server.exitCode !== null) {
        throw new Error(`Markerless HTTP fixture exited before readiness: ${stderr || '(no stderr)'}`);
      }

      try {
        runtimeMarkers = await readdir(runtimeDir);
        if (runtimeMarkers.length > 0) {
          break;
        }
      } catch {
        // Marker directory not ready yet.
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(runtimeMarkers.length).toBeGreaterThan(0);
    await Promise.all(runtimeMarkers.map((fileName) => rm(join(runtimeDir, fileName), { force: true })));

    const httpConnection = await connectHttpClient(managedPort);
    cleanup.push(() => httpConnection.close());
    await httpConnection.client.callTool({
      name: 'internal-status',
      arguments: {}
    });

    await expect(execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    })).rejects.toThrow('Refusing to run rebuild-index while legacy MCP server processes are active');
  });

  it('ignores stale runtime markers whose pid has been recycled by another process', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-stale-runtime-marker-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const retrievalStateDir = join(homeDir, 'retrieval-state');
    await mkdir(retrievalStateDir, { recursive: true });

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'stale-runtime-marker-record',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      vectorStorePath: retrievalStateDir
    });

    const runtimeDir = join(retrievalStateDir, 'runtime-processes');
    await mkdir(runtimeDir, { recursive: true });
    const staleMarkerPath = join(runtimeDir, `${process.pid}.json`);
    await writeFile(staleMarkerPath, JSON.stringify({
      pid: process.pid,
      mode: 'stdio',
      configFile: join(homeDir, '.canary-alpha-mcp', 'config.yaml'),
      registeredAt: '2000-01-01T00:00:00.000Z'
    }, null, 2), 'utf8');

    const rebuild = await execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    expect(rebuild.stdout).toContain('"command": "rebuild-index"');
    await expect(readFile(staleMarkerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores stale rebuild locks whose pid has been recycled by another process', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-stale-rebuild-lock-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const retrievalStateDir = await mkdtemp(join(tmpdir(), 'rebuild-index-stale-rebuild-lock-store-'));
    cleanup.push(() => rm(retrievalStateDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'stale-rebuild-lock-record',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      vectorStorePath: retrievalStateDir
    });

    const lockPath = join(retrievalStateDir, 'rebuild-index.lock');
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      configFile: join(homeDir, '.canary-alpha-mcp', 'config.yaml'),
      lockedAt: '2000-01-01T00:00:00.000Z'
    }, null, 2), 'utf8');

    const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--mode', 'stdio'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    cleanup.push(async () => {
      if (server.exitCode !== null || server.killed) {
        return;
      }

      server.kill('SIGTERM');
      await once(server, 'exit');
    });
    let stderr = '';
    server.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const runtimeDir = join(retrievalStateDir, 'runtime-processes');
    const startedAt = Date.now();
    let runtimeMarkers: string[] = [];
    while (Date.now() - startedAt < 10_000) {
      if (server.exitCode !== null) {
        throw new Error(`Stale rebuild lock fixture exited before readiness: ${stderr || '(no stderr)'}`);
      }

      try {
        runtimeMarkers = await readdir(runtimeDir);
        if (runtimeMarkers.length > 0) {
          break;
        }
      } catch {
        // Marker directory not ready yet.
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(runtimeMarkers.length).toBeGreaterThan(0);
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks new server startup while rebuild-index holds the recovery lock', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-lock-guard-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const retrievalStateDir = await mkdtemp(join(tmpdir(), 'rebuild-index-lock-guard-store-'));
    cleanup.push(() => rm(retrievalStateDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'lock-guard-record',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ],
      fail: false
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub({ delayMs: 1500 });
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      vectorStorePath: retrievalStateDir
    });

    const rebuildTask = execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    const lockPath = join(retrievalStateDir, 'rebuild-index.lock');
    const lockStartedAt = Date.now();
    let lockPresent = false;
    while (Date.now() - lockStartedAt < 10_000) {
      try {
        await readFile(lockPath, 'utf8');
        lockPresent = true;
        break;
      } catch {
        // Lock not ready yet.
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(lockPresent).toBe(true);

    const blockedServer = spawn('npx', ['tsx', 'src/index.ts', '--mode', 'stdio'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    blockedServer.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const [exitCode] = await once(blockedServer, 'exit') as [number | null];
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Refusing to start MCP server while rebuild-index is active');

    await expect(rebuildTask).resolves.toMatchObject({
      stdout: expect.stringContaining('"command": "rebuild-index"')
    });
  });

  it('refuses to replace rebuilt artifacts when a markerless legacy server starts after the initial offline check', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-late-legacy-start-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const retrievalStateDir = await mkdtemp(join(tmpdir(), 'rebuild-index-late-legacy-start-store-'));
    cleanup.push(() => rm(retrievalStateDir, { recursive: true, force: true }));

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'late-legacy-start-record',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub({ delayMs: 1500 });
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      vectorStorePath: retrievalStateDir
    });

    const vectorStorePath = join(retrievalStateDir, 'vector-store.json');
    const checkpointPath = join(retrievalStateDir, 'retrieval-checkpoint.json');
    const vectorStoreBefore = JSON.stringify({
      records: [
        {
          id: 'existing-record',
          text: 'Existing semantic note',
          timestamp: '2026-04-13T08:00:00.000Z',
          appName: 'Claude',
          embedding: [1, 0, 0]
        }
      ]
    }, null, 2);
    const checkpointBefore = JSON.stringify({
      cursor: 'existing-record',
      timestamp: '2026-04-13T08:00:00.000Z'
    }, null, 2);
    await writeFile(vectorStorePath, vectorStoreBefore, 'utf8');
    await writeFile(checkpointPath, checkpointBefore, 'utf8');

    const rebuildTask = execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    const rebuildTempPrefix = `.rebuild-index-`;
    const rebuildStartedAt = Date.now();
    let rebuildTempReady = false;
    while (Date.now() - rebuildStartedAt < 10_000) {
      try {
        const entries = await readdir(retrievalStateDir);
        if (entries.some((entry) => entry.startsWith(rebuildTempPrefix))) {
          rebuildTempReady = true;
          break;
        }
      } catch {
        // Rebuild workspace not ready yet.
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(rebuildTempReady).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 250));

    const legacyServer = spawn('bash', ['-lc', `exec -a 'HOME=${homeDir} src/index.ts --mode stdio' sleep 30`], {
      cwd: PROJECT_ROOT,
      stdio: 'ignore'
    });
    cleanup.push(async () => {
      if (legacyServer.exitCode !== null || legacyServer.killed) {
        return;
      }

      legacyServer.kill('SIGTERM');
      await once(legacyServer, 'exit');
    });

    await expect(rebuildTask).rejects.toThrow('Refusing to run rebuild-index while legacy MCP server processes are active');
    expect(await readFile(vectorStorePath, 'utf8')).toBe(vectorStoreBefore);
    expect(await readFile(checkpointPath, 'utf8')).toBe(checkpointBefore);
  });

  it('refuses to rebuild while a frozen managed HTTP service is actively serving the same config', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-live-service-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const managedPort = await reserveFreePort();

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'live-service-record',
          text: 'Recovered semantic retrieval fixture',
          timestamp: '2026-04-13T09:00:00.000Z',
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      port: 8765
    });

    const launchAgentsDir = join(homeDir, 'Library', 'LaunchAgents');
    await mkdir(launchAgentsDir, { recursive: true });
    await writeFile(join(launchAgentsDir, 'com.canary-alpha-mcp.plist'), [
      '<plist>',
      '  <dict>',
      '    <key>EnvironmentVariables</key>',
      '    <dict>',
      '      <key>SCREENPIPE_MEMORY_MCP_SERVER_HOST</key>',
      '      <string>127.0.0.1</string>',
      '      <key>SCREENPIPE_MEMORY_MCP_SERVER_PORT</key>',
      `      <string>${managedPort}</string>`,
      '    </dict>',
      '  </dict>',
      '</plist>'
    ].join('\n'), 'utf8');

    const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--mode', 'http'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        MCP_PORT: String(managedPort)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    cleanup.push(async () => {
      if (server.exitCode !== null || server.killed) {
        return;
      }

      server.kill('SIGTERM');
      await once(server, 'exit');
    });
    let stderr = '';
    server.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < 10_000) {
      if (server.exitCode !== null) {
        throw new Error(`Managed HTTP fixture exited before readiness: ${stderr || '(no stderr)'}`);
      }

      try {
        const response = await fetch(`http://127.0.0.1:${managedPort}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'health-check', method: 'ping' })
        });

        if (response.status >= 400) {
          break;
        }
      } catch {
        // Server not ready yet.
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const httpConnection = await connectHttpClient(managedPort);
    cleanup.push(() => httpConnection.close());
    const statusResult = await httpConnection.client.callTool({
      name: 'internal-status',
      arguments: {}
    });
    const structured = statusResult.structuredContent as {
      pid: number;
      configFile: string;
      mode: string;
      port: number;
    };

    expect(structured.pid).toBe(server.pid);
    expect(structured.mode).toBe('http');
    expect(structured.port).toBe(managedPort);
    expect(structured.configFile).toBe(join(homeDir, '.canary-alpha-mcp', 'config.yaml'));

    await expect(execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    })).rejects.toThrow(/Refusing to run rebuild-index while (live MCP server processes are active|the managed HTTP service is active)/);
  });

  it('reports needs-rebuild before recovery when the checkpoint exists but the vector store is missing, then rebuilds full older history', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'rebuild-index-acceptance-'));
    cleanup.push(() => rm(homeDir, { recursive: true, force: true }));

    const appDir = join(homeDir, '.canary-alpha-mcp');
    const retrievalStateDir = join(homeDir, 'retrieval-state');
    const memoryDir = join(appDir, 'memory');
    const fixtureTimestamp = '2026-04-13T09:00:00.000Z';

    await mkdir(memoryDir, { recursive: true });
    await mkdir(retrievalStateDir, { recursive: true });

    const screenpipe = await startScreenpipeStub({
      records: [
        {
          id: 'rebuild-fixture-1',
          text: 'Recovered semantic retrieval fixture',
          timestamp: fixtureTimestamp,
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => screenpipe.stop());

    const embedding = await startEmbeddingStub();
    cleanup.push(() => embedding.stop());

    const configPath = await writeTestConfig(homeDir, {
      embeddingBaseUrl: embedding.url,
      screenpipeBaseUrl: screenpipe.url,
      mode: 'stdio',
      vectorStorePath: retrievalStateDir
    });

    const privacyStatePath = join(appDir, 'privacy-state.json');
    const memoryPath = join(memoryDir, 'memory.md');
    const userMemoryPath = join(memoryDir, 'user.md');
    const sentinelPath = join(appDir, 'sentinel.json');
    const checkpointPath = join(retrievalStateDir, 'retrieval-checkpoint.json');
    const vectorStorePath = join(retrievalStateDir, 'vector-store.json');

    await writeFile(privacyStatePath, JSON.stringify({ paused: false, excludedApps: ['Mail'] }, null, 2), 'utf8');
    await writeFile(memoryPath, '# durable memory\n', 'utf8');
    await writeFile(userMemoryPath, '# durable user memory\n', 'utf8');
    await writeFile(sentinelPath, JSON.stringify({ keep: true }, null, 2), 'utf8');
    await writeFile(checkpointPath, JSON.stringify({
      cursor: 'stale-checkpoint',
      timestamp: '2026-04-13T08:00:00.000Z'
    }, null, 2), 'utf8');

    const configBefore = await readFile(configPath, 'utf8');
    const privacyBefore = await readFile(privacyStatePath, 'utf8');
    const memoryBefore = await readFile(memoryPath, 'utf8');
    const userMemoryBefore = await readFile(userMemoryPath, 'utf8');
    const sentinelBefore = await readFile(sentinelPath, 'utf8');

    const beforeRecovery = await connectStdioClient({
      HOME: homeDir
    });
    cleanup.push(() => beforeRecovery.close());

    const beforeStatusResult = await beforeRecovery.client.callTool({
      name: 'internal-status',
      arguments: {}
    });
    const beforeStatus = beforeStatusResult.structuredContent as {
      retrieval: {
        checkpointExists: boolean;
        checkpointTimestamp?: string;
        vectorStoreKind: string;
        recoveryStatus: string;
      };
    };

    expect(beforeStatus.retrieval.checkpointExists).toBe(true);
    expect(beforeStatus.retrieval.recoveryStatus).toBe('needs-rebuild');

    await beforeRecovery.close();

    await writeFile(vectorStorePath, '{"records":[', 'utf8');
    await writeFile(checkpointPath, '{"cursor":', 'utf8');

    const rebuild = await execFileAsync('npm', ['run', '--silent', 'rebuild-index'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir
      }
    });

    const summary = JSON.parse(rebuild.stdout) as {
      command: string;
      reset: string[];
      fetched: number;
      indexed: number;
      checkpointBefore: string;
      checkpointAfter: string;
      recoveryStatus: string;
    };

    expect(summary.command).toBe('rebuild-index');
    expect(summary.reset).toEqual(['vector-store.json', 'retrieval-checkpoint.json']);
    expect(summary.fetched).toBe(1);
    expect(summary.indexed).toBe(1);
    expect(summary.checkpointBefore).toBe('none');
    expect(summary.checkpointAfter).toContain(fixtureTimestamp);
    expect(summary.recoveryStatus).toBe('ready');

    expect(await readFile(configPath, 'utf8')).toBe(configBefore);
    expect(await readFile(privacyStatePath, 'utf8')).toBe(privacyBefore);
    expect(await readFile(memoryPath, 'utf8')).toBe(memoryBefore);
    expect(await readFile(userMemoryPath, 'utf8')).toBe(userMemoryBefore);
    expect(await readFile(sentinelPath, 'utf8')).toBe(sentinelBefore);

    const rebuiltCheckpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
      cursor: string;
      timestamp: string;
    };
    const rebuiltVectorStore = JSON.parse(await readFile(vectorStorePath, 'utf8')) as {
      records: Array<{ id: string; text: string }>;
    };

    expect(rebuiltCheckpoint).toEqual({
      cursor: 'rebuild-fixture-1',
      timestamp: fixtureTimestamp
    });
    expect(rebuiltVectorStore.records.map((record) => record.id)).toEqual(['rebuild-fixture-1']);

    const connection = await connectStdioClient({
      HOME: homeDir
    });
    cleanup.push(() => connection.close());

    const statusResult = await connection.client.callTool({
      name: 'internal-status',
      arguments: {}
    });
    const statusStructured = statusResult.structuredContent as {
      retrieval: {
        checkpointExists: boolean;
        checkpointTimestamp?: string;
        vectorStoreKind: string;
        recoveryStatus: string;
      };
    };

    expect(statusStructured.retrieval.checkpointExists).toBe(true);
    expect(statusStructured.retrieval.checkpointTimestamp).toBe(fixtureTimestamp);
    expect(statusStructured.retrieval.vectorStoreKind).toBe('chroma');
    expect(statusStructured.retrieval.recoveryStatus).toBe('ready');

    const searchResult = await connection.client.callTool({
      name: 'search-screen',
      arguments: {
        query: 'recovered semantic retrieval fixture',
        mode: 'semantic'
      }
    });
    const searchStructured = searchResult.structuredContent as {
      degraded?: unknown;
      evidence: Array<{ id: string; source: string }>;
      error?: unknown;
    };

    expect(searchStructured.error).toBeUndefined();
    expect(searchStructured.degraded).toBeUndefined();
    expect(searchStructured.evidence).toHaveLength(1);
    expect(searchStructured.evidence[0]).toMatchObject({
      id: 'rebuild-fixture-1',
      source: 'semantic'
    });
  });
});
