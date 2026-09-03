import type { ScreenpipeClient, ScreenpipeRecord, ScreenpipeSearchRequest } from '../../../retrieval/types.js';

import {
  CAPTURE_DEGRADED_REASON,
  type CaptureRecordPage
} from '../../types.js';

/** @deprecated Use CAPTURE_DEGRADED_REASON from services/capture/types.js. */
export const DEGRADED_REASON_SYMBOL = CAPTURE_DEGRADED_REASON;

/** @deprecated Use CaptureRecordPage from services/capture/types.js. */
export type ScreenpipeRecordPage = CaptureRecordPage;

interface ScreenpipeClientOptions {
  baseUrl?: string;
  apiKey?: string;
}

interface ScreenpipeSearchResponseItem {
  type?: string;
  content?: {
    app_name?: string;
    window_name?: string;
    frame_id?: number;
    offset_index?: number;
    ocr_text?: string;
    text?: string;
    timestamp?: string;
    accessibility_tree_json?: unknown;
    accessibilityTreeJson?: unknown;
    accessibility_tree?: unknown;
    accessibilityTree?: unknown;
  };
  appName?: string;
  app_name?: string;
  window_name?: string;
  frame_id?: number;
  id?: string;
  text?: string;
  timestamp?: string;
  accessibility_tree_json?: unknown;
  accessibilityTreeJson?: unknown;
  accessibility_tree?: unknown;
  accessibilityTree?: unknown;
}

const DEFAULT_PAGE_SIZE = 500;

const EXTRACTABLE_AX_ROLES = new Set([
  'AXWindow',
  'AXMainWindow',
  'AXDocument',
  'AXApplication',
  'AXStandardWindow',
  'AXToolbar',
  'AXTabGroup',
  'AXTab',
  'AXRadioButton',
  'AXHeading',
  'AXBanner',
  'AXNavigationBar',
  'AXTitleBar',
  'AXMenu',
  'AXMenuItem',
  'AXMenuBar',
  'AXMenuBarItem',
  'AXPopUpButton',
  'AXSheet',
  'AXDialog',
  'AXAlert',
  'AXTextArea',
  'AXWebArea',
  'AXScrollArea',
  'AXTextField',
  'AXTable',
  'AXList',
  'AXOutline',
  'AXStaticText',
  'AXGroup',
  'AXSplitGroup'
]);

function buildScreenpipeUrl(baseUrl: string, path: string): URL {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBase);
}

function buildScreenpipeHeaders(apiKey?: string): HeadersInit | undefined {
  if (!apiKey) {
    return undefined;
  }

  return {
    authorization: `Bearer ${apiKey}`
  };
}

type ScreenpipeContentType = 'accessibility' | 'ocr';

function buildSearchUrl(
  baseUrl: string,
  request: ScreenpipeSearchRequest,
  contentType: ScreenpipeContentType
): URL {
  const url = buildScreenpipeUrl(baseUrl, 'search');
  url.searchParams.set('content_type', contentType);
  url.searchParams.set('limit', String(request.limit ?? DEFAULT_PAGE_SIZE));
  url.searchParams.set('offset', String(request.offset ?? 0));

  if (request.query) {
    url.searchParams.set('q', request.query);
  }

  if (request.appName) {
    url.searchParams.set('app_name', request.appName);
  }

  if (request.from) {
    url.searchParams.set('start_time', request.from);
  }

  if (request.to) {
    url.searchParams.set('end_time', request.to);
  }

  return url;
}

