/**
 * Provider-neutral capture domain model.
 *
 * Everything an upstream "screen capture" tool exposes to this MCP server
 * goes through the ports defined here. Provider-specific code (HTTP shapes,
 * SQLite schemas, process control) lives exclusively under
 * `src/services/capture/providers/<name>/` — see the boundary contract test
 * `tests/contract/capture-boundary.test.ts`.
 */

export interface CaptureSearchRequest {
  query?: string;
  appName?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface CaptureRecord {
  id: string;
  text: string;
  timestamp: string;
  appName?: string;
  windowName?: string;
  /** Provider-native frame identifier (Screenpipe: `frames.id`). */
  frameId?: number;
  /** Capture-source labels, e.g. ['accessibility'] | ['ocr']. */
  sourceTypes: string[];
  /** AX element role (e.g. 'AXSecureTextField'); used for secure-field pruning. */
  role?: string;
  /** Parent element id within the same frame's AX tree. */
  parentId?: string;
  /** Dot-separated ancestor path (e.g. '0.1.2'). */
  path?: string;
  /**
   * Full accessibility tree JSON. `null` = explicitly absent (fixtures /
   * retention-nulled); `undefined` = provider did not populate it and the
   * indexing service synthesises a minimal tree from `text`.
   */
  accessibilityTreeJson?: string | null;
}

/**
 * Symbol used to attach a degraded reason to a CaptureRecord[] page when one
 * of a provider's internal paths fails but another succeeds. Invisible to
 * iteration and JSON serialisation.
 */
export const CAPTURE_DEGRADED_REASON: unique symbol = Symbol('captureDegradedReason');

export type CaptureRecordPage = CaptureRecord[] & {
  [CAPTURE_DEGRADED_REASON]?: string;
};

/** Query port — the only mandatory port every provider must implement. */
export interface CaptureClient {
  search(request: CaptureSearchRequest): Promise<CaptureRecordPage>;
  recent(minutes: number): Promise<CaptureRecordPage>;
}

/**
 * The five-column frame projection `inspect({frameId})` exposes.
 * Field semantics are identical to the former `ScreenpipeFrameRow`.
 */
export interface CaptureFrameRow {
  id: number;
  timestamp: string;
  appName?: string;
  windowName?: string;
  accessibilityTreeJson: string | null;
}

/**
 * Read-only frame-detail port. MUST NOT throw — implementations collapse
 * "db missing / table missing / row missing" to `null` and log internally.
 */
export interface CaptureFrameDetailPort {
  getFrame(frameId: number | string): Promise<CaptureFrameRow | null>;
}

export interface CaptureLifecycleResult {
  action: 'status' | 'start' | 'stop';
  running: boolean;
  pid?: number;
  error?: string;
}

/** Process-lifecycle port (start/stop/health of the upstream recorder). */
export interface CaptureLifecyclePort {
  execute(request: { action: 'status' | 'start' | 'stop' }): Promise<CaptureLifecycleResult>;
}

/**
 * Capability descriptor. Upper layers MUST branch on these flags instead of
 * on a provider name — `if (provider === 'screenpipe')` is a boundary
 * violation. A provider that lacks a capability returns the documented
 * degraded value for that path (see design notes in this plan, Stage 4).
 */
export interface CaptureCapabilities {
  /** Stable provider key, e.g. 'screenpipe'. Used for captureId prefixes. */
  providerName: string;
  /** Provider emits OCR text records (sourceTypes includes 'ocr'). */
  ocrText: boolean;
  /** Provider emits AX-tree records (sourceTypes includes 'accessibility'). */
  accessibilityTree: boolean;
  /** Provider supports per-frame detail lookup (inspect raw AX tree). */
  frameDetail: boolean;
  /** Provider supports retention / trim / delete-range on its own store. */
  retentionTrim: boolean;
  /** Provider supports process lifecycle control (start/stop). */
  processLifecycle: boolean;
}

/**
 * Build the provider-neutral persisted identifier for a capture record.
 * Format: `<provider>:frame:<frameId>` when the provider supplies a native
 * frame id, otherwise `<provider>:rec:<recordId>`.
 *
 * This string is the ONLY capture identifier that may be written to
 * persisted stores (vector-store metadata, derived DB columns added after
 * this migration). The bare numeric frameId remains as a legacy field for
 * dual-write compatibility — see Task 7.
 */
export function buildCaptureId(
  providerName: string,
  record: { frameId?: number; id: string }
): string {
  return record.frameId !== undefined
    ? `${providerName}:frame:${record.frameId}`
    : `${providerName}:rec:${record.id}`;
}

/**
 * Parse a captureId back into its parts. Returns null for legacy values
 * that do not follow the `<provider>:<kind>:<value>` format (e.g. bare
 * numeric frameIds written before this migration).
 */
export function parseCaptureId(
  captureId: string
): { providerName: string; kind: 'frame' | 'rec'; value: string } | null {
  const match = /^([^:]+):(frame|rec):(.+)$/.exec(captureId);
  if (!match) {
    return null;
  }
  return { providerName: match[1], kind: match[2] as 'frame' | 'rec', value: match[3] };
}
