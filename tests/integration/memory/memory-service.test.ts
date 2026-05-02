import { describe, expect, it } from 'vitest';

import { DefaultMemoryService } from '../../../src/services/memory/memory-service.js';
import type { MemoryScope, MemoryStore } from '../../../src/services/memory/types.js';

class InMemoryStore implements MemoryStore {
  private readonly contents = new Map<MemoryScope, string>();

  async read(scope: MemoryScope): Promise<string> {
    return this.contents.get(scope) ?? '';
  }

  async write(scope: MemoryScope, content: string): Promise<void> {
    this.contents.set(scope, content);
  }
}

describe('memory service', () => {
  it('appends with exactly two newline characters between blocks', async () => {
    const service = new DefaultMemoryService(new InMemoryStore());

    await service.write({
      scope: 'memory',
      content: 'first block',
      mode: 'append'
    });

    const result = await service.write({
      scope: 'memory',
      content: 'second block',
      mode: 'append'
    });

    expect(result.content).toBe('first block\n\nsecond block');
    await expect(service.read({ scope: 'memory' })).resolves.toMatchObject({
      content: 'first block\n\nsecond block',
      memory: 'first block\n\nsecond block',
      user: ''
    });
  });

  it('replaces the full target scope document', async () => {
    const service = new DefaultMemoryService(new InMemoryStore());

    await service.write({
      scope: 'user',
      content: 'old content',
      mode: 'append'
    });

    const result = await service.write({
      scope: 'user',
      content: 'new content',
      mode: 'replace'
    });

    expect(result.content).toBe('new content');
    await expect(service.read({ scope: 'user' })).resolves.toMatchObject({
      content: 'new content',
      memory: '',
      user: 'new content'
    });
  });

  it('returns memory and user sections in fixed order for scope all', async () => {
    const service = new DefaultMemoryService(new InMemoryStore());

    await service.write({
      scope: 'memory',
      content: 'memory notes',
      mode: 'append'
    });
    await service.write({
      scope: 'user',
      content: 'user profile',
      mode: 'append'
    });

    await expect(service.read({ scope: 'all' })).resolves.toMatchObject({
      scope: 'all',
      content: 'memory:\nmemory notes\n\nuser:\nuser profile',
      memory: 'memory notes',
      user: 'user profile'
    });
  });

  it('returns empty strings for scopes that have not been written yet', async () => {
    const service = new DefaultMemoryService(new InMemoryStore());

    await expect(service.read({ scope: 'all' })).resolves.toMatchObject({
      content: 'memory:\n\n\nuser:\n',
      memory: '',
      user: ''
    });
  });
});
