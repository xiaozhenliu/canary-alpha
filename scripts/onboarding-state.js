import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { APP_DIRECTORY_NAME } from './app-home-migration.js';
import { LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL, resolveInstalledPlistPath } from './legacy-service.js';

export const ONBOARDING_COMPLETE_FILE_NAME = '.onboarding-complete';

export function resolveOnboardingCompletePath(homeDirectory = homedir()) {
  return join(homeDirectory, APP_DIRECTORY_NAME, ONBOARDING_COMPLETE_FILE_NAME);
}

export function hasCompletedOnboarding(options = {}) {
  const homeDirectory = options.homeDirectory ?? homedir();
  const markerPath = resolveOnboardingCompletePath(homeDirectory);
  if (existsSync(markerPath)) {
    return true;
  }

  // Existing installations predate the marker. A managed launchd service is
  // the strongest local signal that their onboarding already completed.
  return existsSync(resolveInstalledPlistPath(homeDirectory, LAUNCHD_LABEL))
    || existsSync(resolveInstalledPlistPath(homeDirectory, LEGACY_LAUNCHD_LABEL));
}

export async function markOnboardingComplete(options = {}) {
  const markerPath = resolveOnboardingCompletePath(options.homeDirectory);
  await writeFile(markerPath, `${new Date().toISOString()}\n`, { encoding: 'utf8', mode: 0o600 });
}
