/**
 * Single source of truth for the runtime "software version" string.
 *
 * Per `.kiro/steering/version.md`, the only authoritative version
 * lives in `package.json`. Every runtime / outward-facing version
 * report (MCP server self-report, MCP client name/version, CLI
 * banners, log lines) must derive its value from this helper rather
 * than embedding a literal — otherwise we end up with two facts
 * sources that drift.
 *
 * The implementation reads `package.json` synchronously off disk
 * once and memoises the result. Synchronous I/O is acceptable here
 * because:
 *
 *   - The file lives next to our own source tree (resolved relative
 *     to this module's URL via {@link import.meta.url}). It is not
 *     a network or remote path.
 *   - The lookup happens at most once per process (memoised below),
 *     so a single `readFileSync` adds microseconds to startup.
 *   - The MCP server's `new McpServer({ ..., version })` constructor
 *     is itself synchronous, so a sync read is the simplest way to
 *     give it a deterministic value.
 *
 * The helper deliberately does NOT use a JSON import assertion
 * (`import pkg from '../../package.json' assert { type: 'json' }`)
 * because the rest of the project does not — keeping `tsconfig.json`
 * and the runtime configuration unchanged is preferable to picking
 * up an experimental import shape.
 *
 * Sibling JavaScript scripts in `scripts/` can mirror the same
 * pattern via {@link readPackageVersionFromDisk}; see
 * `scripts/service-start.js` and `scripts/service-status.js`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walk upward from `start` looking for the nearest directory that
 * contains a `package.json`. Returns `null` when traversal reaches
 * the filesystem root without finding one.
 *
 * Why a walker rather than a fixed `'../../package.json'` literal:
 * the tsconfig keeps `rootDir = '.'`, so the build emits
 * `dist/src/lib/version.js`. From the source location
 * (`src/lib/version.ts`) the project root sits at `'../..'`, but
 * from the built location it sits at `'../../..'`. Walking upward
 * is robust against both layouts and against any future build
 * relocation.
 */
function findPackageJsonUpwards(start: string): string | null {
  let current = start;
  while (true) {
    const candidate = resolve(current, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const PACKAGE_JSON_PATH = (() => {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const found = findPackageJsonUpwards(sourceDir);
  if (found === null) {
    throw new Error(
      `getPackageVersion: could not locate package.json walking up from ${sourceDir}`
    );
  }
  return found;
})();

let cachedVersion: string | null = null;

/**
 * Read and validate the `version` field of the project's
 * `package.json`. Throws when the file is missing, malformed, or
 * carries a non-string `version` — the failure mode is fatal because
 * every reporting surface in the runtime depends on it.
 */
function readPackageVersionFromDisk(packageJsonPath: string): string {
  const raw = readFileSync(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(
      `package.json at ${packageJsonPath} is missing a usable "version" field`
    );
  }
  return parsed.version;
}

/**
 * Returns the project's software version (the `version` field in
 * `package.json`). Memoised so repeat callers do not re-read the
 * file. Tests can reset the cache via {@link __resetPackageVersionCacheForTesting}.
 */
export function getPackageVersion(): string {
  if (cachedVersion === null) {
    cachedVersion = readPackageVersionFromDisk(PACKAGE_JSON_PATH);
  }
  return cachedVersion;
}

/**
 * Test-only hook: resets the memoised value so the next
 * {@link getPackageVersion} call re-reads `package.json`. Production
 * code MUST NOT call this — the version is a process-lifetime
 * constant.
 */
export function __resetPackageVersionCacheForTesting(): void {
  cachedVersion = null;
}
