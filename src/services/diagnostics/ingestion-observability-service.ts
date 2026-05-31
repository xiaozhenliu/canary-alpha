import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { stderr } from 'node:process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { AppConfig } from '../../types/app-config.js';
import type { VectorStore } from '../retrieval/types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// RuntimeProcessRegistry interface
// ---------------------------------------------------------------------------

/**
 * A lightweight registry that tracks whether a screenpipe / safe-record
 * process is currently alive.  The concrete implementation lives in
 * `runtime-process-registry.ts`; this interface is the seam used by
 * `IngestionObservabilityService` so it can be injected / stubbed in tests.
 */
export interface RuntimeProcessRegistry {
  /**
   * Returns `true` when at least one screenpipe or safe-record process is
   * registered and still alive.
   */
  hasActiveProcess(): Promise<boolean>;

  /**
   * Returns the ISO-8601 timestamp at which the most-recently-registered
   * process was started, or `null` if no process is registered / alive.
   */
  getProcessStartedAt(): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CaptureStatus {
  /**
   * Liveness state of the screenpipe capture pipeline.
   *
   * - `ok`                  – frames are being written within the liveness window
   * - `idle`                – process is running but no new frames within the window
   * - `process-down`        – no active screenpipe / safe-record process detected
   * - `permissions-missing` – process just started but frames table is still empty
   *                           (likely waiting for macOS Accessibility permission)
   * - `unknown`             – frames database not found or table is empty
   */
  state: 'ok' | 'idle' | 'process-down' | 'permissions-missing' | 'unknown';

  /** ISO-8601 timestamp of the most-recent frame, if available. */
  lastFrameTimestamp?: string;

  /** Threshold (seconds) used to classify `ok` vs `idle`. Default: 120. */
  livenessThresholdSeconds: number;

  /** Human-readable explanation; always present when `state !== "ok"`. */
  reason?: string;
}

export interface IngestionMix {
  /** Aggregation window in seconds (always 86 400 = 24 h). */
  windowSeconds: number;

  /** Number of vector-store records whose `sourceTypes` contains `"accessibility"`. */
  accessibilityCount: number;

  /**
   * Number of vector-store records whose `sourceTypes` contains `"ocr"` but
   * NOT `"accessibility"` (prevents double-counting merged records).
   */
  ocrCount: number;

  /**
   * `accessibilityCount / (accessibilityCount + ocrCount)`.
   * Returns `0.0` when both counts are zero (no division-by-zero).
   */
  ratio: number;
}

export interface DiskBudget {
  /** Configured budget in bytes, or `null` when no budget is set. */
  budgetBytes: number | null;

  /** Current size of `db.sqlite` in bytes. */
  currentSizeBytes: number;

  /**
   * `max(0, budgetBytes - currentSizeBytes)`, or `null` when `budgetBytes` is
   * `null`.
   */
  headroomBytes: number | null;

