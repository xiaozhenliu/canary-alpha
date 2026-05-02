import { homedir } from 'node:os';
import { join } from 'node:path';

import type { MemoryScope } from '../services/memory/types.js';
import type { AppConfig } from '../types/app-config.js';

export const APP_DIRECTORY_NAME = '.canary-alpha-mcp';
export const SCREENPIPE_DIRECTORY_NAME = '.screenpipe';
export const CONFIG_FILE_NAME = 'config.yaml';
export const CONFIG_PATH_SEGMENT = '.canary-alpha-mcp/config.yaml';
export const MEMORY_DIRECTORY_NAME = 'memory';
export const LOG_DIRECTORY_NAME = 'logs';
export const SERVICE_LOG_FILE_NAME = 'service.log';
export const PRIVACY_STATE_FILE_NAME = 'privacy-state.json';
export const RUNTIME_REGISTRY_DIRECTORY_NAME = 'runtime-processes';
export const REBUILD_LOCK_FILE_NAME = 'rebuild-index.lock';

export function resolveAppDirectory(): string {
  return join(homedir(), APP_DIRECTORY_NAME);
}

export function resolveScreenpipeDirectory(): string {
  return join(homedir(), SCREENPIPE_DIRECTORY_NAME);
}

export function resolveConfigPath(): string {
  return join(resolveAppDirectory(), CONFIG_FILE_NAME);
}

export function resolveMemoryDirectory(): string {
  return join(resolveAppDirectory(), MEMORY_DIRECTORY_NAME);
}

export function resolveMemoryFilePath(scope: MemoryScope): string {
  return join(resolveMemoryDirectory(), `${scope}.md`);
}

export function resolveLogDirectory(): string {
  return join(resolveAppDirectory(), LOG_DIRECTORY_NAME);
}

export function resolveLogFilePath(): string {
  return join(resolveLogDirectory(), SERVICE_LOG_FILE_NAME);
}

export function resolvePrivacyStatePath(): string {
  return join(resolveAppDirectory(), PRIVACY_STATE_FILE_NAME);
}

export function resolveRetrievalArtifactsDirectory(vectorStore?: AppConfig['vectorStore']): string {
  if (!vectorStore?.path) {
    return resolveAppDirectory();
  }

  return vectorStore.path.startsWith('~/')
    ? join(homedir(), vectorStore.path.slice(2))
    : vectorStore.path;
}

export function resolveRuntimeRegistryPath(vectorStore?: AppConfig['vectorStore']): string {
  return join(resolveRetrievalArtifactsDirectory(vectorStore), RUNTIME_REGISTRY_DIRECTORY_NAME);
}

export function resolveRebuildLockPath(vectorStore?: AppConfig['vectorStore']): string {
  return join(resolveRetrievalArtifactsDirectory(vectorStore), REBUILD_LOCK_FILE_NAME);
}
