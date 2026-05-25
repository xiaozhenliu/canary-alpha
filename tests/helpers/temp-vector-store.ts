import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createTempVectorStorePath(prefix = 'canary-alpha-mcp-'): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), prefix));

  return {
    path,
    async cleanup(): Promise<void> {
      await rm(path, { recursive: true, force: true });
    }
  };
}
