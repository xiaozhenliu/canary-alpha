import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { testTempRoot } from '../helpers/test-tmp.js';

describe('screenpipe safe record wrapper', () => {
  it('injects the configured data directory unless argv overrides it', async () => {
    const { buildScreenpipeRuntimeArgs, readScreenpipeDataDirectoryArg } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeRuntimeArgs: (argv: string[], dataDirectory: string, baseUrl?: string) => string[];
      readScreenpipeDataDirectoryArg: (argv: string[]) => string | undefined;
    };

    expect(buildScreenpipeRuntimeArgs(['--use-all-monitors'], '/tmp/screenpipe-dev')).toEqual([
      '--data-dir', '/tmp/screenpipe-dev', '--use-all-monitors'
    ]);
    expect(buildScreenpipeRuntimeArgs([
      '--data-dir', '/tmp/operator-choice'
    ], '/tmp/screenpipe-dev')).toEqual([
      '--data-dir', '/tmp/operator-choice'
    ]);
    expect(readScreenpipeDataDirectoryArg([
      '--data-dir=/tmp/operator-choice'
    ])).toBe('/tmp/operator-choice');
    expect(buildScreenpipeRuntimeArgs([], '/tmp/screenpipe-dev', 'http://127.0.0.1:3031')).toEqual([
      '--port', '3031', '--data-dir', '/tmp/screenpipe-dev'
    ]);
    expect(buildScreenpipeRuntimeArgs(['-p', '4040'], '/tmp/screenpipe-dev', 'http://127.0.0.1:3031')).toEqual([
      '--data-dir', '/tmp/screenpipe-dev', '-p', '4040'
    ]);
    expect(buildScreenpipeRuntimeArgs(['-p4040'], '/tmp/screenpipe-dev', 'http://127.0.0.1:3031')).toEqual([
      '--data-dir', '/tmp/screenpipe-dev', '-p4040'
    ]);
  });

  it('reads and expands the configured binary and data paths', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'safe-record-runtime-config-'));
    const configPath = join(root, 'config.yaml');
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = root;
      await writeFile(configPath, [
        'screenpipe:',
        '  binaryPath: ~/.local/share/screenpipe/0.4.15/bin/screenpipe',
        '  dataDirectory: ~/.screenpipe-dev/0.4.15'
      ].join('\n'), 'utf8');
      const { readScreenpipeRuntimeConfig } = await import('../../scripts/screenpipe-safe-record.js') as {
        readScreenpipeRuntimeConfig: (path: string) => Promise<{ url: string; binaryPath: string; dataDirectory: string }>;
      };

      await expect(readScreenpipeRuntimeConfig(configPath)).resolves.toEqual({
        url: 'http://localhost:3030',
        binaryPath: join(root, '.local/share/screenpipe/0.4.15/bin/screenpipe'),
        dataDirectory: join(root, '.screenpipe-dev/0.4.15')
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('adds pii removal, bounded retention, default ignored windows, default ignored apps, and disables audio and vision by default', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[]) => string[];
    };

    expect(buildScreenpipeSafeRecordArgs()).toEqual([
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

  it('injects configured OCR languages as repeated --language flags in order', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[], ocrLanguages?: string[]) => string[];
    };

    expect(buildScreenpipeSafeRecordArgs([], ['chinese', 'english'])).toEqual([
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
      '--language',
      'chinese',
      '--language',
      'english'
    ]);
  });

  it('omits --language entirely when no OCR languages are configured (zero regression)', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[], ocrLanguages?: string[]) => string[];
    };

    // Identical to the baseline default assertion: passing [] must not add --language.
    expect(buildScreenpipeSafeRecordArgs([], [])).toEqual([
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

  it('lets an explicit --language override the configured languages', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[], ocrLanguages?: string[]) => string[];
    };

    const args = buildScreenpipeSafeRecordArgs(['--language', 'japanese'], ['chinese']);
    expect(args.filter((token) => token === '--language')).toHaveLength(1);
    expect(args).toContain('japanese');
    expect(args).not.toContain('chinese');
  });

  it('lets an explicit -l override the configured languages', async () => {
    const { buildScreenpipeSafeRecordArgs } = await import('../../scripts/screenpipe-safe-record.js') as {
      buildScreenpipeSafeRecordArgs: (argv?: string[], ocrLanguages?: string[]) => string[];
    };

    const args = buildScreenpipeSafeRecordArgs(['-l', 'japanese'], ['chinese']);
    expect(args.filter((token) => token === '--language')).toHaveLength(0);
    expect(args).toContain('japanese');
    expect(args).not.toContain('chinese');
  });

  describe('readOcrLanguagesFromConfig boundaries', () => {
    async function withConfig(body: string | null): Promise<string[]> {
      const root = await mkdtemp(join(testTempRoot(), 'safe-record-ocr-config-'));
      const configPath = join(root, 'config.yaml');
      try {
        if (body !== null) {
          await writeFile(configPath, body, 'utf8');
        }
        const { readOcrLanguagesFromConfig } = await import('../../scripts/screenpipe-safe-record.js') as {
          readOcrLanguagesFromConfig: (configPath?: string) => Promise<string[]>;
        };
        return await readOcrLanguagesFromConfig(configPath);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    it('returns the configured value when present and all valid', async () => {
      expect(await withConfig('capture:\n  ocrLanguages:\n    - chinese\n    - english\n'))
        .toEqual(['chinese', 'english']);
    });

    it('falls back to the schema default (english) when the field is absent', async () => {
      expect(await withConfig('capture:\n  livenessThresholdSeconds: 120\n')).toEqual(['english']);
    });

    it('falls back to the schema default (english) when the value is not an array', async () => {
      expect(await withConfig('capture:\n  ocrLanguages: chinese\n')).toEqual(['english']);
    });

    it('falls back to english + warns when the array is empty (never silently disable OCR languages)', async () => {
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (msg?: unknown) => { warnings.push(String(msg)); };
      try {
        expect(await withConfig('capture:\n  ocrLanguages: []\n')).toEqual(['english']);
      } finally {
        console.warn = original;
      }
      expect(warnings.some((w) => w.includes('empty capture.ocrLanguages'))).toBe(true);
    });

    it('falls back wholesale to english when ANY value is invalid (no silent subset)', async () => {
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (msg?: unknown) => { warnings.push(String(msg)); };
      try {
        expect(await withConfig('capture:\n  ocrLanguages:\n    - chinese\n    - klingon\n'))
          .toEqual(['english']);
      } finally {
        console.warn = original;
      }
      expect(warnings.some((w) => w.includes('invalid capture.ocrLanguages'))).toBe(true);
    });

    it('fail-opens to [] when the config file does not exist', async () => {
      expect(await withConfig(null)).toEqual([]);
    });

    it('fail-opens to [] when the YAML is corrupt', async () => {
      expect(await withConfig('capture:\n  ocrLanguages: [unterminated\n')).toEqual([]);
    });

    it('fail-opens to [] when the config file exceeds the size cap', async () => {
      const padding = `# ${'x'.repeat(1_000_001)}\n`;
      expect(await withConfig(`${padding}capture:\n  ocrLanguages:\n    - chinese\n`)).toEqual([]);
    });
  });

  it('keeps the safe-record allowlist in sync with the schema enum (no TS/JS drift)', async () => {
    const [{ OCR_LANGUAGE_ALLOWLIST, DEFAULT_OCR_LANGUAGES: scriptDefault }, schema] = await Promise.all([
      import('../../scripts/screenpipe-safe-record.js') as Promise<{
        OCR_LANGUAGE_ALLOWLIST: Set<string>;
        DEFAULT_OCR_LANGUAGES: string[];
      }>,
      import('../../src/config/schema.js')
    ]);
    const enumValues = new Set(schema.ocrLanguageSchema.options as string[]);
    expect(OCR_LANGUAGE_ALLOWLIST).toEqual(enumValues);
    expect(scriptDefault).toEqual([...schema.DEFAULT_OCR_LANGUAGES]);
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
