import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

export const LEGACY_LAUNCHD_LABEL = 'com.canary-alpha-mcp';

function launchctl(args: string[]) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

function serviceMissingMessage(output: string): boolean {
  return output.includes('Could not find service')
    || output.includes('No such process')
    || output.includes('Could not find specified service');
}

/**
 * True when the pre-rename launchd service is still loaded.
 * Direct server starts must not rename the app home while this writer can still run.
 * Fail closed on unexpected launchctl errors so migration does not race a live writer.
 */
export function isLegacyManagedServiceLoaded(_homeDirectory = homedir()): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }

  const getUid = process.getuid;
  if (typeof getUid !== 'function') {
    return false;
  }
  const uid = getUid();
  const domain = `gui/${uid}`;
  const printResult = launchctl(['print', `${domain}/${LEGACY_LAUNCHD_LABEL}`]);
  if (printResult.status === 0) {
    return true;
  }

  const combined = `${printResult.stderr ?? ''}\n${printResult.stdout ?? ''}`.trim();
  if (serviceMissingMessage(combined)) {
    return false;
  }

  throw new Error(combined || `Unable to query launchd service ${LEGACY_LAUNCHD_LABEL}.`);
}
