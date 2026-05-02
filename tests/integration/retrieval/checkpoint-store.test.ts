import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileCheckpointStore } from '../../../src/services/retrieval/checkpoint-store.js';

describe('file checkpoint store', () => {
  it('writes checkpoints atomically via temp-file replacement', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'checkpoint-store-'));
    const checkpointPath = join(tempDir, 'retrieval-checkpoint.json');
    const store = new FileCheckpointStore(checkpointPath);

    try {
      await store.writeLatest({
        cursor: 'checkpoint-1',
        timestamp: '2026-04-13T12:00:00.000Z'
      });

      await expect(readFile(checkpointPath, 'utf8')).resolves.toContain('checkpoint-1');
      await expect(readFile(`${checkpointPath}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
