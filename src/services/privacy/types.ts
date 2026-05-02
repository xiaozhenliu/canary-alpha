import type { ScreenpipeStorageDiagnostics } from '../../types/app-config.js';

export type PrivacyDeleteRange = 'last_1h' | 'last_1d' | 'all';
export type PrivacyAction = 'status' | 'pause' | 'resume' | 'exclude-app' | 'delete-range';

export interface PrivacySuppressedRange {
  from: string;
  to: string;
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
