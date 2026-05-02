import type { ScreenpipeClient, ScreenpipeRecord, ScreenpipeSearchRequest } from './types.js';

interface ScreenpipeClientOptions {
  baseUrl?: string;
  apiKey?: string;
}

interface ScreenpipeSearchResponseItem {
  type?: string;
  content?: {
    app_name?: string;
    frame_id?: number;
    offset_index?: number;
    ocr_text?: string;
    text?: string;
    timestamp?: string;
  };
  appName?: string;
  app_name?: string;
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

function buildSearchUrl(baseUrl: string, request: ScreenpipeSearchRequest): URL {
  const url = buildScreenpipeUrl(baseUrl, 'search');
  url.searchParams.set('content_type', 'ocr');
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

function normalizeScreenpipeRecord(item: ScreenpipeSearchResponseItem): ScreenpipeRecord | null {
  if (typeof item.id === 'string' && typeof item.text === 'string' && typeof item.timestamp === 'string') {
    return {
      id: item.id,
      text: item.text,
      timestamp: item.timestamp,
      appName: item.appName ?? item.app_name
    };
  }

  if (!item.content || item.type !== 'OCR') {
    return null;
  }

  const text = item.content.text ?? item.content.ocr_text;
  const timestamp = item.content.timestamp;
  if (!text || !timestamp) {
    return null;
  }

  const frameId = item.content.frame_id ?? 'unknown';
  const offsetIndex = item.content.offset_index ?? 0;

  return {
    id: `frame:${frameId}:${offsetIndex}`,
    text,
    timestamp,
    appName: item.content.app_name
  };
}

function normalizeSearchResponse(payload: unknown): ScreenpipeRecord[] {
  if (Array.isArray(payload)) {
    return payload
      .map((item) => normalizeScreenpipeRecord(item as ScreenpipeSearchResponseItem))
      .filter((item): item is ScreenpipeRecord => item !== null);
  }

  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown[] }).data)) {
    return [];
  }

  return (payload as { data: unknown[] }).data
    .map((item) => normalizeScreenpipeRecord(item as ScreenpipeSearchResponseItem))
    .filter((item): item is ScreenpipeRecord => item !== null);
}

export class HttpScreenpipeClient implements ScreenpipeClient {
  constructor(private readonly options: ScreenpipeClientOptions) {}

  async search(request: ScreenpipeSearchRequest): Promise<ScreenpipeRecord[]> {
    if (!this.options.baseUrl) {
      throw new Error('Screenpipe client is not configured yet.');
    }

    const response = await fetch(buildSearchUrl(this.options.baseUrl, request), {
      headers: buildScreenpipeHeaders(this.options.apiKey)
    });

    if (!response.ok) {
      throw new Error(`Screenpipe search returned ${response.status}.`);
    }

    return normalizeSearchResponse(await response.json());
  }

  async recent(minutes: number): Promise<ScreenpipeRecord[]> {
    if (!this.options.baseUrl) {
      throw new Error('Screenpipe client is not configured yet.');
    }

    const to = new Date();
    const from = new Date(to.getTime() - minutes * 60_000);
    const records: ScreenpipeRecord[] = [];
    let offset = 0;

    while (true) {
      const page = await this.search({
        from: from.toISOString(),
        to: to.toISOString(),
        limit: DEFAULT_PAGE_SIZE,
        offset
      });

      records.push(...page);
      if (page.length < DEFAULT_PAGE_SIZE) {
        break;
      }

      offset += page.length;
    }

    return records;
  }
}

export function createScreenpipeClient(
  baseUrl = process.env.SCREENPIPE_BASE_URL,
  apiKey = process.env.SCREENPIPE_API_KEY
): ScreenpipeClient {
  return new HttpScreenpipeClient({ baseUrl, apiKey });
}
