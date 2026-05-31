import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Canonical install guidance URL for the Hermes CLI.
 * NOTE: Confirm the exact upstream URL at implementation time.
 * Placeholder based on existing error message pattern in the codebase.
 */
export const HERMES_INSTALL_URL = 'https://github.com/HermesMCP/hermes';

/**
 * @typedef {Object} HermesDetectionResult
 * @property {boolean} present              - true if `hermes --version` succeeded
 * @property {string|null} version          - trimmed version string, or null if absent
 * @property {string} installGuidanceUrl    - canonical install URL (= HERMES_INSTALL_URL)
 * @property {string|null} errorDetail      - spawn error message if absent, else null
 */

/**
 * Probes whether the `hermes` CLI is available on PATH.
 *
 * Never throws — all callers receive a result object and decide their own exit behavior.
 *
 * @returns {Promise<HermesDetectionResult>}
 */
export async function detectHermes() {
  try {
    const result = await execFileAsync('hermes', ['--version'], { timeout: 30_000 });
    const version = (result.stdout || result.stderr || '').trim() || 'unknown';
    return {
      present: true,
      version,
      installGuidanceUrl: HERMES_INSTALL_URL,
      errorDetail: null
    };
  } catch (error) {
    const errorDetail = error instanceof Error ? error.message : String(error);
    return {
      present: false,
      version: null,
      installGuidanceUrl: HERMES_INSTALL_URL,
      errorDetail
    };
  }
}
