import type { ScreenpipeClient, ScreenpipeRecord, ScreenpipeSearchRequest } from './types.js';

/**
 * Symbol used to attach a degraded reason to a ScreenpipeRecord[] array when
 * one of the dual-query paths (AX or OCR) fails but the other succeeds.
 * Upper-layer services (formerly `search-screen-service`; now reserved for
 * the work-activity-analysis tools introduced in tasks 8.2 - 8.5) can read
 * this symbol to surface the degradation to callers.
 */
export const DEGRADED_REASON_SYMBOL: unique symbol = Symbol('screenpipeDegradedReason');

/**
 * A ScreenpipeRecord[] that may carry an optional degraded reason attached via
 * DEGRADED_REASON_SYMBOL.  The symbol property is invisible to normal iteration
 * and JSON serialisation, so it does not affect downstream consumers that do
 * not know about it.
 */
export type ScreenpipeRecordPage = ScreenpipeRecord[] & {
  [DEGRADED_REASON_SYMBOL]?: string;
};

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
  };
  appName?: string;
  app_name?: string;
  window_name?: string;
  frame_id?: number;
  id?: string;
  text?: string;
  timestamp?: string;
}

const DEFAULT_PAGE_SIZE = 500;

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
  if (typeof item.id === 'string' && typeof item.text === 'string' && typeof item.timestamp === 'string') {
    return {
      id: item.id,
      text: item.text,
      timestamp: item.timestamp,
      appName: item.appName ?? item.app_name,
      windowName: typeof item.window_name === 'string' ? item.window_name : undefined,
      frameId: typeof item.frame_id === 'number' ? item.frame_id : undefined,
      sourceTypes: [contentType]
    };
  }

  if (!item.content || (contentType === 'ocr' && item.type !== 'OCR')) {
    return null;
  }

  const text = item.content.text ?? item.content.ocr_text;
  const timestamp = item.content.timestamp;
  if (!text || !timestamp) {
    return null;
  }

  const rawFrameId = item.content.frame_id;
  const frameId = typeof rawFrameId === 'number' ? rawFrameId : 'unknown';
  const offsetIndex = item.content.offset_index ?? 0;

  return {
    id: `frame:${frameId}:${offsetIndex}`,
    text,
    timestamp,
    appName: item.content.app_name,
    windowName: typeof item.content.window_name === 'string' ? item.content.window_name : undefined,
    frameId: typeof rawFrameId === 'number' ? rawFrameId : undefined,
    sourceTypes: [contentType]
  };
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
      // Both paths failed — surface as SCREENPIPE_UNAVAILABLE so upper-layer
      // services can set error.code = 'SCREENPIPE_UNAVAILABLE'.
      const combined = new Error('Screenpipe search failed on both AX and OCR paths.');
      (combined as NodeJS.ErrnoException & { screenpipeCode?: string }).screenpipeCode = 'SCREENPIPE_UNAVAILABLE';
      throw combined;
    }

    const merged: ScreenpipeRecordPage = mergeByFrameId(axRecords, ocrRecords);

    if (axError !== null) {
      // AX path failed, fell back to OCR only
      merged[DEGRADED_REASON_SYMBOL] = 'AX path unavailable, falling back to OCR';
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
        degradedReason = page[DEGRADED_REASON_SYMBOL];
      }

      records.push(...page);
      if (page.length < DEFAULT_PAGE_SIZE) {
        break;
      }

      offset += page.length;
    }

    const result: ScreenpipeRecordPage = records;
    if (degradedReason !== undefined) {
      result[DEGRADED_REASON_SYMBOL] = degradedReason;
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
      const combined = new Error('Screenpipe search failed on both AX and OCR paths.');
      (combined as NodeJS.ErrnoException & { screenpipeCode?: string }).screenpipeCode = 'SCREENPIPE_UNAVAILABLE';
      throw combined;
    }

    const merged: ScreenpipeRecordPage = mergeByFrameId(axRecords, ocrRecords);

    if (axError !== null) {
      merged[DEGRADED_REASON_SYMBOL] = 'AX path unavailable, falling back to OCR';
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
