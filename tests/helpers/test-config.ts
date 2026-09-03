import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const APP_DIRECTORY_NAME = '.computer-history-mcp';

export async function writeTestConfig(homeDir: string, config: {
  embeddingBaseUrl: string;
  screenpipeBaseUrl: string;
  screenpipeApiKey?: string;
  authToken?: string;
  embeddingConcurrency?: number;
  mode?: 'stdio' | 'http';
  port?: number;
  pollIntervalSeconds?: number;
  vectorStorePath?: string;
  maxCatchUpBatches?: number;
  maxCatchUpRecords?: number;
}): Promise<string> {
  const appDir = join(homeDir, APP_DIRECTORY_NAME);
  await mkdir(appDir, { recursive: true });

  const filePath = join(appDir, 'config.yaml');
  const content = [
    'server:',
    `  mode: ${config.mode ?? 'http'}`,
    '  host: 127.0.0.1',
    `  port: ${config.port ?? 8765}`,
    ...((config.mode ?? 'http') === 'http' ? [`  authToken: ${config.authToken ?? 'test-http-token'}`] : []),
    'logging:',
    '  level: info',
    'screenpipe:',
    `  url: ${config.screenpipeBaseUrl}`,
    ...(config.screenpipeApiKey ? [`  apiKey: ${config.screenpipeApiKey}`] : []),
    'providers:',
    '  embeddings:',
    '    kind: openai-compatible',
    `    baseUrl: ${config.embeddingBaseUrl}`,
    '    model: acceptance-embedding-model',
    `    concurrency: ${config.embeddingConcurrency ?? 2}`,
    'vectorStore:',
    '  kind: sqlite',
    ...(config.vectorStorePath ? [`  path: ${config.vectorStorePath}`] : []),
    'retrieval:',
    '  freshnessWindowMinutes: 15',
    `  pollIntervalSeconds: ${config.pollIntervalSeconds ?? 30}`,
    `  maxCatchUpBatches: ${config.maxCatchUpBatches ?? 3}`,
    `  maxCatchUpRecords: ${config.maxCatchUpRecords ?? 500}`,
    'routines:',
    '  enabled: false'
  ].join('\n');

  await writeFile(filePath, `${content}\n`, 'utf8');
  return filePath;
}
