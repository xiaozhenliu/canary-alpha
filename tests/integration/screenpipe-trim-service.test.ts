import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runTrimOnce } from '../../src/services/capture/providers/screenpipe/trim-service.js';
import { testTempRoot } from '../helpers/test-tmp.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

describe('runTrimOnce', () => {
  it('returns zero retention counts without throwing when db path is missing and no budget is configured', async () => {
    const result = await runTrimOnce('/nonexistent/path/db.sqlite');
    expect(result.framesDeleted).toBe(0);
    expect(result.elementsDeleted).toBe(0);
    expect(result.reachedFloor).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns zero retention counts when no budget is configured', async () => {
    const root = await mkdtemp(join(testTempRoot(), 'screenpipe-trim-no-budget-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, 'db.sqlite');

    const result = await runTrimOnce(dbPath);

    expect(result.framesDeleted).toBe(0);
    expect(result.elementsDeleted).toBe(0);
    expect(result.reachedFloor).toBe(false);
  });
});
