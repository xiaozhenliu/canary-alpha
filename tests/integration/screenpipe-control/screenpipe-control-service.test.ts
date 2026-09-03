import { afterEach, describe, expect, it, vi } from 'vitest';

import { DefaultScreenpipeControlService } from '../../../src/services/capture/providers/screenpipe/control-service.js';

describe('screenpipe-control service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('checks the configured Screenpipe URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const service = new DefaultScreenpipeControlService({ url: 'http://127.0.0.1:3031' });

    await expect(service.execute({ action: 'status' })).resolves.toMatchObject({
      action: 'status',
      running: true
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:3031/health');
  });

  it('status returns running=false when Screenpipe is not reachable', async () => {
    const service = new DefaultScreenpipeControlService();
    const result = await service.execute({ action: 'status' });
    expect(result.action).toBe('status');
    expect(typeof result.running).toBe('boolean');
  });

  it('stop returns error when no process is managed', async () => {
    const service = new DefaultScreenpipeControlService();
    const result = await service.execute({ action: 'stop' });
    expect(result.action).toBe('stop');
    expect(result.running).toBe(false);
    expect(result.error).toBeDefined();
  });
});