function normalizeScreenpipeRecord(
  item: ScreenpipeSearchResponseItem,
  contentType: ScreenpipeContentType
): ScreenpipeRecord | null {
  const topLevelAccessibilityTreeJson = normalizeAccessibilityTreeJson(item);
  const topLevelText = typeof item.text === 'string' ? item.text : undefined;
  if (
    typeof item.id === 'string' &&
    typeof item.timestamp === 'string' &&
    (topLevelText !== undefined && topLevelText.trim() !== '' ||
      (contentType === 'accessibility' && isUsableAccessibilityTreeJson(topLevelAccessibilityTreeJson)))
  ) {
    return {
      id: item.id,
      text: topLevelText ?? '',
      timestamp: item.timestamp,
      appName: item.appName ?? item.app_name,
      windowName: typeof item.window_name === 'string' ? item.window_name : undefined,
      frameId: typeof item.frame_id === 'number' ? item.frame_id : undefined,
      sourceTypes: [contentType],
      ...(topLevelAccessibilityTreeJson !== undefined
        ? { accessibilityTreeJson: topLevelAccessibilityTreeJson }
        : {})
    };
  }

  if (!item.content || (contentType === 'ocr' && item.type !== 'OCR')) {
    return null;
  }

  const accessibilityTreeJson = normalizeAccessibilityTreeJson(item.content);
  const text = item.content.text ?? item.content.ocr_text;
  const timestamp = item.content.timestamp;
  const normalizedText = typeof text === 'string' ? text : undefined;
  const hasUsableTree =
    contentType === 'accessibility' && isUsableAccessibilityTreeJson(accessibilityTreeJson);
  if (
    (normalizedText === undefined || normalizedText.trim() === '') && !hasUsableTree ||
    typeof timestamp !== 'string' ||
    timestamp === ''
  ) {
    return null;
  }

  const rawFrameId = item.content.frame_id;
  const frameId = typeof rawFrameId === 'number' ? rawFrameId : 'unknown';
  const offsetIndex = item.content.offset_index ?? 0;

  return {
    id: `frame:${frameId}:${offsetIndex}`,
    text: normalizedText ?? '',
    timestamp,
    appName: item.content.app_name,
    windowName: typeof item.content.window_name === 'string' ? item.content.window_name : undefined,
    frameId: typeof rawFrameId === 'number' ? rawFrameId : undefined,
    sourceTypes: [contentType],
    ...(accessibilityTreeJson !== undefined ? { accessibilityTreeJson } : {})
  };
}

function normalizeAccessibilityTreeJson(
  value: Pick<ScreenpipeSearchResponseItem, 'accessibility_tree_json' | 'accessibilityTreeJson' | 'accessibility_tree' | 'accessibilityTree'>
): string | null | undefined {
  const raw = [
    value.accessibility_tree_json,
    value.accessibilityTreeJson,
    value.accessibility_tree,
    value.accessibilityTree
  ].find((candidate) => candidate !== undefined);

  if (raw === undefined || raw === null) return raw;
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return undefined;
  }
}

function isUsableAccessibilityTreeJson(value: string | null | undefined): value is string {
  if (value === undefined || value === null || value.trim() === '') return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return hasExtractableAccessibilityNode(parsed);
  } catch {
    return false;
  }
}

function hasExtractableAccessibilityNode(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasExtractableAccessibilityNode(item));
  }
  if (value === null || typeof value !== 'object') return false;

  const node = value as Record<string, unknown>;
  if (!isVisibleAccessibilityNode(node)) return false;

  const role = typeof node.role === 'string' ? node.role : undefined;
  const hasText = ['value', 'text', 'title', 'description'].some(
    (key) => typeof node[key] === 'string' && (node[key] as string).trim() !== ''
  );
  if (hasText && (role === undefined || EXTRACTABLE_AX_ROLES.has(role))) {
    return true;
  }

  return Array.isArray(node.children) && node.children.some((child) =>
    hasExtractableAccessibilityNode(child)
  );
}

function isVisibleAccessibilityNode(node: Record<string, unknown>): boolean {
  if (node.onScreen === false || node.on_screen === false) return false;
  const bounds = node.bounds;
  if (bounds === null || typeof bounds !== 'object' || Array.isArray(bounds)) return true;

  const typedBounds = bounds as Record<string, unknown>;
  return !(
    (typeof typedBounds.width === 'number' && typedBounds.width <= 0) ||
    (typeof typedBounds.height === 'number' && typedBounds.height <= 0)
  );
}

