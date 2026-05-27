import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FilePrivacyStore } from '../../../src/services/privacy/privacy-store.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

describe('privacy store', () => {
  it('returns the default state when the privacy file is missing', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'privacy-store-default-'));
    const store = new FilePrivacyStore(join(tempDir, 'privacy-state.json'));

    try {
      await expect(store.read()).resolves.toEqual({
        paused: false,
        excludedApps: []
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('persists state atomically via temp-file replacement', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'privacy-store-write-'));
    const filePath = join(tempDir, 'nested', 'privacy-state.json');
    const store = new FilePrivacyStore(filePath);

    try {
      await store.write({
        paused: true,
        excludedApps: ['Linear']
      });

      await expect(readFile(filePath, 'utf8')).resolves.toContain('"paused": true');
      await expect(readFile(`${filePath}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(store.read()).resolves.toEqual({
        paused: true,
        excludedApps: ['Linear'],
        pauseStartedAt: undefined,
        suppressedRanges: []
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('normalizes persisted pause window metadata', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'privacy-store-normalize-'));
    const filePath = join(tempDir, 'privacy-state.json');
    const store = new FilePrivacyStore(filePath);

    try {
      await writeFile(filePath, JSON.stringify({
        paused: false,
        excludedApps: ['Claude'],
        pauseStartedAt: '2026-04-13T11:55:00.000Z',
        suppressedRanges: [
          {
            from: '2026-04-13T11:55:00.000Z',
            to: '2026-04-13T12:04:59.999Z'
          },
          {
            from: 1,
            to: 'invalid'
          }
        ]
      }, null, 2), 'utf8');

      await expect(store.read()).resolves.toEqual({
        paused: false,
        excludedApps: ['Claude'],
        pauseStartedAt: '2026-04-13T11:55:00.000Z',
        suppressedRanges: [
          {
            from: '2026-04-13T11:55:00.000Z',
            to: '2026-04-13T12:04:59.999Z'
          }
        ]
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed for inverted persisted suppressed ranges', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'privacy-store-inverted-range-'));
    const filePath = join(tempDir, 'privacy-state.json');
    const store = new FilePrivacyStore(filePath);

    try {
      await writeFile(filePath, JSON.stringify({
        paused: false,
        excludedApps: ['Claude'],
        suppressedRanges: [
          {
            from: '2026-04-13T12:04:59.999Z',
            to: '2026-04-13T11:55:00.000Z'
          }
        ]
      }, null, 2), 'utf8');

      await expect(store.read()).resolves.toEqual({
        paused: false,
        excludedApps: ['Claude'],
        pauseStartedAt: undefined,
        suppressedRanges: [
          {
            from: '2026-04-13T11:55:00.000Z',
            to: '2026-04-13T12:04:59.999Z'
          }
        ]
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
