import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../../../src/lib/logging.js';
import { FileMemoryStore } from '../../../src/services/memory/memory-store.js';
import { FilePrivacyStore } from '../../../src/services/privacy/privacy-store.js';
import { FileCheckpointStore } from '../../../src/services/retrieval/checkpoint-store.js';
import { FileRoutineStore } from '../../../src/services/routines/routine-store.js';
import { backupConfigIfPresent, ensureAppDirectories, resolveAppPaths, writeConfigYamlFile } from '../../../scripts/onboarding-config.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

function permissionBits(pathStat: { mode: number }): number {
  return pathStat.mode & 0o777;
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error(`Timed out waiting for file: ${path}`);
}

describe('private file permissions', () => {
  it('writes memory and privacy state with private file and directory modes', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'private-memory-'));

    try {
      const memoryPath = join(root, 'memory', 'memory.md');
      const privacyPath = join(root, 'privacy', 'privacy-state.json');

      const memoryStore = new FileMemoryStore({
        memory: memoryPath,
        user: join(root, 'memory', 'user.md')
      });
      const privacyStore = new FilePrivacyStore(privacyPath);

      await memoryStore.write('memory', 'secret memory');
      await privacyStore.write({ paused: false, excludedApps: [] });

      expect(permissionBits(await stat(join(root, 'memory')))).toBe(0o700);
      expect(permissionBits(await stat(memoryPath))).toBe(0o600);
      expect(permissionBits(await stat(join(root, 'privacy')))).toBe(0o700);
      expect(permissionBits(await stat(privacyPath))).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes retrieval checkpoints and routine files with private modes', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'private-retrieval-'));

    try {
      const checkpointPath = join(root, 'retrieval', 'checkpoint.json');
      const definitionsDirectory = join(root, 'routines', 'definitions');
      const historyDirectory = join(root, 'routines', 'history');

      const checkpointStore = new FileCheckpointStore(checkpointPath);
      const routineStore = new FileRoutineStore({ definitionsDirectory, historyDirectory });

      await checkpointStore.writeLatest({
        cursor: 'cursor-1',
        timestamp: '2026-06-08T00:00:00.000Z'
      });
      await routineStore.writeDefinition({
        name: 'daily summary',
        schedule: '0 9 * * *',
        enabled: true,
        kind: 'daily_summary',
        prompt: 'Summarize recent work',
        recentActivityMinutes: 60,
        createdAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-08T00:00:00.000Z'
      });
      await routineStore.appendRun({
        runId: 'run-1',
        name: 'daily summary',
        startedAt: '2026-06-08T00:00:00.000Z',
        completedAt: '2026-06-08T00:05:00.000Z',
        status: 'success',
        summary: 'ok',
        output: 'done'
      });

      expect(permissionBits(await stat(join(root, 'retrieval')))).toBe(0o700);
      expect(permissionBits(await stat(checkpointPath))).toBe(0o600);
      expect(permissionBits(await stat(definitionsDirectory))).toBe(0o700);
      expect(permissionBits(await stat(historyDirectory))).toBe(0o700);
      expect(permissionBits(await stat(join(definitionsDirectory, 'daily-summary.json')))).toBe(0o600);
      expect(permissionBits(await stat(join(historyDirectory, 'daily-summary.json')))).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes service log files with private modes', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'private-logs-'));

    try {
      const logPath = join(root, 'logs', 'service.log');
      const logger = createLogger('info', {
        filePath: logPath,
        writeToStderr: false
      });

      logger.info('sensitive log line');
      await waitForFile(logPath);

      expect(permissionBits(await stat(join(root, 'logs')))).toBe(0o700);
      expect(permissionBits(await stat(logPath))).toBe(0o600);
      expect(await readFile(logPath, 'utf8')).toContain('sensitive log line');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes onboarding config, backups, and app directories with private modes', async () => {
    const homeDir = await mkdtemp(join(testTempRoot(), 'private-onboard-'));

    try {
      const paths = resolveAppPaths(homeDir);
      await ensureAppDirectories(paths);

      expect(permissionBits(await stat(paths.appDirectory))).toBe(0o700);
      expect(permissionBits(await stat(paths.logDirectory))).toBe(0o700);
      expect(permissionBits(await stat(paths.routinesDefinitionsDirectory))).toBe(0o700);
      expect(permissionBits(await stat(paths.routinesHistoryDirectory))).toBe(0o700);

      await writeConfigYamlFile(paths.configPath, {
        authToken: 'config-secret'
      });
      expect(permissionBits(await stat(paths.configPath))).toBe(0o600);

      await writeFile(paths.configPath, 'server:\n  authToken: overwritten\n', { encoding: 'utf8', mode: 0o600 });
      const backupPath = await backupConfigIfPresent(paths.configPath, paths.appDirectory, new Date('2026-06-08T00:00:00.000Z'));
      expect(backupPath).not.toBeNull();
      expect(permissionBits(await stat(backupPath as string))).toBe(0o600);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
