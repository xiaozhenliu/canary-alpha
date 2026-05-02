import { describe, expect, it } from 'vitest';

import { DefaultPrivacyControlService } from '../../../src/services/privacy/privacy-control-service.js';
import type { PrivacyState, PrivacyStore } from '../../../src/services/privacy/types.js';

class InMemoryPrivacyStore implements PrivacyStore {
  constructor(private state: PrivacyState = { paused: false, excludedApps: [] }) {}

  async read(): Promise<PrivacyState> {
    return this.state;
  }

  async write(state: PrivacyState): Promise<void> {
    this.state = state;
  }
}

describe('privacy control service', () => {
  it('persists pause and resume state changes', async () => {
    const store = new InMemoryPrivacyStore();
    const service = new DefaultPrivacyControlService(store);

    await expect(service.execute({ action: 'pause' })).resolves.toMatchObject({ paused: true });
    await expect(service.execute({ action: 'status' })).resolves.toMatchObject({ paused: true });
    await expect(service.execute({ action: 'resume' })).resolves.toMatchObject({ paused: false });
  });

  it('records a suppressed range when resuming after a pause window', async () => {
    const store = new InMemoryPrivacyStore();
    let now = new Date('2026-04-13T11:55:00.000Z');
    const service = new DefaultPrivacyControlService(store, () => now);

    await service.execute({ action: 'pause' });
    now = new Date('2026-04-13T12:05:00.000Z');
    await service.execute({ action: 'resume' });

    await expect(store.read()).resolves.toEqual({
      paused: false,
      excludedApps: [],
      pauseStartedAt: undefined,
      suppressedRanges: [
        {
          from: '2026-04-13T11:55:00.000Z',
          to: '2026-04-13T12:04:59.999Z'
        }
      ]
    });
  });

  it('refreshes pauseStartedAt when re-pausing a legacy paused state without a timestamp', async () => {
    const store = new InMemoryPrivacyStore({
      paused: true,
      excludedApps: ['Claude']
    });
    const now = new Date('2026-04-13T12:05:00.000Z');
    const service = new DefaultPrivacyControlService(store, () => now);

    const result = await service.execute({ action: 'pause' });

    expect(result).toMatchObject({
      paused: true,
      excludedApps: ['Claude']
    });
    await expect(store.read()).resolves.toEqual({
      paused: true,
      excludedApps: ['Claude'],
      pauseStartedAt: '2026-04-13T12:05:00.000Z'
    });
  });

  it('clears a legacy paused state without backfilling a historical suppressed range on resume', async () => {
    const store = new InMemoryPrivacyStore({
      paused: true,
      excludedApps: ['Claude']
    });
    const now = new Date('2026-04-13T12:05:00.000Z');
    const service = new DefaultPrivacyControlService(store, () => now);

    const result = await service.execute({ action: 'resume' });

    expect(result).toMatchObject({
      paused: false,
      excludedApps: ['Claude']
    });
    await expect(store.read()).resolves.toEqual({
      paused: false,
      excludedApps: ['Claude'],
      pauseStartedAt: undefined
    });
  });

  it('records a single-point suppressed range when pause and resume share the same millisecond', async () => {
    const now = new Date('2026-04-13T12:05:00.000Z');
    const store = new InMemoryPrivacyStore();
    const service = new DefaultPrivacyControlService(store, () => now);

    await service.execute({ action: 'pause' });
    await service.execute({ action: 'resume' });

    await expect(store.read()).resolves.toEqual({
      paused: false,
      excludedApps: [],
      pauseStartedAt: undefined,
      suppressedRanges: [
        {
          from: '2026-04-13T12:05:00.000Z',
          to: '2026-04-13T12:05:00.000Z'
        }
      ]
    });
  });

  it('appends a deterministic last-hour suppressed range for confirmed delete-range requests', async () => {
    const now = new Date('2026-04-13T12:05:00.000Z');
    const store = new InMemoryPrivacyStore({
      paused: false,
      excludedApps: ['Claude'],
      suppressedRanges: [
        {
          from: '2026-04-13T10:00:00.000Z',
          to: '2026-04-13T10:15:00.000Z'
        }
      ]
    });
    const service = new DefaultPrivacyControlService(store, () => now);

    const result = await service.execute({ action: 'delete-range', range: 'last_1h', confirm: true });

    expect(result).toMatchObject({
      action: 'delete-range',
      confirmed: true,
      requestedRange: 'last_1h',
      paused: false,
      excludedApps: ['Claude']
    });
    expect(result.error).toBeUndefined();
    await expect(store.read()).resolves.toEqual({
      paused: false,
      excludedApps: ['Claude'],
      pauseStartedAt: undefined,
      suppressedRanges: [
        {
          from: '2026-04-13T10:00:00.000Z',
          to: '2026-04-13T10:15:00.000Z'
        },
        {
          from: '2026-04-13T11:05:00.000Z',
          to: '2026-04-13T12:05:00.000Z'
        }
      ]
    });
  });

  it('keeps wider confirmed delete-range requests unavailable', async () => {
    const service = new DefaultPrivacyControlService(new InMemoryPrivacyStore());

    await expect(service.execute({ action: 'delete-range', range: 'last_1d', confirm: true })).resolves.toMatchObject({
      confirmed: true,
      requestedRange: 'last_1d',
      error: { code: 'PRIVACY_DELETE_UNAVAILABLE' }
    });
    await expect(service.execute({ action: 'delete-range', range: 'all', confirm: true })).resolves.toMatchObject({
      confirmed: true,
      requestedRange: 'all',
      error: { code: 'PRIVACY_DELETE_UNAVAILABLE' }
    });
  });

  it('returns confirm guidance without mutating state when delete-range confirm is missing', async () => {
    const store = new InMemoryPrivacyStore({
      paused: false,
      excludedApps: [],
      suppressedRanges: [{ from: '2026-04-13T10:00:00.000Z', to: '2026-04-13T10:15:00.000Z' }]
    });
    const now = new Date('2026-04-13T12:05:00.000Z');
    const service = new DefaultPrivacyControlService(store, () => now);

    const result = await service.execute({ action: 'delete-range', range: 'last_1h' });

    expect(result).toMatchObject({
      confirmed: false,
      requestedRange: 'last_1h',
      error: { code: 'PRIVACY_CONFIRM_REQUIRED' }
    });
    await expect(store.read()).resolves.toEqual({
      paused: false,
      excludedApps: [],
      suppressedRanges: [{ from: '2026-04-13T10:00:00.000Z', to: '2026-04-13T10:15:00.000Z' }]
    });
  });

  it('adds excluded apps once regardless of capitalization and preserves insertion order', async () => {
    const service = new DefaultPrivacyControlService(new InMemoryPrivacyStore());

    await service.execute({ action: 'exclude-app', appName: 'Claude' });
    await service.execute({ action: 'exclude-app', appName: 'Screenpipe' });
    const result = await service.execute({ action: 'exclude-app', appName: 'claude' });

    expect(result.excludedApps).toEqual(['Claude', 'Screenpipe']);
  });

  it('treats ASCII app names case-insensitively with locale-invariant normalization', async () => {
    const service = new DefaultPrivacyControlService(new InMemoryPrivacyStore());

    await service.execute({ action: 'exclude-app', appName: 'IINA' });
    const result = await service.execute({ action: 'exclude-app', appName: 'iina' });

    expect(result.excludedApps).toEqual(['IINA']);
  });

  it('returns an explicit error when exclude-app is missing a usable name', async () => {
    const service = new DefaultPrivacyControlService(new InMemoryPrivacyStore());
    const result = await service.execute({ action: 'exclude-app', appName: '   ' });

    expect(result.error).toMatchObject({ code: 'PRIVACY_APP_NAME_REQUIRED' });
  });
});
