import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { testTempRoot } from './test-tmp.js';

export async function createTempVectorStorePath(prefix = 'canary-alpha-mcp-'): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const path = await mkdtemp(join(testTempRoot(), prefix));

  return {
    path,
    async cleanup(): Promise<void> {
      await rm(path, { recursive: true, force: true });
    }
  };
}
