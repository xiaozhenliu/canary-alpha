import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileRoutineStore, normalizeRoutineName } from '../../../src/services/routines/routine-store.js';
import type { RoutineDefinition, RoutineRunRecord } from '../../../src/services/routines/types.js';

function createDefinition(overrides: Partial<RoutineDefinition> = {}): RoutineDefinition {
  const now = '2026-05-02T12:00:00.000Z';

  return {
    name: 'Daily Summary!!!',
    schedule: '0 9 * * *',
    enabled: true,
    kind: 'daily_summary',
    prompt: 'Summarize the day',
    recentActivityMinutes: 60,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function createRunRecord(status: RoutineRunRecord['status'], runId: string, startedAt: string): RoutineRunRecord {
  const completedAt = new Date(Date.parse(startedAt) + 1).toISOString();

  return {
    runId,
    name: 'Daily Summary!!!',
    startedAt,
    completedAt,
    status,
    summary: `${status} summary`,
    output: `${status} output`,
    ...(status === 'failed' ? { error: { message: 'boom' } } : {})
  };
}

describe('file routine store', () => {
  it('normalizes the canonical routine slug', () => {
    expect(normalizeRoutineName(' Daily Summary!!! ')).toBe('daily-summary');
    expect(normalizeRoutineName('daily-summary')).toBe('daily-summary');
    expect(normalizeRoutineName('daily summary!!!')).toBe('daily-summary');
    expect(normalizeRoutineName('!!!')).toBe('');
  });

  it('persists one slugged definition and updates in place', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'routine-store-definitions-'));
    const definitionsDirectory = join(tempDir, 'definitions');
    const historyDirectory = join(tempDir, 'history');
    const store = new FileRoutineStore({ definitionsDirectory, historyDirectory });

    try {
      const firstDefinition = createDefinition();
      const secondDefinition = createDefinition({
        name: 'daily summary',
        schedule: '30 9 * * *',
        prompt: 'Summarize the latest activity',
        recentActivityMinutes: 90,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-02T13:00:00.000Z'
      });

      await expect(store.writeDefinition(firstDefinition)).resolves.toBe(true);
      await expect(store.writeDefinition(secondDefinition)).resolves.toBe(false);

      await expect(store.readDefinition('daily-summary')).resolves.toEqual({
        name: 'daily-summary',
        schedule: '30 9 * * *',
        enabled: true,
        kind: 'daily_summary',
        prompt: 'Summarize the latest activity',
        recentActivityMinutes: 90,
        createdAt: '2026-05-02T12:00:00.000Z',
        updatedAt: '2026-05-02T13:00:00.000Z'
      });

      await expect(store.readDefinition('Daily Summary')).resolves.toEqual({
        name: 'daily-summary',
        schedule: '30 9 * * *',
        enabled: true,
        kind: 'daily_summary',
        prompt: 'Summarize the latest activity',
        recentActivityMinutes: 90,
        createdAt: '2026-05-02T12:00:00.000Z',
        updatedAt: '2026-05-02T13:00:00.000Z'
      });

      await expect(store.listDefinitions()).resolves.toEqual([
        {
          name: 'daily-summary',
          schedule: '30 9 * * *',
          enabled: true,
          kind: 'daily_summary',
          prompt: 'Summarize the latest activity',
          recentActivityMinutes: 90,
          createdAt: '2026-05-02T12:00:00.000Z',
          updatedAt: '2026-05-02T13:00:00.000Z'
        }
      ]);

      await writeFile(join(definitionsDirectory, 'ignored.json.tmp'), JSON.stringify({ name: 'ignored' }), 'utf8');
      await expect(store.listDefinitions()).resolves.toEqual([
        {
          name: 'daily-summary',
          schedule: '30 9 * * *',
          enabled: true,
          kind: 'daily_summary',
          prompt: 'Summarize the latest activity',
          recentActivityMinutes: 90,
          createdAt: '2026-05-02T12:00:00.000Z',
          updatedAt: '2026-05-02T13:00:00.000Z'
        }
      ]);

      const definitionFiles = (await readdir(definitionsDirectory)).filter((name) => name.endsWith('.json'));
      expect(definitionFiles).toEqual(['daily-summary.json']);
      await expect(readFile(join(definitionsDirectory, 'daily-summary.json.tmp'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await rm(join(definitionsDirectory, 'ignored.json.tmp'));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('stores history newest-first and survives a fresh store instance', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'routine-store-history-'));
    const definitionsDirectory = join(tempDir, 'definitions');
    const historyDirectory = join(tempDir, 'history');
    const store = new FileRoutineStore({ definitionsDirectory, historyDirectory });

    try {
      await store.writeDefinition(createDefinition());
      await store.appendRun(createRunRecord('success', 'run-3', '2026-05-02T15:00:00.000Z'));
      await store.appendRun(createRunRecord('failed', 'run-2', '2026-05-02T14:00:00.000Z'));
      await store.appendRun(createRunRecord('skipped', 'run-1', '2026-05-02T13:00:00.000Z'));

      await expect(store.listRuns('daily-summary', 10)).resolves.toEqual([
        {
          runId: 'run-1',
          name: 'daily-summary',
          startedAt: '2026-05-02T13:00:00.000Z',
          completedAt: '2026-05-02T13:00:00.001Z',
          status: 'skipped',
          summary: 'skipped summary',
          output: 'skipped output'
        },
        {
          runId: 'run-2',
          name: 'daily-summary',
          startedAt: '2026-05-02T14:00:00.000Z',
          completedAt: '2026-05-02T14:00:00.001Z',
          status: 'failed',
          summary: 'failed summary',
          output: 'failed output',
          error: { message: 'boom' }
        },
        {
          runId: 'run-3',
          name: 'daily-summary',
          startedAt: '2026-05-02T15:00:00.000Z',
          completedAt: '2026-05-02T15:00:00.001Z',
          status: 'success',
          summary: 'success summary',
          output: 'success output'
        }
      ]);

      await expect(store.listRuns('daily-summary', 2)).resolves.toEqual([
        {
          runId: 'run-1',
          name: 'daily-summary',
          startedAt: '2026-05-02T13:00:00.000Z',
          completedAt: '2026-05-02T13:00:00.001Z',
          status: 'skipped',
          summary: 'skipped summary',
          output: 'skipped output'
        },
        {
          runId: 'run-2',
          name: 'daily-summary',
          startedAt: '2026-05-02T14:00:00.000Z',
          completedAt: '2026-05-02T14:00:00.001Z',
          status: 'failed',
          summary: 'failed summary',
          output: 'failed output',
          error: { message: 'boom' }
        }
      ]);

      const secondStore = new FileRoutineStore({ definitionsDirectory, historyDirectory });
      await expect(secondStore.readDefinition('daily-summary')).resolves.toEqual({
        name: 'daily-summary',
        schedule: '0 9 * * *',
        enabled: true,
        kind: 'daily_summary',
        prompt: 'Summarize the day',
        recentActivityMinutes: 60,
        createdAt: '2026-05-02T12:00:00.000Z',
        updatedAt: '2026-05-02T12:00:00.000Z'
      });
      await expect(secondStore.listRuns('Daily Summary', 10)).resolves.toEqual([
        {
          runId: 'run-1',
          name: 'daily-summary',
          startedAt: '2026-05-02T13:00:00.000Z',
          completedAt: '2026-05-02T13:00:00.001Z',
          status: 'skipped',
          summary: 'skipped summary',
          output: 'skipped output'
        },
        {
          runId: 'run-2',
          name: 'daily-summary',
          startedAt: '2026-05-02T14:00:00.000Z',
          completedAt: '2026-05-02T14:00:00.001Z',
          status: 'failed',
          summary: 'failed summary',
          output: 'failed output',
          error: { message: 'boom' }
        },
        {
          runId: 'run-3',
          name: 'daily-summary',
          startedAt: '2026-05-02T15:00:00.000Z',
          completedAt: '2026-05-02T15:00:00.001Z',
          status: 'success',
          summary: 'success summary',
          output: 'success output'
        }
      ]);

      await expect(secondStore.listRuns('daily-summary', 1)).resolves.toEqual([
        {
          runId: 'run-1',
          name: 'daily-summary',
          startedAt: '2026-05-02T13:00:00.000Z',
          completedAt: '2026-05-02T13:00:00.001Z',
          status: 'skipped',
          summary: 'skipped summary',
          output: 'skipped output'
        }
      ]);

      await expect(readdir(historyDirectory)).resolves.toEqual(['daily-summary.json']);
      await expect(readFile(join(historyDirectory, 'daily-summary.json.tmp'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      await writeFile(join(historyDirectory, 'ignored.json.tmp'), JSON.stringify([{ runId: 'ignored' }]), 'utf8');
      await expect(secondStore.listRuns('daily-summary', 10)).resolves.toEqual([
        {
          runId: 'run-1',
          name: 'daily-summary',
          startedAt: '2026-05-02T13:00:00.000Z',
          completedAt: '2026-05-02T13:00:00.001Z',
          status: 'skipped',
          summary: 'skipped summary',
          output: 'skipped output'
        },
        {
          runId: 'run-2',
          name: 'daily-summary',
          startedAt: '2026-05-02T14:00:00.000Z',
          completedAt: '2026-05-02T14:00:00.001Z',
          status: 'failed',
          summary: 'failed summary',
          output: 'failed output',
          error: { message: 'boom' }
        },
        {
          runId: 'run-3',
          name: 'daily-summary',
          startedAt: '2026-05-02T15:00:00.000Z',
          completedAt: '2026-05-02T15:00:00.001Z',
          status: 'success',
          summary: 'success summary',
          output: 'success output'
        }
      ]);
      await rm(join(historyDirectory, 'ignored.json.tmp'));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed for malformed persisted definition and history JSON', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'routine-store-malformed-'));
    const definitionsDirectory = join(tempDir, 'definitions');
    const historyDirectory = join(tempDir, 'history');
    const store = new FileRoutineStore({ definitionsDirectory, historyDirectory });

    try {
      await mkdir(definitionsDirectory, { recursive: true });
      await mkdir(historyDirectory, { recursive: true });
      await writeFile(join(definitionsDirectory, 'daily-summary.json'), '{', 'utf8');
      await writeFile(join(historyDirectory, 'daily-summary.json'), JSON.stringify([{ runId: 'x' }], null, 2), 'utf8');

      await expect(store.readDefinition('daily-summary')).rejects.toThrow(/Invalid routine definition at .*daily-summary\.json/);
      await expect(store.listDefinitions()).rejects.toThrow(/Invalid routine definition at .*daily-summary\.json/);
      await expect(store.listRuns('daily-summary', 10)).rejects.toThrow(/Invalid routine history at .*daily-summary\.json/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
