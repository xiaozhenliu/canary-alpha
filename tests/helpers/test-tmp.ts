import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | null = null;

function findRepoRoot(start: string): string {
  let current = start;
  while (true) {
    if (existsSync(resolve(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`testTempRoot: could not locate package.json walking up from ${start}`);
    }
    current = parent;
  }
}

/**
 * Returns the absolute path to the repo-internal test temp root
 * (`<repo>/.test-tmp/`), creating it on first use. Tests should pass
 * the result to `mkdtemp(join(testTempRoot(), 'prefix-'))` instead
 * of `os.tmpdir()` so all transient test data is:
 *
 *   - Discoverable (always under the repo, not in /var/folders/...)
 *   - One-command cleanable (`rm -rf .test-tmp/`)
 *   - Gitignored (.test-tmp/ is in .gitignore)
 *   - Cross-OS consistent (no hardcoded `/tmp/` literals)
 */
export function testTempRoot(): string {
  if (cachedRoot !== null) return cachedRoot;
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  const root = resolve(repoRoot, '.test-tmp');
  mkdirSync(root, { recursive: true });
  cachedRoot = root;
  return root;
}
