import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileMemoryStore } from '../../../src/services/memory/memory-store.js';

describe('file memory store', () => {
  it('creates missing directories and writes scope files atomically', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memory-store-'));
    const memoryPath = join(tempDir, 'nested', 'memory.md');
    const userPath = join(tempDir, 'nested', 'user.md');
    const store = new FileMemoryStore({
      memory: memoryPath,
      user: userPath
    });

    try {
      await store.write('memory', 'persisted memory block');
      await store.write('user', 'persisted user block');

      await expect(readFile(memoryPath, 'utf8')).resolves.toBe('persisted memory block');
      await expect(readFile(userPath, 'utf8')).resolves.toBe('persisted user block');
      await expect(readFile(`${memoryPath}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(`${userPath}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns empty strings for scopes that have not been written yet', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memory-store-empty-'));
    const store = new FileMemoryStore({
      memory: join(tempDir, 'memory.md'),
      user: join(tempDir, 'user.md')
    });

    try {
      await expect(store.read('memory')).resolves.toBe('');
      await expect(store.read('user')).resolves.toBe('');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
