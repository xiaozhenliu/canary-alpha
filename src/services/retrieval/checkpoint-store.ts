import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { IndexedCheckpoint, CheckpointStore } from './types.js';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export class FileCheckpointStore implements CheckpointStore {
  constructor(private readonly filePath: string) {}

  async readLatest(): Promise<IndexedCheckpoint | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as IndexedCheckpoint;
      return parsed;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async writeLatest(checkpoint: IndexedCheckpoint): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: PRIVATE_DIR_MODE });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(checkpoint, null, 2), { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await rename(tempPath, this.filePath);
  }

  async reset(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
