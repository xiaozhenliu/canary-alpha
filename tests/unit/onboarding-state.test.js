import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  hasCompletedOnboarding,
  markOnboardingComplete,
  resolveOnboardingCompletePath
} from '../../scripts/onboarding-state.js';

const temporaryDirectories = [];

async function createHome() {
  const directory = await mkdtemp(join(tmpdir(), 'canary-onboarding-state-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe('onboarding state', () => {
  it('persists and detects the onboarding completion marker', async () => {
    const homeDirectory = await createHome();
    await mkdir(join(homeDirectory, '.computer-history-mcp'), { recursive: true });

    expect(hasCompletedOnboarding({ homeDirectory })).toBe(false);
    await markOnboardingComplete({ homeDirectory });
    expect(hasCompletedOnboarding({ homeDirectory })).toBe(true);
    expect(resolveOnboardingCompletePath(homeDirectory))
      .toBe(join(homeDirectory, '.computer-history-mcp', '.onboarding-complete'));
  });

  it('recognizes a legacy managed service as completed onboarding', async () => {
    const homeDirectory = await createHome();
    const launchAgentPath = join(homeDirectory, 'Library', 'LaunchAgents', 'com.canary-alpha-mcp.plist');
    await mkdir(join(homeDirectory, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(launchAgentPath, 'legacy service', 'utf8');

    expect(hasCompletedOnboarding({ homeDirectory })).toBe(true);
  });

  it('recognizes the renamed managed service as completed onboarding', async () => {
    const homeDirectory = await createHome();
    const launchAgentPath = join(homeDirectory, 'Library', 'LaunchAgents', 'com.computer-history-mcp.plist');
    await mkdir(join(homeDirectory, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(launchAgentPath, 'managed service', 'utf8');

    expect(hasCompletedOnboarding({ homeDirectory })).toBe(true);
  });
});
