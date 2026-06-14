/**
 * AX-tree maintenance service — provider-neutral facade.
 *
 * This module re-exports the result types that callers already import from
 * here (SweepResult, ReclaimResult, MaintenanceStatus) and wraps a
 * CaptureMaintenancePort so the scheduling / orchestration layer can call
 * sweepOnce / reclaimOnce / status without knowing which storage backend is
 * in use.
 *
 * Screenpipe-specific SQL (all direct frames/elements table access) lives
 * exclusively in:
 *   src/services/capture/providers/screenpipe/maintenance-adapter.ts
 *
 * When a databasePath is supplied instead of a port (backwards-compat path
 * used by tests and the stand-alone CLI script), a ScreenpipeMaintenanceAdapter
 * is constructed automatically so existing call-sites continue to work without
 * changes.
 */

import { createScreenpipeMaintenanceAdapter } from '../capture/providers/screenpipe/maintenance-adapter.js';
import type {
  CaptureMaintenancePort,
  CaptureSweepResult,
  CaptureReclaimResult,
  CaptureMaintenanceStatus
} from '../capture/types.js';

// ---------------------------------------------------------------------------
// Legacy type aliases — kept so existing imports keep compiling.
// ---------------------------------------------------------------------------

/** @deprecated Use CaptureSweepResult from services/capture/types.js instead. */
export type SweepResult = CaptureSweepResult;

/** @deprecated Use CaptureReclaimResult from services/capture/types.js instead. */
export type ReclaimResult = CaptureReclaimResult;

/** @deprecated Use CaptureMaintenanceStatus from services/capture/types.js instead. */
export type MaintenanceStatus = CaptureMaintenanceStatus;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MaintenanceServiceOptions {
  /**
   * Absolute path to the upstream SQLite database.
   * Used to auto-create a ScreenpipeMaintenanceAdapter when `maintenancePort`
   * is not provided — maintained for backwards compatibility with tests and
   * the stand-alone CLI maintenance script.
   */
  databasePath?: string;
  /**
   * Explicit CaptureMaintenancePort implementation. When supplied, databasePath
   * is ignored. The bootstrap wires this from the capture provider so all
   * storage access goes through the provider boundary.
   */
  maintenancePort?: CaptureMaintenancePort;
  minFrameAgeMs?: number;
  batchSize?: number;
  now?: () => Date;
  logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => void };
  beforeConvertTxn?: () => void;
  busyTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAxTreeMaintenanceService(options: MaintenanceServiceOptions) {
  // Resolve the underlying port: prefer an explicit port, fall back to
  // building a Screenpipe adapter from databasePath for backwards compat.
  let port: CaptureMaintenancePort;
  if (options.maintenancePort) {
    port = options.maintenancePort;
  } else if (options.databasePath) {
    port = createScreenpipeMaintenanceAdapter({
      databasePath: options.databasePath,
      minFrameAgeMs: options.minFrameAgeMs,
      batchSize: options.batchSize,
      now: options.now,
      beforeConvertTxn: options.beforeConvertTxn,
      busyTimeoutMs: options.busyTimeoutMs,
      logger: options.logger
    });
  } else {
    throw new Error('createAxTreeMaintenanceService: either maintenancePort or databasePath must be provided');
  }

  function sweepOnce(): SweepResult {
    return port.sweepOnce({
      minFrameAgeMs: options.minFrameAgeMs,
      batchSize: options.batchSize,
      now: options.now,
      beforeConvertTxn: options.beforeConvertTxn,
      busyTimeoutMs: options.busyTimeoutMs
    });
  }

  function reclaimOnce(opts: { maxPages?: number } = {}): ReclaimResult {
    return port.reclaimOnce({
      maxPages: opts.maxPages,
      busyTimeoutMs: options.busyTimeoutMs
    });
  }

  function status(): MaintenanceStatus {
    return port.status();
  }

  return { sweepOnce, reclaimOnce, status };
}