function normalizeSearchResponse(payload: unknown, contentType: ScreenpipeContentType): ScreenpipeRecord[] {
  if (Array.isArray(payload)) {
    return payload
      .map((item) => normalizeScreenpipeRecord(item as ScreenpipeSearchResponseItem, contentType))
      .filter((item): item is ScreenpipeRecord => item !== null);
  }

  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown[] }).data)) {
    return [];
  }

  return (payload as { data: unknown[] }).data
    .map((item) => normalizeScreenpipeRecord(item as ScreenpipeSearchResponseItem, contentType))
    .filter((item): item is ScreenpipeRecord => item !== null);
}

/**
 * Merge AX and OCR records by frameId (R1.4, R1.6):
 * - For each frameId: AX wins over OCR.
 * - Records without frameId are merged by id uniqueness (no cross-source dedup).
 * - Result is sorted by (timestamp, id) for determinism.
 */
export function mergeByFrameId(ax: ScreenpipeRecord[], ocr: ScreenpipeRecord[]): ScreenpipeRecord[] {
  const merged = new Map<string, ScreenpipeRecord>();

  // Index AX records by frameId (preferred) or id
  for (const record of ax) {
    const key = record.frameId !== undefined ? `frame:${record.frameId}` : `id:${record.id}`;
    merged.set(key, record);
  }

  // Add OCR records only when no AX record exists for the same frameId
  for (const record of ocr) {
    if (record.frameId !== undefined) {
      const key = `frame:${record.frameId}`;
      if (!merged.has(key)) {
        merged.set(key, record);
      }
    } else {
      // No frameId: merge by id uniqueness, no cross-source dedup
      const key = `id:${record.id}`;
      if (!merged.has(key)) {
        merged.set(key, record);
      }
    }
  }

  return [...merged.values()].sort((a, b) => {
    const tCmp = a.timestamp.localeCompare(b.timestamp);
    return tCmp !== 0 ? tCmp : a.id.localeCompare(b.id);
  });
}

export class HttpScreenpipeClient implements ScreenpipeClient {
  constructor(private readonly options: ScreenpipeClientOptions) {}

  private async fetchPage(
    request: ScreenpipeSearchRequest,
    contentType: ScreenpipeContentType
  ): Promise<ScreenpipeRecord[]> {
    if (!this.options.baseUrl) {
      throw new Error('Screenpipe client is not configured yet.');
    }

    const response = await fetch(buildSearchUrl(this.options.baseUrl, request, contentType), {
      headers: buildScreenpipeHeaders(this.options.apiKey)
    });

    if (!response.ok) {
      throw new Error(`Screenpipe search returned ${response.status}.`);
    }

    return normalizeSearchResponse(await response.json(), contentType);
  }

