import { join } from 'node:path';

import { resolveScreenpipeDirectory } from '../../config/paths.js';
import type { AppConfig } from '../../types/app-config.js';
import { createScreenpipeClient } from './providers/screenpipe/http-client.js';
import { DefaultScreenpipeControlService } from './providers/screenpipe/control-service.js';
import { SqliteScreenpipeFramesReader } from './providers/screenpipe/frames-reader.js';
import { createScreenpipeMaintenanceAdapter } from './providers/screenpipe/maintenance-adapter.js';
import type {
  CaptureCapabilities,
  CaptureClient,
  CaptureFrameDetailPort,
  CaptureLifecyclePort,
  CaptureMaintenancePort
} from './types.js';

/**
 * Everything a capture provider contributes to the app. `frameDetail`,
 * `lifecycle`, and `maintenance` are optional — absence must match the
 * corresponding capability flag being false.
 */
export interface CaptureProvider {
  capabilities: CaptureCapabilities;
  client: CaptureClient;
  frameDetail?: CaptureFrameDetailPort;
  lifecycle?: CaptureLifecyclePort;
  /**
   * AX-tree sweep and storage-reclaim maintenance port. Present only when
   * capabilities.axTreeMaintenance is true. Upper layers use this port
   * instead of accessing provider storage directly.
   */
  maintenance?: CaptureMaintenancePort;
  /**
   * Absolute path of the provider's upstream SQLite database, consumed by
   * the trim poller and privacy delete-range. Only providers with
   * `capabilities.retentionTrim === true` define it. This stays a path (not
   * a port object) in this phase because runTrimOnce's transaction logic is
   * deeply Screenpipe-specific; Stage 4 keeps it gated behind the
   * capability flag so a trim-less provider simply never schedules the
   * poller.
   */
  upstreamDatabasePath?: string;
}

/** Canonical provider name for Screenpipe. Use this constant instead of the bare string literal. */
export const SCREENPIPE_PROVIDER_NAME = 'screenpipe' as const;

function createScreenpipeProvider(config: AppConfig): CaptureProvider {
  const dbPath = join(resolveScreenpipeDirectory(config.screenpipe.dataDirectory), 'db.sqlite');
  return {
    capabilities: {
      providerName: SCREENPIPE_PROVIDER_NAME,
      ocrText: true,
      accessibilityTree: true,
      frameDetail: true,
      retentionTrim: true,
      processLifecycle: true,
      axTreeMaintenance: true
    },
    client: createScreenpipeClient(config.screenpipe.url, config.screenpipe.apiKey),
    frameDetail: new SqliteScreenpipeFramesReader(dbPath),
    lifecycle: new DefaultScreenpipeControlService({ url: config.screenpipe.url }),
    maintenance: createScreenpipeMaintenanceAdapter({ databasePath: dbPath }),
    upstreamDatabasePath: dbPath
  };
}

export function createCaptureProvider(config: AppConfig): CaptureProvider {
  switch (config.capture.provider) {
    case 'screenpipe':
      return createScreenpipeProvider(config);
    default: {
      // Exhaustiveness guard — a new enum member without a factory branch
      // fails here at runtime and in the switch's never-check at compile time.
      const exhaustive: never = config.capture.provider;
      throw new Error(`Unknown capture provider: ${String(exhaustive)}`);
    }
  }
}
