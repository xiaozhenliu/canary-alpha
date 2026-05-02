import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { MemoryScope, MemoryStore } from './types.js';

export class FileMemoryStore implements MemoryStore {
  constructor(private readonly filePaths: Record<MemoryScope, string>) {}

  async read(scope: MemoryScope): Promise<string> {
    try {
      return await readFile(this.filePaths[scope], 'utf8');
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return '';
      }

      throw error;
    }
  }

  async write(scope: MemoryScope, content: string): Promise<void> {
    const filePath = this.filePaths[scope];
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  }
}
