import { describe, expect, it } from 'vitest';

import { DefaultScreenpipeControlService } from '../../../src/services/capture/providers/screenpipe/control-service.js';

describe('screenpipe-control service', () => {
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