  async search(request: ScreenpipeSearchRequest): Promise<ScreenpipeRecordPage> {
    // Dual-query: AX primary + OCR fallback (R1.1, R1.4, R1.6)
    let axRecords: ScreenpipeRecord[] = [];
    let ocrRecords: ScreenpipeRecord[] = [];
    let axError: Error | null = null;
    let ocrError: Error | null = null;

    try {
      axRecords = await this.fetchPage(request, 'accessibility');
    } catch (err) {
      axError = err instanceof Error ? err : new Error(String(err));
    }

    try {
      ocrRecords = await this.fetchPage(request, 'ocr');
    } catch (err) {
      ocrError = err instanceof Error ? err : new Error(String(err));
    }

    if (axError !== null && ocrError !== null) {
      // Both paths failed — attach the neutral captureCode (primary) and the
      // legacy screenpipeCode (compatibility window) so upper-layer consumers
      // that check either property keep working during the migration.
      const combined = new Error('Capture source search failed on both AX and OCR paths (provider: screenpipe).');
      (combined as Error & { captureCode?: string; screenpipeCode?: string }).captureCode = 'CAPTURE_SOURCE_UNAVAILABLE';
      // Legacy property kept for the compatibility window.
      (combined as Error & { screenpipeCode?: string }).screenpipeCode = 'SCREENPIPE_UNAVAILABLE';
      throw combined;
    }

    const merged: ScreenpipeRecordPage = mergeByFrameId(axRecords, ocrRecords);

    if (axError !== null) {
      // AX path failed, fell back to OCR only
      merged[CAPTURE_DEGRADED_REASON] = 'capture provider screenpipe: AX path unavailable, falling back to OCR';
    } else if (ocrError !== null) {
      // OCR path failed, AX-only result (still valid, no degradation message needed
      // per spec — OCR is the fallback, not the primary)
    }

    return merged;
  }

  async recent(minutes: number): Promise<ScreenpipeRecordPage> {
    if (!this.options.baseUrl) {
      throw new Error('Screenpipe client is not configured yet.');
    }

    const to = new Date();
    const from = new Date(to.getTime() - minutes * 60_000);
    const records: ScreenpipeRecord[] = [];
    let offset = 0;
    let degradedReason: string | undefined;

    while (true) {
      const page = await this.dualFetchPage({
        from: from.toISOString(),
        to: to.toISOString(),
        limit: DEFAULT_PAGE_SIZE,
        offset
      });

      // Capture degraded reason from the first page that has one
      if (degradedReason === undefined) {
        degradedReason = page[CAPTURE_DEGRADED_REASON];
      }

      records.push(...page);
      if (page.length < DEFAULT_PAGE_SIZE) {
        break;
      }

      offset += page.length;
    }

    const result: ScreenpipeRecordPage = records;
    if (degradedReason !== undefined) {
      result[CAPTURE_DEGRADED_REASON] = degradedReason;
    }

    return result;
  }

  private async dualFetchPage(request: ScreenpipeSearchRequest): Promise<ScreenpipeRecordPage> {
    let axRecords: ScreenpipeRecord[] = [];
    let ocrRecords: ScreenpipeRecord[] = [];
    let axError: Error | null = null;
    let ocrError: Error | null = null;

    try {
      axRecords = await this.fetchPage(request, 'accessibility');
    } catch (err) {
      axError = err instanceof Error ? err : new Error(String(err));
    }

    try {
      ocrRecords = await this.fetchPage(request, 'ocr');
    } catch (err) {
      ocrError = err instanceof Error ? err : new Error(String(err));
    }

    if (axError !== null && ocrError !== null) {
      // Both paths failed — attach the neutral captureCode (primary) and the
      // legacy screenpipeCode (compatibility window) so upper-layer consumers
      // that check either property keep working during the migration.
      const combined = new Error('Capture source search failed on both AX and OCR paths (provider: screenpipe).');
      (combined as Error & { captureCode?: string; screenpipeCode?: string }).captureCode = 'CAPTURE_SOURCE_UNAVAILABLE';
      // Legacy property kept for the compatibility window.
      (combined as Error & { screenpipeCode?: string }).screenpipeCode = 'SCREENPIPE_UNAVAILABLE';
      throw combined;
    }

    const merged: ScreenpipeRecordPage = mergeByFrameId(axRecords, ocrRecords);

    if (axError !== null) {
      merged[CAPTURE_DEGRADED_REASON] = 'capture provider screenpipe: AX path unavailable, falling back to OCR';
    }

    return merged;
  }
}

export function createScreenpipeClient(
  baseUrl = process.env.SCREENPIPE_BASE_URL,
  apiKey = process.env.SCREENPIPE_API_KEY
): ScreenpipeClient {
  return new HttpScreenpipeClient({ baseUrl, apiKey });
}
