import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveScreenpipeDirectory } from '../config/paths.js';
import { inspectScreenpipeSqlite } from './diagnostics/storage-diagnostics.js';
import {
  IngestionObservabilityService,
  type RuntimeProcessRegistry
} from './diagnostics/ingestion-observability-service.js';
import { findActiveRuntimeProcesses } from './runtime-process-registry.js';
import type { AppConfig, AppServices, BootstrapStatus } from '../types/app-config.js';
import type { CheckpointStore, IndexedCheckpoint, VectorStoreInspection, VectorStore } from './retrieval/types.js';
import type { WorkActivityObservabilityService } from './work-activity/observability/work-activity-observability-service.js';

const VECTOR_STORE_INSPECTION_TIMEOUT_MS = 250;

interface BootstrapStatusDependencies {
  checkpointStore: CheckpointStore;
  vectorStore: VectorStore;
  /**
   * Work-activity-analysis read-only rollup (design §9.2). Optional so
   * unit tests / partial bootstrap paths can keep wiring just the
   * upstream slice; production wires the real service in
   * {@link ../bootstrap/create-app.ts}. When absent, the four
   * `extraction` / `sessions` / `summary` / `providers` blocks are
   * simply omitted from the response — same shape contract the
   * upstream observability service follows when its collection fails.
   */
  workActivityObservability?: WorkActivityObservabilityService;
  /**
   * Upstream capture data directory (the Screenpipe home capture folder).
   * Optional injection point: production omits it and falls back to
   * {@link resolveScreenpipeDirectory} (the real home-relative path), while
   * integration tests pass a fixture directory so `screenpipeStorage` and the
   * disk-budget / capture observability blocks read the test's SQLite fixture
   * instead of the developer's real multi-gigabyte capture database. Without
   * this seam `getStatus()` always inspected the real directory, which made the
   * disk-budget assertions non-deterministic (they compared a hard-coded budget
   * against the real db size). See tech-debt TD-009.
   */
  screenpipeDirectory?: string;
}

/**
 * Adapts the file-based runtime-process-registry to the RuntimeProcessRegistry
 * interface expected by IngestionObservabilityService.
 */
class RuntimeProcessRegistryAdapter implements RuntimeProcessRegistry {
  constructor(private readonly config: AppConfig) {}

  async hasActiveProcess(): Promise<boolean> {
    try {
      const records = await findActiveRuntimeProcesses(this.config);
      return records.length > 0;
    } catch {
      return false;
    }
  }

  async getProcessStartedAt(): Promise<string | null> {
    try {
      const records = await findActiveRuntimeProcesses(this.config);
      if (records.length === 0) {
        return null;
      }
      // Sort by registeredAt descending to get the most recently registered process.
      const sorted = [...records].sort((a, b) => {
        const aAt = (a as unknown as Record<string, unknown>)['registeredAt'] as string | undefined ?? '';
        const bAt = (b as unknown as Record<string, unknown>)['registeredAt'] as string | undefined ?? '';
        return bAt.localeCompare(aAt);
      });
      const first = sorted[0] as unknown as Record<string, unknown>;
      const startedAt = first['processStartedAt'];
      return typeof startedAt === 'string' ? startedAt : null;
    } catch {
      return null;
    }
  }
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
    // Prefer the injected upstream directory (tests point this at a fixture);
    // fall back to the real home-relative capture directory in production.
    const screenpipeDirectory = this.deps.screenpipeDirectory ?? resolveScreenpipeDirectory();
    const screenpipeStorage = await inspectScreenpipeSqlite(screenpipeDirectory);

    // Collect ingestion observability signals (capture, ingestionMix, diskBudget).
    // Failures here are non-fatal: the three blocks are simply omitted from the response.
    let capture: BootstrapStatus['capture'];
    let ingestionMix: BootstrapStatus['ingestionMix'];
    let diskBudget: BootstrapStatus['diskBudget'];

    try {
      const observabilityService = new IngestionObservabilityService({
        screenpipeDirectory,
        vectorStore: this.deps.vectorStore,
        runtimeRegistry: new RuntimeProcessRegistryAdapter(this.config),
        config: this.config,
        now: () => new Date()
      });
      const observability = await observabilityService.collect();
      capture = observability.capture;
      ingestionMix = observability.ingestionMix;
      diskBudget = observability.diskBudget;
    } catch {
      // Observability collection failed; omit the three blocks rather than failing the whole status call.
    }

    // Collect work-activity rollup (design §9.2). The service's own
    // `collect()` already absorbs per-section failures into the
    // `degraded` map (W5 / W6 / W12 / W24), so this outer try/catch
    // only fires when the entire service blows up — at which point
    // we omit all four blocks rather than crashing `internal-status`.
    let extraction: BootstrapStatus['extraction'];
    let sessions: BootstrapStatus['sessions'];
    let summary: BootstrapStatus['summary'];
    let providers: BootstrapStatus['providers'];
    let degraded: BootstrapStatus['degraded'];

    if (this.deps.workActivityObservability !== undefined) {
      try {
        const rollup = await this.deps.workActivityObservability.collect();
        extraction = rollup.extraction;
        sessions = rollup.sessions;
        summary = rollup.summary;
        providers = rollup.providers;
        // Only surface `degraded` when the service itself populated
        // it — otherwise the field is omitted entirely so a healthy
        // status response stays minimal.
        if (rollup.degraded !== undefined) {
          degraded = rollup.degraded;
        }
      } catch {
        // Whole-service failure: omit all four blocks. We deliberately
        // do NOT synthesise a `degraded` envelope here — the design
        // §9 Error Handling contract reserves `degraded.<section>` for
        // per-section failures the service itself attempted, not for
        // the "service didn't run at all" case.
      }
    }

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
        capture,
        ingestionMix,
        diskBudget,
        retrieval: {
          checkpointExists: checkpoint !== null,
          checkpointTimestamp: usableCheckpoint?.timestamp,
          vectorStoreKind: this.deps.vectorStore.kind,
          recoveryStatus
        },
        screenpipeStorage,
        ...(extraction !== undefined ? { extraction } : {}),
        ...(sessions !== undefined ? { sessions } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(providers !== undefined ? { providers } : {}),
        ...(degraded !== undefined ? { degraded } : {})
      };
    } catch {
      return {
        status: 'ok',
        mode: this.config.server.mode,
        host: address?.address ?? this.config.server.host,
        port: address?.port ?? this.config.server.port,
        pid: process.pid,
        configFile: this.config.paths.configFile,
        capture,
        ingestionMix,
        diskBudget,
        retrieval: {
          checkpointExists: false,
          vectorStoreKind: this.deps.vectorStore.kind,
          recoveryStatus: 'degraded'
        },
        screenpipeStorage,
        ...(extraction !== undefined ? { extraction } : {}),
        ...(sessions !== undefined ? { sessions } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(providers !== undefined ? { providers } : {}),
        ...(degraded !== undefined ? { degraded } : {})
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
