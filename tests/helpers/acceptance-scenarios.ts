import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScreenpipeRecord } from '../../src/services/retrieval/types.js';
import { type ConnectedClient, connectHttpClient, connectStdioClient } from './mcp-client.js';
import { startEmbeddingStub } from './embedding-stub.js';
import { startHttpServer, type StartedHttpServer } from './start-http-server.js';
import { startScreenpipeStub, type ScreenpipeStubController } from './screenpipe-stub.js';
import { writeTestConfig } from './test-config.js';

function minusMinutes(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export interface AcceptanceWorkflowScenario {
  homeDir: string;
  addRecord(record: ScreenpipeRecord): void;
  connect(): Promise<ConnectedClient>;
  cleanup(): Promise<void>;
}

interface ScenarioOptions {
  prefix: string;
  mode: 'stdio' | 'http';
  records: ScreenpipeRecord[];
  port?: number;
}

async function setupWorkflowScenario(options: ScenarioOptions): Promise<AcceptanceWorkflowScenario> {
  const homeDir = await mkdtemp(join(tmpdir(), options.prefix));
  const screenpipe = await startScreenpipeStub({ records: options.records });
  const embedding = await startEmbeddingStub();

  await writeTestConfig(homeDir, {
    embeddingBaseUrl: embedding.url,
    screenpipeBaseUrl: screenpipe.url,
    mode: options.mode,
    port: options.port
  });

  await writeFile(
    join(homeDir, '.screenpipe-memory-mcp', 'retrieval-checkpoint.json'),
    JSON.stringify({
      cursor: `${options.prefix}-checkpoint`,
      timestamp: minusMinutes(2)
    }, null, 2),
    'utf8'
  );

  let server: StartedHttpServer | undefined;
  if (options.mode === 'http') {
    server = await startHttpServer(options.port ?? 8765, { HOME: homeDir });
  }

  return {
    homeDir,
    addRecord(record: ScreenpipeRecord): void {
      screenpipe.addRecord(record);
    },
    async connect(): Promise<ConnectedClient> {
      if (options.mode === 'http') {
        if (!server) {
          throw new Error('HTTP acceptance scenario server was not started.');
        }

        return connectHttpClient(server.port);
      }

      return connectStdioClient({ HOME: homeDir });
    },
    async cleanup(): Promise<void> {
      await Promise.allSettled([
        server?.stop(),
        screenpipe.stop(),
        embedding.stop()
      ]);
      await rm(homeDir, { recursive: true, force: true });
    }
  };
}

export async function setupRetrievalWorkflowScenario(options: {
  prefix: string;
  mode: 'stdio' | 'http';
  records: ScreenpipeRecord[];
  port?: number;
}): Promise<AcceptanceWorkflowScenario> {
  return setupWorkflowScenario(options);
}

export async function setupMemoryWorkflowScenario(options: {
  prefix: string;
  mode?: 'stdio';
}): Promise<AcceptanceWorkflowScenario> {
  return setupWorkflowScenario({
    prefix: options.prefix,
    mode: options.mode ?? 'stdio',
    records: []
  });
}
