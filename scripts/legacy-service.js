import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const LEGACY_LAUNCHD_LABEL = 'com.canary-alpha-mcp';
export const LAUNCHD_LABEL = 'com.computer-history-mcp';

export function resolveInstalledPlistPath(homeDirectory = homedir(), label = LAUNCHD_LABEL) {
  return join(homeDirectory, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function resolveLegacyInstalledPlistPath(homeDirectory = homedir()) {
  return resolveInstalledPlistPath(homeDirectory, LEGACY_LAUNCHD_LABEL);
}

/**
 * True when the pre-rename launchd service is still loaded.
 */
export function isLegacyManagedServiceLoaded(homeDirectory = homedir()) {
  if (process.platform !== 'darwin') {
    return false;
  }

  const domain = `gui/${process.getuid()}`;
  return isServiceLoaded(domain, LEGACY_LAUNCHD_LABEL);
}

function launchctl(args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

function isServiceLoaded(domain, label) {
  const result = launchctl(['print', `${domain}/${label}`]);
  if (result.status === 0) {
    return true;
  }
  const combined = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
  if (serviceMissingMessage(combined)) {
    return false;
  }
  throw new Error(combined || `Unable to query launchd service ${label}.`);
}

function serviceMissingMessage(output) {
  return output.includes('Could not find service')
    || output.includes('No such process')
    || output.includes('Could not find specified service');
}

/**
 * Stop and remove a pre-rename launchd service so the renamed label can take over.
 */
export function uninstallLegacyManagedService(options = {}) {
  if (process.platform !== 'darwin') {
    return { status: 'skipped', reason: 'unsupported-platform' };
  }

  const homeDirectory = options.homeDirectory ?? homedir();
  const domain = `gui/${process.getuid()}`;
  const legacyPlistPath = resolveLegacyInstalledPlistPath(homeDirectory);
  const loaded = isServiceLoaded(domain, LEGACY_LAUNCHD_LABEL);

  if (!loaded && !existsSync(legacyPlistPath)) {
    return { status: 'skipped', reason: 'legacy-absent', legacyPlistPath };
  }

  if (loaded) {
    const result = existsSync(legacyPlistPath)
      ? launchctl(['bootout', domain, legacyPlistPath])
      : launchctl(['bootout', `${domain}/${LEGACY_LAUNCHD_LABEL}`]);
    const combined = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
    if (result.status !== 0 && !serviceMissingMessage(combined)) {
      throw new Error(combined || `Failed to bootout ${LEGACY_LAUNCHD_LABEL}.`);
    }
  }

  if (existsSync(legacyPlistPath)) {
    unlinkSync(legacyPlistPath);
  }

  return { status: 'removed', legacyPlistPath, label: LEGACY_LAUNCHD_LABEL };
}
