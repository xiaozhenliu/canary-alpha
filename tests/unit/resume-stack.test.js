import { describe, expect, it, vi } from 'vitest';

import { resumeStack } from '../../scripts/resume-stack-lib.js';

function createDeps(options = {}) {
  return {
    checkService: vi.fn().mockResolvedValue(options.serviceHealthy ?? true),
    checkScreenpipe: vi.fn().mockResolvedValue(options.screenpipeHealthy ?? true),
    startService: vi.fn().mockResolvedValue(undefined),
    startRecorder: vi.fn().mockResolvedValue(undefined),
    waitForScreenpipe: vi.fn().mockResolvedValue(undefined),
    log: vi.fn()
  };
}

describe('resumeStack', () => {
  it('reuses both healthy components without starting anything', async () => {
    const deps = createDeps();

    await expect(resumeStack(deps)).resolves.toEqual({
      service: 'reused',
      screenpipe: 'reused'
    });
    expect(deps.startService).not.toHaveBeenCalled();
    expect(deps.startRecorder).not.toHaveBeenCalled();
    expect(deps.waitForScreenpipe).not.toHaveBeenCalled();
  });

  it('starts only the managed service when Screenpipe is healthy', async () => {
    const deps = createDeps({ serviceHealthy: false });

    await expect(resumeStack(deps)).resolves.toEqual({
      service: 'started',
      screenpipe: 'reused'
    });
    expect(deps.startService).toHaveBeenCalledOnce();
    expect(deps.startRecorder).not.toHaveBeenCalled();
  });

  it('starts only Screenpipe and waits for health when the service is healthy', async () => {
    const deps = createDeps({ screenpipeHealthy: false });

    await expect(resumeStack(deps)).resolves.toEqual({
      service: 'reused',
      screenpipe: 'started'
    });
    expect(deps.startService).not.toHaveBeenCalled();
    expect(deps.startRecorder).toHaveBeenCalledOnce();
    expect(deps.waitForScreenpipe).toHaveBeenCalledOnce();
    expect(deps.startRecorder.mock.invocationCallOrder[0])
      .toBeLessThan(deps.waitForScreenpipe.mock.invocationCallOrder[0]);
  });

  it('starts both missing components', async () => {
    const deps = createDeps({ serviceHealthy: false, screenpipeHealthy: false });

    await expect(resumeStack(deps)).resolves.toEqual({
      service: 'started',
      screenpipe: 'started'
    });
    expect(deps.startService).toHaveBeenCalledOnce();
    expect(deps.startRecorder).toHaveBeenCalledOnce();
    expect(deps.waitForScreenpipe).toHaveBeenCalledOnce();
  });

  it('propagates a component startup failure', async () => {
    const deps = createDeps({ serviceHealthy: false });
    deps.startService.mockRejectedValue(new Error('service start failed'));

    await expect(resumeStack(deps)).rejects.toThrow('service start failed');
  });
});
