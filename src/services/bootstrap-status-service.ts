import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveScreenpipeDirectory } from '../config/paths.js';
import { inspectScreenpipeSqlite } from './diagnostics/storage-diagnostics.js';
import type { AppConfig, AppServices, BootstrapStatus } from '../types/app-config.js';
import type { CheckpointStore, IndexedCheckpoint, VectorStoreInspection, VectorStore } from './retrieval/types.js';

const VECTOR_STORE_INSPECTION_TIMEOUT_MS = 250;

interface BootstrapStatusDependencies {
  checkpointStore: CheckpointStore;
  vectorStore: VectorStore;
}

async function inspectVectorStoreWithTimeout(vectorStore: VectorStore): Promise<VectorStoreInspection | undefined> {
  if (!vectorStore.inspect) {
    return undefined;
  }

  try {
    return await Promise.race([
      vectorStore.inspect(),
      delay(VECTOR_STORE_INSPECTION_TIMEOUT_MS).then(() => ({
        persisted: true,
        readable: false
      } satisfies VectorStoreInspection))
    ]);
  } catch {
    return {
      persisted: true,
      readable: false
    };
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidIndexedCheckpoint(checkpoint: IndexedCheckpoint | null): checkpoint is IndexedCheckpoint {
  if (!isObjectRecord(checkpoint) || typeof checkpoint.timestamp !== 'string') {
    return false;
  }

  if (checkpoint.cursor !== undefined && typeof checkpoint.cursor !== 'string') {
    return false;
  }

  if (checkpoint.backlog === undefined) {
    return true;
  }

  return isObjectRecord(checkpoint.backlog)
    && typeof checkpoint.backlog.from === 'string'
    && typeof checkpoint.backlog.to === 'string'
    && typeof checkpoint.backlog.nextOffset === 'number'
    && Number.isFinite(checkpoint.backlog.nextOffset);
}

export class BootstrapStatusService {
  constructor(
    private readonly config: AppConfig,
    private readonly deps: BootstrapStatusDependencies
  ) {}

  async getStatus(address?: AddressInfo | null): Promise<BootstrapStatus> {
    const screenpipeStorage = await inspectScreenpipeSqlite(resolveScreenpipeDirectory());

    try {
      const checkpoint = await this.deps.checkpointStore.readLatest();
      const usableCheckpoint = isValidIndexedCheckpoint(checkpoint) ? checkpoint : null;
      const vectorStoreState = await inspectVectorStoreWithTimeout(this.deps.vectorStore);
      const vectorStoreReadable = vectorStoreState?.readable ?? true;
      const vectorStorePersisted = vectorStoreState?.persisted ?? false;
      const vectorStoreRecordCount = vectorStoreState?.recordCount;
      const checkpointNeedsRecovery = usableCheckpoint === null || usableCheckpoint.backlog !== undefined;
      const emptyButUsableVectorStore = usableCheckpoint !== null
        && vectorStoreReadable
        && vectorStorePersisted === false
        && vectorStoreRecordCount === 0;
      const recoveryStatus = !vectorStoreReadable
        ? 'degraded'
        : checkpointNeedsRecovery || (!vectorStorePersisted && !emptyButUsableVectorStore)
          ? 'needs-rebuild'
          : 'ready';

      return {
        status: 'ok',
        mode: this.config.server.mode,
        host: address?.address ?? this.config.server.host,
        port: address?.port ?? this.config.server.port,
        pid: process.pid,
        configFile: this.config.paths.configFile,
        retrieval: {
          checkpointExists: checkpoint !== null,
          checkpointTimestamp: usableCheckpoint?.timestamp,
          vectorStoreKind: this.deps.vectorStore.kind,
          recoveryStatus
        },
        screenpipeStorage
      };
    } catch {
      return {
        status: 'ok',
        mode: this.config.server.mode,
        host: address?.address ?? this.config.server.host,
        port: address?.port ?? this.config.server.port,
        pid: process.pid,
        configFile: this.config.paths.configFile,
        retrieval: {
          checkpointExists: false,
          vectorStoreKind: this.deps.vectorStore.kind,
          recoveryStatus: 'degraded'
        },
        screenpipeStorage
      };
    }
  }
}

export function createServices(
  config: AppConfig,
  deps: BootstrapStatusDependencies
): Pick<AppServices, 'bootstrapStatus'> {
  const bootstrapStatus = new BootstrapStatusService(config, deps);

  return {
    bootstrapStatus
  };
}
