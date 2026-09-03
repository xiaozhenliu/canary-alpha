import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { testTempRoot } from '../helpers/test-tmp.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(PROJECT_ROOT, 'scripts', 'resume-stack.js');
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

async function createFixture(serviceHealthy: boolean): Promise<{
  env: NodeJS.ProcessEnv;
  npmLog: string;
  screenpipeUrl: string;
}> {
  const root = await mkdtemp(join(testTempRoot(), 'resume-stack-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));

  const server = createServer((request, response) => {
    response.statusCode = request.url === '/health' ? 200 : 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start Screenpipe health stub.');
  }
  const screenpipeUrl = `http://127.0.0.1:${address.port}`;

  const appDirectory = join(root, '.computer-history-mcp');
  const binDirectory = join(root, 'bin');
  const npmLog = join(root, 'npm.log');
  await mkdir(appDirectory, { recursive: true });
  await mkdir(binDirectory, { recursive: true });
  await writeFile(join(appDirectory, 'config.yaml'), [
    'screenpipe:',
    `  url: ${screenpipeUrl}`
  ].join('\n'), 'utf8');

  const fakeNpm = join(binDirectory, 'npm');
  await writeFile(fakeNpm, [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$RESUME_NPM_LOG"',
    'if [ "$*" = "run --silent service:status" ]; then',
    `  exit ${serviceHealthy ? '0' : '1'}`,
    'fi',
    'exit 0'
  ].join('\n'), 'utf8');
  await chmod(fakeNpm, 0o755);

  return {
    npmLog,
    screenpipeUrl,
    env: {
      ...process.env,
      HOME: root,
      PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
      RESUME_NPM_LOG: npmLog
    }
  };
}

describe('resume-stack CLI', () => {
  it('reuses healthy components without build or startup commands', async () => {
    const fixture = await createFixture(true);

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT], { env: fixture.env });

    expect(stdout).toContain('Local stack is ready.');
    expect(stdout).toContain('MCP service: reused');
    expect(stdout).toContain(`Screenpipe: reused (${fixture.screenpipeUrl})`);
    expect((await readFile(fixture.npmLog, 'utf8')).trim().split('\n')).toEqual([
      'run --silent service:status'
    ]);
  });

  it('starts only the managed service when Screenpipe is healthy', async () => {
    const fixture = await createFixture(false);

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT], { env: fixture.env });

    expect(stdout).toContain('MCP service: started');
    expect(stdout).toContain('Screenpipe: reused');
    expect((await readFile(fixture.npmLog, 'utf8')).trim().split('\n')).toEqual([
      'run --silent service:status',
      'run --silent service:start'
    ]);
  });
});
