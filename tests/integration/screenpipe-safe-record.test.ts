import { describe, expect, it } from 'vitest';

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
});
