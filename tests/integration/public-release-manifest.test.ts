import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { testTempRoot } from '../helpers/test-tmp.js';

const PROJECT_ROOT = join(import.meta.dirname, '..', '..');
const CLASSIFIER = join(PROJECT_ROOT, 'scripts', 'public-release-classify.js');

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const task = cleanup.pop();
    if (task) {
      await task();
    }
  }
});

describe('public release manifest', () => {
  it('classifies the current dev tree without unlisted paths', () => {
    const output = execFileSync('node', [CLASSIFIER, '--json'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8'
    });

    const parsed = JSON.parse(output);
    expect(parsed.approvedCount).toBeGreaterThan(100);
    expect(parsed.excludedCount).toBeGreaterThan(10);
    expect(parsed.approved).toContain('README.md');
    expect(parsed.excluded).toContain('AGENTS.md');
    expect(parsed.excluded).toContain('docs/specs/project-rename-computer-history-mcp.md');
  });

  it('fails closed when the manifest leaves a path unclassified', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'public-manifest-'));
    cleanup.push(() => rm(tempDir, { recursive: true, force: true }));

    const manifestPath = join(tempDir, 'manifest.txt');
    await writeFile(manifestPath, 'include README.md\n', 'utf8');

    expect(() => execFileSync('node', [
      CLASSIFIER,
      '--manifest',
      manifestPath,
      '--json'
    ], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8'
    })).toThrow();
  });
});
