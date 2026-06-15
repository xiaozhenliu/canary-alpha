import type { ScreenpipeStorageDiagnostics } from '../../types/app-config.js';

export type PrivacyDeleteRange = 'last_1h' | 'last_1d' | 'all';
export type PrivacyAction = 'status' | 'pause' | 'resume' | 'exclude-app' | 'remove-excluded-app' | 'delete-range';

export interface PrivacySuppressedRange {
  from: string;
  to: string;
  /**
   * Optional reason tag for tombstone tracking. Default
   * (`undefined`) keeps backwards compatibility with the
   * pause/resume + last-1h delete-range bookkeeping. When the
   * Cascade_Delete coordinator partially or fully fails, the
   * privacy-control service writes a row with reason
   * `'cascade-failure'` so retrieval tools (`find` / `recall`)
   * filter the affected window until the reconciliation entry
   * point retries the cascade.
   */
  reason?: 'pause' | 'delete-range' | 'cascade-failure';
  /** Optional cascade-failure detail; ignored for non-failure rows. */
  failedFrameIds?: number[];
  /** ISO timestamp marking when the row was created. */
  createdAt?: string;
  /** ISO timestamp set when reconciliation cleared the row. */
  resolvedAt?: string;
}

export interface PrivacyState {
  paused: boolean;
  excludedApps: string[];
  pauseStartedAt?: string;
  suppressedRanges?: PrivacySuppressedRange[];
}

export const DEFAULT_PRIVACY_STATE: PrivacyState = {
  paused: false,
  excludedApps: []
};

export interface PrivacyControlRequest {
  action: PrivacyAction;
  appName?: string;
  range?: PrivacyDeleteRange;
  confirm?: boolean;
}

export interface PrivacyControlError {
  code:
    | 'PRIVACY_APP_NAME_REQUIRED'
    | 'PRIVACY_APP_NOT_EXCLUDED'
    | 'PRIVACY_RANGE_REQUIRED'
    | 'PRIVACY_CONFIRM_REQUIRED'
    | 'PRIVACY_UNSUPPORTED_RANGE'
    | 'PRIVACY_DELETE_UNAVAILABLE';
  message: string;
}

export interface PrivacyControlResult {
  action: PrivacyAction;
  paused: boolean;
  excludedApps: string[];
  allowedDeleteRanges: PrivacyDeleteRange[];
  confirmationHint: string;
  screenpipeStorage?: ScreenpipeStorageDiagnostics;
  requestedRange?: PrivacyDeleteRange;
  confirmed?: boolean;
  deletedFrames?: number;
  deletedElements?: number;
  /** Number of derived `extracted_content` rows removed by Cascade_Delete (R9.1). */
  deletedExtractedContent?: number;
  /** Number of derived `sessions` rows removed by Cascade_Delete (R9.1). */
  deletedSessions?: number;
  /** Number of vector-store embedding records removed by Cascade_Delete (R9.1). */
  deletedEmbeddings?: number;
  /**
   * Cascade outcome envelope (R9.1). Surfaces whether the upstream
   * ScreenPipe deletion completed, and whether the derived-data
   * cascade ran to completion. Only populated when a cascade
   * coordinator was wired in. The split between `upstreamDeleted`
   * and `cascade` lets callers (and tests) distinguish "frames
   * gone, derived rows lingering" from "everything gone" without
   * having to compare three numeric counters.
   */
  cascade?: {
    upstreamDeleted: boolean;
    cascade: 'ok' | 'partial' | 'failed';
    /** When non-empty, the frame ids whose derived rows could not be cleaned. */
    failedFrameIds?: number[];
    /** Human-readable reason; surfaced verbatim to operators / logs. */
    reason?: string;
  };
  error?: PrivacyControlError;
}

export interface PrivacyStateReader {
  read(): Promise<PrivacyState>;
}

export interface PrivacyStore extends PrivacyStateReader {
  write(state: PrivacyState): Promise<void>;
}

export interface PrivacyControlService {
  execute(request: PrivacyControlRequest): Promise<PrivacyControlResult>;
}
