declare module '../../scripts/onboarding-config.js' {
  export const APP_DIRECTORY_NAME: string;
  export const CONFIG_FILE_NAME: string;
  export const LOG_DIRECTORY_NAME: string;
  export const MINIMUM_NODE_MAJOR: number;
  export const DEFAULT_SERVER_PORT: number;
  export const DEFAULT_SCREENPIPE_URL: string;
  export const DEFAULT_OLLAMA_BASE_URL: string;
  export const DEFAULT_OLLAMA_MODEL: string;
  export const DEFAULT_HOSTED_BASE_URL: string;
  export const DEFAULT_HOSTED_MODEL: string;

  export function parseNodeMajorVersion(version: string): number;
  export function ensureSupportedNodeVersion(version?: string): void;
  export function resolveAppPaths(homeDirectory?: string): {
    appDirectory: string;
    configPath: string;
    logDirectory: string;
  };
  export function createOllamaEmbeddingsConfig(options?: {
    baseUrl?: string;
    model?: string;
  }): {
    kind: 'ollama';
    baseUrl: string;
    model: string;
  };
  export function createHostedEmbeddingsConfig(options: {
    kind?: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
  }): {
    kind: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
  };
  export function buildConfigObject(options?: {
    port?: number;
    screenpipeUrl?: string;
    vectorStorePath?: string;
    embeddings?: {
      kind: string;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
    };
  }): Record<string, unknown>;
  export function buildConfigYaml(options?: {
    port?: number;
    screenpipeUrl?: string;
    vectorStorePath?: string;
    embeddings?: {
      kind: string;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
    };
  }): string;
  export function ensureAppDirectories(paths: {
    appDirectory: string;
    logDirectory: string;
  }): Promise<void>;
  export function backupConfigIfPresent(configPath: string, backupDirectory: string, now?: Date): Promise<string | null>;
  export function writeConfigYamlFile(configPath: string, options?: {
    port?: number;
    screenpipeUrl?: string;
    vectorStorePath?: string;
    embeddings?: {
      kind: string;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
    };
  }): Promise<string>;
  export function ensureDependenciesInstalled(repositoryRoot: string): boolean;
}
