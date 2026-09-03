import { describe, expect, it, vi } from 'vitest';

import { refreshHermes } from '../../scripts/refresh-hermes-lib.js';

function createDeps() {
  return {
    build: vi.fn().mockResolvedValue(undefined),
    restartService: vi.fn().mockResolvedValue(undefined),
    resumeStack: vi.fn().mockResolvedValue(undefined),
    verifyHermes: vi.fn().mockResolvedValue(undefined),
    log: vi.fn()
  };
}

describe('refreshHermes', () => {
  it('builds, restarts, restores the stack, and verifies Hermes in order', async () => {
    const deps = createDeps();

    await expect(refreshHermes(deps)).resolves.toEqual({ refreshed: true, verified: true });

    expect(deps.build).toHaveBeenCalledOnce();
    expect(deps.restartService).toHaveBeenCalledOnce();
    expect(deps.resumeStack).toHaveBeenCalledOnce();
    expect(deps.verifyHermes).toHaveBeenCalledOnce();
    expect(deps.build.mock.invocationCallOrder[0])
      .toBeLessThan(deps.restartService.mock.invocationCallOrder[0]);
    expect(deps.restartService.mock.invocationCallOrder[0])
      .toBeLessThan(deps.resumeStack.mock.invocationCallOrder[0]);
    expect(deps.resumeStack.mock.invocationCallOrder[0])
      .toBeLessThan(deps.verifyHermes.mock.invocationCallOrder[0]);
  });

  it.each([
    ['build'],
    ['restartService'],
    ['resumeStack'],
    ['verifyHermes']
  ])('stops immediately when %s fails', async (failedStep) => {
    const deps = createDeps();
    deps[failedStep].mockRejectedValue(new Error(`${failedStep} failed`));

    await expect(refreshHermes(deps)).rejects.toThrow(`${failedStep} failed`);

    const steps = ['build', 'restartService', 'resumeStack', 'verifyHermes'];
    const failedIndex = steps.indexOf(failedStep);
    for (const laterStep of steps.slice(failedIndex + 1)) {
      expect(deps[laterStep]).not.toHaveBeenCalled();
    }
  });
});