  /**
   * Non-empty string when `currentSizeBytes >= budgetBytes * 0.9`.
   * Describes the remediation action that will be taken on the next trim cycle.
   */
  warning?: string;
}

export interface IngestionObservability {
  capture: CaptureStatus;
  ingestionMix: IngestionMix;
  diskBudget: DiskBudget;
}

// ---------------------------------------------------------------------------
// Pure decision-table function (exported for property-based testing)
// ---------------------------------------------------------------------------

/**
 * Input parameters for the capture-state decision table.
 * All time values are in seconds (relative) or absolute Date objects.
 */
export interface CaptureStateInput {
  processRunning: boolean;
  /** ISO-8601 string of the most-recent frame, or null if no frames exist. */
  lastFrameTimestamp: string | null;
  /** Current wall-clock time. */
  now: Date;
  /** Threshold in seconds; frames older than this → idle. */
  livenessThresholdSeconds: number;
  /** When the process started, or null if unknown / not running. */
  processStartedAt: Date | null;
  /** Grace period in seconds after process start before expecting frames. */
  permissionsGracePeriodSeconds: number;
  /** Whether any frame has ever been written to the database. */
  framesEverWritten: boolean;
}

/**
 * Pure implementation of the Capture_Liveness decision table.
 *
 * This function contains no I/O and is exported so that property-based tests
 * can exercise all branches without touching the filesystem or sqlite3 CLI.
 *
 * Decision table (evaluated top-to-bottom, first match wins):
 *
 * 1. framesEverWritten == false AND processRunning == false
 *    → process-down / "no active screenpipe-safe-record process registered"
 * 2. framesEverWritten == false AND processRunning == true
 *    AND now - processStartedAt > permissionsGracePeriodSeconds
 *    → permissions-missing
 * 3. framesEverWritten == false AND processRunning == true
 *    AND now - processStartedAt <= permissionsGracePeriodSeconds
 *    → unknown / "frames database not found"
 * 4. framesEverWritten == true AND processRunning == false
 *    → process-down / "no active screenpipe-safe-record process registered"
 * 5. framesEverWritten == true AND processRunning == true
 *    AND now - lastFrameTimestamp > livenessThresholdSeconds
 *    → idle
 * 6. else → ok
 */
export function computeCaptureState(input: CaptureStateInput): CaptureStatus {
  const {
    processRunning,
    lastFrameTimestamp,
    now,
    livenessThresholdSeconds,
    processStartedAt,
    permissionsGracePeriodSeconds,
    framesEverWritten
  } = input;

  const processAgeSeconds =
    processStartedAt !== null
      ? (now.getTime() - processStartedAt.getTime()) / 1000
      : Infinity;

  // Rule 1 & 2 & 3: framesEverWritten == false
  if (!framesEverWritten) {
    if (!processRunning) {
      return {
        state: 'process-down',
        livenessThresholdSeconds,
        reason: 'no active screenpipe-safe-record process registered'
      };
    }

    // processRunning == true, no frames yet
    if (processAgeSeconds > permissionsGracePeriodSeconds) {
      return {
        state: 'permissions-missing',
        livenessThresholdSeconds,
        reason:
          'process is running but no frames have been written; macOS Accessibility permission may be missing'
      };
    }

    // Still within grace period
    return {
      state: 'unknown',
      livenessThresholdSeconds,
      reason: 'frames database not found'
    };
  }

  // Rule 4: framesEverWritten == true, process down
  if (!processRunning) {
    return {
      state: 'process-down',
      livenessThresholdSeconds,
      lastFrameTimestamp: lastFrameTimestamp!,
      reason: 'no active screenpipe-safe-record process registered'
    };
  }

  // Rule 5: framesEverWritten == true, process running, check liveness
  const lastFrameDate = new Date(lastFrameTimestamp!);
  const ageSeconds = (now.getTime() - lastFrameDate.getTime()) / 1000;

  if (ageSeconds > livenessThresholdSeconds) {
    return {
      state: 'idle',
      livenessThresholdSeconds,
      lastFrameTimestamp: lastFrameTimestamp!,
      reason: `no new frames in the last ${Math.round(ageSeconds)}s (threshold: ${livenessThresholdSeconds}s)`
    };
  }

  // Rule 6: all good
  return {
    state: 'ok',
    livenessThresholdSeconds,
    lastFrameTimestamp: lastFrameTimestamp!
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface IngestionObservabilityServiceDeps {
  screenpipeDirectory: string;
  vectorStore: VectorStore;
  runtimeRegistry: RuntimeProcessRegistry;
  config: AppConfig;
  now: () => Date;
}

/**
 * Collects observability signals for the ingestion pipeline and returns a
 * structured snapshot.  All data is derived from the existing SQLite database
 * and vector store – no new persistence is introduced.
 *
 * Tasks 8.2, 8.4, and 8.6 will fill in the full logic for each sub-section.
 * This skeleton wires up the constructor and exposes the `collect()` stub.
 */
export class IngestionObservabilityService {
  private readonly screenpipeDirectory: string;
  private readonly vectorStore: VectorStore;
  private readonly runtimeRegistry: RuntimeProcessRegistry;
  private readonly config: AppConfig;
  private readonly now: () => Date;

  constructor(deps: IngestionObservabilityServiceDeps) {
    this.screenpipeDirectory = deps.screenpipeDirectory;
    this.vectorStore = deps.vectorStore;
    this.runtimeRegistry = deps.runtimeRegistry;
    this.config = deps.config;
    this.now = deps.now;
  }

  /**
   * Collect a point-in-time observability snapshot.
   *
   * The full implementation is split across tasks 8.2 (capture), 8.4
   * (ingestionMix), and 8.6 (diskBudget).  This stub returns safe placeholder
   * values so that downstream callers (task 9) can be wired up before the
   * sub-sections are complete.
   */
  async collect(): Promise<IngestionObservability> {
    const livenessThresholdSeconds =
      this.config.capture.livenessThresholdSeconds;

    // --- capture (task 8.2: full decision table) ---
    const capture = await this.collectCapture(livenessThresholdSeconds);

    // --- ingestionMix (task 8.4: 24 h window aggregation) ---
    const ingestionMix = await this.collectIngestionMix();

    // --- diskBudget (task 8.6: fs.stat + 90% warning) ---
    const diskBudget = await this.collectDiskBudget();

    return { capture, ingestionMix, diskBudget };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Implements the Capture_Liveness decision table (design §Capture_Liveness).
   *
   * I/O layer: reads db.sqlite existence, queries sqlite3 CLI for MAX(timestamp),
   * and queries the runtimeRegistry.  The pure decision logic is delegated to
   * the exported `computeCaptureState` function so it can be tested without I/O.
   */
  private async collectCapture(
    livenessThresholdSeconds: number
  ): Promise<CaptureStatus> {
    const dbPath = path.join(this.screenpipeDirectory, 'db.sqlite');
    const permissionsGracePeriodSeconds =
      this.config.capture.permissionsGracePeriodSeconds;

    // --- Step 1: check if db.sqlite exists ---
    if (!existsSync(dbPath)) {
      return {
        state: 'unknown',
        livenessThresholdSeconds,
        reason: 'frames database not found'
      };
    }

    // --- Step 2: read frames.timestamp MAX from SQLite ---
    let lastFrameTimestamp: string | null = null;
    let framesEverWritten = false;
    try {
      const { stdout } = await execFileAsync('sqlite3', [
        dbPath,
        'SELECT MAX(timestamp) FROM frames;'
      ]);
      const raw = stdout.trim();
      if (raw && raw !== 'NULL' && raw !== '') {
        lastFrameTimestamp = raw;
        framesEverWritten = true;
      }
    } catch {
      // sqlite3 binary missing or db unreadable – treat as unknown
      return {
        state: 'unknown',
        livenessThresholdSeconds,
        reason: 'frames database not found'
      };
    }

    // --- Step 3: check runtimeRegistry ---
    const processRunning = await this.runtimeRegistry.hasActiveProcess();
    const processStartedAtRaw = await this.runtimeRegistry.getProcessStartedAt();

    const now = this.now();
    const processStartedAt = processStartedAtRaw
      ? new Date(processStartedAtRaw)
      : null;

    // --- Step 4: delegate to pure decision-table function ---
    return computeCaptureState({
      processRunning,
      lastFrameTimestamp,
      now,
      livenessThresholdSeconds,
      processStartedAt,
      permissionsGracePeriodSeconds,
      framesEverWritten
    });
  }

  /**
   * Aggregates ingestion-mix counts from the vector store over the last 24 h.
   *
   * Requirements 6.2, 6.7:
   * - `accessibilityCount` = number of records whose `metadata.sourceTypes`
   *   contains `"accessibility"`.
   * - `ocrCount` = number of records whose `metadata.sourceTypes` contains
   *   `"ocr"` but NOT `"accessibility"` (prevents double-counting merged
   *   records).
   * - `ratio = accessibilityCount / (accessibilityCount + ocrCount)`.
   *   When both counts are zero, returns `0.0` without throwing.
   * - If the vector store is not readable (throws), degrades gracefully:
   *   all counts return 0, `ratio = 0.0`, and the error is logged to stderr.
   */
  private async collectIngestionMix(): Promise<IngestionMix> {
    const WINDOW_SECONDS = 86_400;

    const now = this.now();
    const windowStart = new Date(now.getTime() - WINDOW_SECONDS * 1000);
    const fromIso = windowStart.toISOString();
    const toIso = now.toISOString();

    const degraded = (): IngestionMix => ({
      windowSeconds: WINDOW_SECONDS,
      accessibilityCount: 0,
      ocrCount: 0,
      ratio: 0.0
    });

    // listByTimeWindow is an optional extension on VectorStore.
    // If the implementation does not support it, degrade gracefully.
    if (typeof this.vectorStore.listByTimeWindow !== 'function') {
      stderr.write(
        `[WARN] IngestionObservabilityService: vector store does not support listByTimeWindow; ingestionMix degraded to zeros\n`
      );
      return degraded();
    }

    let records;
    try {
      records = await this.vectorStore.listByTimeWindow(fromIso, toIso);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(
        `[WARN] IngestionObservabilityService: vector store listByTimeWindow failed; ingestionMix degraded to zeros. Error: ${message}\n`
      );
      return degraded();
    }

    let accessibilityCount = 0;
    let ocrCount = 0;

    for (const record of records) {
      // sourceTypes is stored in metadata (task 5.1) and also on the record itself.
      // Prefer metadata.sourceTypes as the canonical source for observability.
      const sourceTypes =
        (record.metadata?.sourceTypes as string[] | undefined) ??
        record.sourceTypes ??
        [];

      const hasAccessibility = sourceTypes.includes('accessibility');
      const hasOcr = sourceTypes.includes('ocr');

      if (hasAccessibility) {
        accessibilityCount += 1;
      } else if (hasOcr) {
        // Only count as OCR if NOT also accessibility (prevents double-counting)
        ocrCount += 1;
      }
    }

    const total = accessibilityCount + ocrCount;
    const ratio = total === 0 ? 0.0 : accessibilityCount / total;

    return {
      windowSeconds: WINDOW_SECONDS,
      accessibilityCount,
      ocrCount,
      ratio
    };
  }

  /**
   * Reads the current size of `db.sqlite` via `fs.stat` and computes the
   * disk-budget snapshot.
   *
   * Requirements 6.3, 6.5:
   * - `headroomBytes = max(0, budgetBytes - currentSizeBytes)` when budget is set
   * - `headroomBytes = null` when `budgetBytes === null`
   * - `warning` is set (non-empty) when `currentSizeBytes >= budgetBytes * 0.9`
   */
  private async collectDiskBudget(): Promise<DiskBudget> {
    const budgetBytes = this.config.storage.diskBudgetBytes;
    const dbPath = path.join(this.screenpipeDirectory, 'db.sqlite');

    let currentSizeBytes = 0;
    try {
      const stats = await stat(dbPath);
      currentSizeBytes = stats.size;
    } catch {
      // db.sqlite doesn't exist yet – treat as 0 bytes
      currentSizeBytes = 0;
    }

    if (budgetBytes === null) {
      return {
        budgetBytes: null,
        currentSizeBytes,
        headroomBytes: null
      };
    }

    const headroomBytes = Math.max(0, budgetBytes - currentSizeBytes);

    let warning: string | undefined;
    if (currentSizeBytes >= budgetBytes * 0.9) {
      warning = 'Will run retention pass on next trim cycle';
    }

    return {
      budgetBytes,
      currentSizeBytes,
      headroomBytes,
      ...(warning !== undefined ? { warning } : {})
    };
  }
}
