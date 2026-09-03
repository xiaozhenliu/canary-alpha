import { describe, expect, it, vi } from 'vitest';

import { startLocalStack } from '../../scripts/start-local-lib.js';

function createDeps(options = {}) {
  return {
    hasConfig: vi.fn().mockReturnValue(options.hasConfig ?? true),
    hasCompletedOnboarding: vi.fn().mockReturnValue(options.hasCompletedOnboarding ?? true),
    hasBuild: vi.fn().mockReturnValue(options.hasBuild ?? true),
    ensureFirstRunScreenpipe: vi.fn().mockResolvedValue(undefined),
    onboard: vi.fn().mockResolvedValue(undefined),
    build: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    log: vi.fn()
  };
}

describe('startLocalStack', () => {
  it('prepares Screenpipe and onboards when config is missing', async () => {
    const deps = createDeps({ hasConfig: false });

    await expect(startLocalStack(deps)).resolves.toEqual({ mode: 'onboard', built: false });
    expect(deps.ensureFirstRunScreenpipe).toHaveBeenCalledOnce();
    expect(deps.onboard).toHaveBeenCalledOnce();
    expect(deps.hasBuild).not.toHaveBeenCalled();
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it('continues onboarding when setup created config without completing onboarding', async () => {
    const deps = createDeps({ hasCompletedOnboarding: false });

    await expect(startLocalStack(deps)).resolves.toEqual({ mode: 'onboard', built: false });
    expect(deps.ensureFirstRunScreenpipe).toHaveBeenCalledOnce();
    expect(deps.onboard).toHaveBeenCalledOnce();
    expect(deps.hasBuild).not.toHaveBeenCalled();
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it('builds once and resumes when config exists but build output is missing', async () => {
    const deps = createDeps({ hasBuild: false });

    await expect(startLocalStack(deps)).resolves.toEqual({ mode: 'resume', built: true });
    expect(deps.ensureFirstRunScreenpipe).not.toHaveBeenCalled();
    expect(deps.onboard).not.toHaveBeenCalled();
    expect(deps.build).toHaveBeenCalledOnce();
    expect(deps.resume).toHaveBeenCalledOnce();
    expect(deps.build.mock.invocationCallOrder[0])
      .toBeLessThan(deps.resume.mock.invocationCallOrder[0]);
  });

  it('uses fast resume when config and build output both exist', async () => {
    const deps = createDeps();

    await expect(startLocalStack(deps)).resolves.toEqual({ mode: 'resume', built: false });
    expect(deps.ensureFirstRunScreenpipe).not.toHaveBeenCalled();
    expect(deps.onboard).not.toHaveBeenCalled();
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.resume).toHaveBeenCalledOnce();
  });

  it('does not continue to resume when build recovery fails', async () => {
    const deps = createDeps({ hasBuild: false });
    deps.build.mockRejectedValue(new Error('build failed'));

    await expect(startLocalStack(deps)).rejects.toThrow('build failed');
    expect(deps.resume).not.toHaveBeenCalled();
  });
});
