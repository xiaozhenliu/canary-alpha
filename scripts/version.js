/**
 * Mirror of `src/lib/version.ts` for the plain-JS scripts in this
 * directory. Both versions read the same `package.json` so there is
 * still a single source of truth at runtime.
 *
 * The walker resolution matters in production: `service:start` runs
 * from the workspace root and shells out to `node dist/src/index.js`,
 * but the helper itself can be imported either from the script
 * location (this file) or the built layout, depending on the entry
 * point. Walking upward to the nearest `package.json` keeps both
 * paths working without conditional logic.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function findPackageJsonUpwards(start) {
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
    throw new Error(`getPackageVersion: could not locate package.json walking up from ${sourceDir}`);
  }
  return found;
})();

let cachedVersion = null;

export function getPackageVersion() {
  if (cachedVersion === null) {
    const raw = readFileSync(PACKAGE_JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
      throw new Error(`package.json at ${PACKAGE_JSON_PATH} is missing a usable "version" field`);
    }
    cachedVersion = parsed.version;
  }
  return cachedVersion;
}
