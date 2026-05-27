import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getPackageVersion } from '../../../src/lib/version.js';

describe('getPackageVersion', () => {
  it('returns the version field from the project package.json verbatim', () => {
    const repositoryRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..'
    );
    const expectedVersion = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')
    ).version as string;

    expect(getPackageVersion()).toBe(expectedVersion);
    // Version follows SemVer 2.0.0 (steering: version.md).
    expect(expectedVersion).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);
  });

  it('returns a stable, memoised value across repeat calls', () => {
    const first = getPackageVersion();
    const second = getPackageVersion();
    expect(second).toBe(first);
  });
});
