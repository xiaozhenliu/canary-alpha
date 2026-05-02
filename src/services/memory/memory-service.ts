import type {
  MemoryReadRequest,
  MemoryReadResult,
  MemoryScope,
  MemorySections,
  MemoryService,
  MemoryStore,
  MemoryWriteRequest,
  MemoryWriteResult
} from './types.js';

function formatAllMemorySections(sections: MemorySections): string {
  return `memory:\n${sections.memory}\n\nuser:\n${sections.user}`;
}

export class DefaultMemoryService implements MemoryService {
  constructor(private readonly store: MemoryStore) {}

  async read(request: MemoryReadRequest): Promise<MemoryReadResult> {
    const memory = await this.store.read('memory');
    const user = await this.store.read('user');
    const sections = { memory, user };

    return {
      scope: request.scope,
      content: request.scope === 'all' ? formatAllMemorySections(sections) : sections[request.scope],
      ...sections
    };
  }

  async write(request: MemoryWriteRequest): Promise<MemoryWriteResult> {
    const nextContent = request.mode === 'replace'
      ? request.content
      : await this.buildAppendedContent(request.scope, request.content);

    await this.store.write(request.scope, nextContent);

    return {
      scope: request.scope,
      mode: request.mode,
      content: nextContent
    };
  }

  private async buildAppendedContent(scope: MemoryScope, content: string): Promise<string> {
    const existing = await this.store.read(scope);
    return existing ? `${existing}\n\n${content}` : content;
  }
}
