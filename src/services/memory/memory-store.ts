import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { MemoryScope, MemoryStore } from './types.js';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

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
    await mkdir(dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE });
    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await rename(tempPath, filePath);
  }
}
