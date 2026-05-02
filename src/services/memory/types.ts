export type MemoryScope = 'memory' | 'user';
export type MemoryReadScope = MemoryScope | 'all';
export type MemoryWriteMode = 'append' | 'replace';

export interface MemorySections {
  memory: string;
  user: string;
}

export interface MemoryReadRequest {
  scope: MemoryReadScope;
}

export interface MemoryWriteRequest {
  scope: MemoryScope;
  content: string;
  mode: MemoryWriteMode;
}

export interface MemoryReadResult extends MemorySections {
  scope: MemoryReadScope;
  content: string;
}

export interface MemoryWriteResult {
  scope: MemoryScope;
  mode: MemoryWriteMode;
  content: string;
}

export interface MemoryStore {
  read(scope: MemoryScope): Promise<string>;
  write(scope: MemoryScope, content: string): Promise<void>;
}

export interface MemoryService {
  read(request: MemoryReadRequest): Promise<MemoryReadResult>;
  write(request: MemoryWriteRequest): Promise<MemoryWriteResult>;
}
