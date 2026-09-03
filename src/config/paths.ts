import { homedir } from 'node:os';
import { join } from 'node:path';

import type { MemoryScope } from '../services/memory/types.js';
import type { AppConfig } from '../types/app-config.js';

export const APP_DIRECTORY_NAME = '.computer-history-mcp';
export const SCREENPIPE_DIRECTORY_NAME = '.screenpipe';
export const CONFIG_FILE_NAME = 'config.yaml';
export const CONFIG_PATH_SEGMENT = '.computer-history-mcp/config.yaml';
export const MEMORY_DIRECTORY_NAME = 'memory';
export const LOG_DIRECTORY_NAME = 'logs';
export const ROUTINES_DIRECTORY_NAME = 'routines';
export const ROUTINE_DEFINITIONS_DIRECTORY_NAME = 'definitions';
export const ROUTINE_HISTORY_DIRECTORY_NAME = 'history';
export const SERVICE_LOG_FILE_NAME = 'service.log';
export const PRIVACY_STATE_FILE_NAME = 'privacy-state.json';
export const RUNTIME_REGISTRY_DIRECTORY_NAME = 'runtime-processes';
export const REBUILD_LOCK_FILE_NAME = 'rebuild-index.lock';
export const DERIVED_DATABASE_FILE_NAME = 'derived.sqlite';

export function resolveAppDirectory(): string {
  return join(homedir(), APP_DIRECTORY_NAME);
}

export function resolveHomePath(configuredPath: string): string {
  return configuredPath.startsWith('~/')
    ? join(homedir(), configuredPath.slice(2))
    : configuredPath;
}

export function resolveScreenpipeDirectory(configuredPath = `~/${SCREENPIPE_DIRECTORY_NAME}`): string {
  return resolveHomePath(configuredPath);
}

export function resolveScreenpipeBinaryPath(configuredPath = 'screenpipe'): string {
  return resolveHomePath(configuredPath);
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

export function resolveRoutinesDirectory(): string {
  return join(resolveAppDirectory(), ROUTINES_DIRECTORY_NAME);
}

export function resolveRoutineDefinitionsDirectory(): string {
  return join(resolveRoutinesDirectory(), ROUTINE_DEFINITIONS_DIRECTORY_NAME);
}

export function resolveRoutineHistoryDirectory(): string {
  return join(resolveRoutinesDirectory(), ROUTINE_HISTORY_DIRECTORY_NAME);
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

/**
 * Resolve the derived SQLite database path used by the work-activity-analysis layer.
 *
 * Resolution order:
 * 1. Explicit `config.paths.derivedDatabase` (supports `~/...` expansion)
 * 2. Default: `<app dir>/derived.sqlite` (typically `~/.computer-history-mcp/derived.sqlite`)
 *
 * Accepts a partial config so this helper can be called pre-bootstrap (e.g. CLI tools).
 */
export function resolveDerivedDatabasePath(config?: { paths?: { derivedDatabase?: string } }): string {
  const configured = config?.paths?.derivedDatabase;
  if (configured && configured.length > 0) {
    return resolveHomePath(configured);
  }
  return join(resolveAppDirectory(), DERIVED_DATABASE_FILE_NAME);
}
