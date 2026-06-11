import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { testTempRoot } from '../helpers/test-tmp.js';

describe('screenpipe safe record wrapper', () => {
  it('adds pii removal, bounded retention, default ignored windows, default ignored apps, and disables audio and vision by default', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[]) => string[];
    };

    expect(buildScreenpipeSafeRecordArgs()).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-vision',
      '--disable-audio'
    ]);
  });

  it('defaults transcription off when the operator explicitly opts into audio capture', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[]) => string[];
    };

    expect(buildScreenpipeSafeRecordArgs([
      '--audio-device',
      'Built-in Microphone'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-vision',
      '--audio-transcription-engine',
      'disabled',
      '--audio-device',
      'Built-in Microphone'
    ]);

    expect(buildScreenpipeSafeRecordArgs([
      '--audio-device=Built-in Microphone'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-vision',
      '--audio-transcription-engine',
      'disabled',
      '--audio-device=Built-in Microphone'
    ]);
  });

  it('treats supported boolean audio flags as explicit audio capture intent', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[]) => string[];
    };

    expect(buildScreenpipeSafeRecordArgs([
      '--use-system-default-audio'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-vision',
      '--audio-transcription-engine',
      'disabled',
      '--use-system-default-audio'
    ]);

    expect(buildScreenpipeSafeRecordArgs([
      '--experimental-coreaudio-system-audio'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-vision',
      '--audio-transcription-engine',
      'disabled',
      '--experimental-coreaudio-system-audio'
    ]);
  });

  it('treats supported vision flags as explicit vision capture intent', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[]) => string[];
    };

    expect(buildScreenpipeSafeRecordArgs([
      '--monitor-id',
      '1'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-audio',
      '--monitor-id',
      '1'
    ]);

    expect(buildScreenpipeSafeRecordArgs([
      '--use-all-monitors'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-audio',
      '--use-all-monitors'
    ]);

    expect(buildScreenpipeSafeRecordArgs([
      '--included-windows=Terminal'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-audio',
      '--included-windows=Terminal'
    ]);
  });

  it('treats explicit disable-audio as the final operator choice', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[]) => string[];
    };

    expect(buildScreenpipeSafeRecordArgs([
      '--audio-device',
      'Built-in Microphone',
      '--disable-audio'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-vision',
      '--audio-device',
      'Built-in Microphone',
      '--disable-audio'
    ]);

    expect(buildScreenpipeSafeRecordArgs([
      '--use-system-default-audio',
      '--disable-audio'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-vision',
      '--use-system-default-audio',
      '--disable-audio'
    ]);
  });

  it('preserves explicit ignored-app choices from the operator', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[]) => string[];
    };

    expect(buildScreenpipeSafeRecordArgs([
      '--ignored-apps',
      'Signal'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-vision',
      '--disable-audio',
      '--ignored-apps',
      'Signal'
    ]);

    expect(buildScreenpipeSafeRecordArgs([
      '--ignored-apps=Discord'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-vision',
      '--disable-audio',
      '--ignored-apps=Discord'
    ]);
  });

  it('preserves explicit transcription-engine choices from the operator', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[]) => string[];
    };

    expect(buildScreenpipeSafeRecordArgs([
      '--audio-device',
      'Built-in Microphone',
      '--audio-transcription-engine',
      'parakeet'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-vision',
      '--audio-device',
      'Built-in Microphone',
      '--audio-transcription-engine',
      'parakeet'
    ]);

    expect(buildScreenpipeSafeRecordArgs([
      '--audio-device=Built-in Microphone',
      '--audio-transcription-engine=deepgram'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--retention-days',
      '7',
      '--ignored-windows',
      'Control Center',
      '--ignored-windows',
      'Notification Center',
      '--disable-vision',
      '--audio-device=Built-in Microphone',
      '--audio-transcription-engine=deepgram'
    ]);
  });

  it('preserves explicit retention, pii, ignored-window, ignored-app, and audio opt-out flags from the operator', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[]) => string[];
    };

    expect(buildScreenpipeSafeRecordArgs([
      '--retention-days',
      '3',
      '--use-pii-removal',
      '--ignored-windows',
      'Slack',
      '--ignored-apps',
      'Signal',
      '--disable-audio'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--disable-vision',
      '--retention-days',
      '3',
      '--use-pii-removal',
      '--ignored-windows',
      'Slack',
      '--ignored-apps',
      'Signal',
      '--disable-audio'
    ]);
  });

  it('passes help through without forcing defaults', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[]) => string[];
    };

    expect(buildScreenpipeSafeRecordArgs(['--help'])).toEqual([
      'screenpipe@latest',
      'record',
      '--help'
    ]);
  });

  it('supports equals-form retention, ignored-window, ignored-app, and transcription arguments', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[]) => string[];
    };

    expect(buildScreenpipeSafeRecordArgs([
      '--audio-device=Built-in Microphone',
      '--retention-days=14',
      '--ignored-windows=Discord',
      '--ignored-apps=Signal',
      '--disable-vision'
    ])).toEqual([
      'screenpipe@latest',
      'record',
      '--use-pii-removal',
      '--audio-transcription-engine',
      'disabled',
      '--audio-device=Built-in Microphone',
      '--retention-days=14',
      '--ignored-windows=Discord',
      '--ignored-apps=Signal',
      '--disable-vision'
    ]);
  });

  it('writes maintenance JSONL and prunes entries older than seven days', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'safe-record-maintenance-log-'));
    try {
      const logPath = join(root, 'logs', 'screenpipe-maintenance.jsonl');
      await mkdir(join(root, 'logs'), { recursive: true });
      await writeFile(logPath, [
        JSON.stringify({ at: '2026-06-01T00:00:00.000Z', event: 'old' }),
        'not-json',
        JSON.stringify({ at: '2026-06-09T00:00:00.000Z', event: 'kept' }),
        ''
      ].join('\n'));

      const { writeMaintenanceLogEntry } = await import('../../scripts/screenpipe-safe-record.js') as {
        writeMaintenanceLogEntry: (entry: Record<string, unknown>, options?: { logPath?: string; now?: Date }) => Promise<void>;
      };

      await writeMaintenanceLogEntry(
        { at: '2026-06-10T00:00:00.000Z', event: 'maintenance-run-exit', trigger: 'periodic' },
        { logPath, now: new Date('2026-06-10T00:00:00.000Z') }
      );

      const events = (await readFile(logPath, 'utf8'))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line).event);
      expect(events).toEqual(['kept', 'maintenance-run-exit']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rotates the maintenance log when the size cap is exceeded', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'safe-record-maintenance-log-size-'));
    try {
      const logPath = join(root, 'logs', 'screenpipe-maintenance.jsonl');
      await mkdir(join(root, 'logs'), { recursive: true });
      await writeFile(logPath, 'x'.repeat(1_000_001));

      const { writeMaintenanceLogEntry } = await import('../../scripts/screenpipe-safe-record.js') as {
        writeMaintenanceLogEntry: (entry: Record<string, unknown>, options?: { logPath?: string; now?: Date }) => Promise<void>;
      };

      await writeMaintenanceLogEntry(
        { at: '2026-06-10T00:00:00.000Z', event: 'maintenance-run-start', trigger: 'final' },
        { logPath, now: new Date('2026-06-10T00:00:00.000Z') }
      );

      expect(existsSync(`${logPath}.1`)).toBe(true);
      expect(JSON.parse((await readFile(logPath, 'utf8')).trim())).toMatchObject({
        event: 'maintenance-run-start',
        trigger: 'final'
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent maintenance log writes for the same file', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'safe-record-maintenance-log-concurrent-'));
    try {
      const logPath = join(root, 'logs', 'screenpipe-maintenance.jsonl');
      const { writeMaintenanceLogEntry } = await import('../../scripts/screenpipe-safe-record.js') as {
        writeMaintenanceLogEntry: (entry: Record<string, unknown>, options?: { logPath?: string; now?: Date }) => Promise<void>;
      };

      await Promise.all([
        writeMaintenanceLogEntry(
          { at: '2026-06-10T00:00:00.000Z', event: 'maintenance-run-start', trigger: 'periodic' },
          { logPath, now: new Date('2026-06-10T00:00:00.000Z') }
        ),
        writeMaintenanceLogEntry(
          { at: '2026-06-10T00:00:01.000Z', event: 'maintenance-run-exit', trigger: 'periodic' },
          { logPath, now: new Date('2026-06-10T00:00:01.000Z') }
        )
      ]);

      const events = (await readFile(logPath, 'utf8'))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line).event)
        .sort();
      expect(events).toEqual(['maintenance-run-exit', 'maintenance-run-start']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
