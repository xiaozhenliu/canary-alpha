export interface EmbeddingsConfig {
  kind: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  concurrency?: number;
}

export interface HermesServerConfig {
  url: string;
  enabled: true;
  tools: {
    include: string[];
  };
}

export interface HermesConfigOptions {
  serverName?: string;
  tools?: string[];
}

export interface WriteHermesConfigResult {
  configPath: string;
  serverName: string;
  endpoint: string;
  yaml: string;
}

export interface OnboardingConfig {
  server: {
    mode: 'http';
    host: '127.0.0.1';
    port: number;
  };
  logging: {
    level: 'info';
  };
  screenpipe: {
    url: string;
    apiKey?: string;
  };
  providers: {
    embeddings: EmbeddingsConfig;
  };
  vectorStore: {
    kind: 'chroma';
    path?: string;
  };
  retrieval: {
    freshnessWindowMinutes: number;
    pollIntervalSeconds: number;
    maxCatchUpBatches: number;
    maxCatchUpRecords: number;
  };
}

export const APP_DIRECTORY_NAME: string;
export const CONFIG_FILE_NAME: string;
export const LOG_DIRECTORY_NAME: string;
export const HERMES_DIRECTORY_NAME: string;
export const HERMES_CONFIG_FILE_NAME: string;
export const DEFAULT_HERMES_SERVER_NAME: string;
export const DEFAULT_HERMES_TOOL_INCLUDE: string[];
export const MINIMUM_NODE_MAJOR: number;
export const DEFAULT_SERVER_PORT: number;
export const DEFAULT_SCREENPIPE_URL: string;
export const DEFAULT_OLLAMA_BASE_URL: string;
export const DEFAULT_OLLAMA_MODEL: string;
export const DEFAULT_HOSTED_BASE_URL: string;
export const DEFAULT_HOSTED_MODEL: string;
export const DEFAULT_EMBEDDING_CONCURRENCY: number;

export function parseNodeMajorVersion(version: string): number;
export function ensureSupportedNodeVersion(version?: string): void;
export function resolveAppPaths(homeDirectory?: string): {
  appDirectory: string;
  configPath: string;
  logDirectory: string;
};
export function resolveHermesPaths(homeDirectory?: string): {
  hermesDirectory: string;
  configPath: string;
};
export function buildHermesServerConfig(endpoint: string, options?: HermesConfigOptions): HermesServerConfig;
export function mergeHermesConfig(existingConfig: unknown, endpoint: string, options?: HermesConfigOptions): Record<string, unknown> & {
  mcp_servers: Record<string, unknown>;
};
export function writeHermesConfigFile(configPath: string, endpoint: string, options?: HermesConfigOptions): Promise<WriteHermesConfigResult>;
export function createOllamaEmbeddingsConfig(options?: {
  baseUrl?: string;
  model?: string;
  concurrency?: number;
}): {
  kind: 'ollama';
  baseUrl: string;
  model: string;
  concurrency: number;
};
export function createHostedEmbeddingsConfig(options: {
  kind?: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  concurrency?: number;
}): EmbeddingsConfig;
export function buildConfigObject(options?: {
  port?: number;
  screenpipeUrl?: string;
  screenpipeApiKey?: string;
  vectorStorePath?: string;
  embeddings?: EmbeddingsConfig;
}): OnboardingConfig;
export function buildConfigYaml(options?: {
  port?: number;
  screenpipeUrl?: string;
  screenpipeApiKey?: string;
  vectorStorePath?: string;
  embeddings?: EmbeddingsConfig;
}): string;
export function ensureAppDirectories(paths: {
  appDirectory: string;
  logDirectory: string;
}): Promise<void>;
export function backupConfigIfPresent(configPath: string, backupDirectory: string, now?: Date): Promise<string | null>;
export function writeConfigYamlFile(configPath: string, options?: {
  port?: number;
  screenpipeUrl?: string;
  screenpipeApiKey?: string;
  vectorStorePath?: string;
  embeddings?: EmbeddingsConfig;
}): Promise<string>;
export function ensureDependenciesInstalled(repositoryRoot: string): boolean;
