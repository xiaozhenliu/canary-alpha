import { createServer } from 'node:http';

import type { ScreenpipeRecord } from '../../src/services/retrieval/types.js';

export interface ScreenpipeStubController {
  addRecord(record: ScreenpipeRecord): void;
  setFailureMode(enabled: boolean): void;
  readonly url: string;
  stop(): Promise<void>;
}

function toSearchResponse(records: ScreenpipeRecord[]) {
  return {
    data: records.map((record, index) => ({
      type: 'OCR',
      content: {
        app_name: record.appName ?? '',
        frame_id: index + 1,
        offset_index: 0,
        text: record.text,
        timestamp: record.timestamp
      }
    })),
    pagination: {
      limit: records.length,
      offset: 0,
      total: records.length
    }
  };
}

function filterRecords(records: ScreenpipeRecord[], requestUrl: URL): ScreenpipeRecord[] {
  const query = requestUrl.searchParams.get('q');
  const appName = requestUrl.searchParams.get('app_name');
  const from = requestUrl.searchParams.get('start_time');
  const to = requestUrl.searchParams.get('end_time');
  const limit = Number(requestUrl.searchParams.get('limit') ?? '0');
  const offset = Number(requestUrl.searchParams.get('offset') ?? '0');

  const filtered = records.filter((record) => {
    const matchesQuery = query
      ? record.text.toLowerCase().includes(query.toLowerCase())
      : true;
    const matchesApp = appName ? record.appName === appName : true;
    const matchesFrom = from ? record.timestamp >= from : true;
    const matchesTo = to ? record.timestamp <= to : true;
    return matchesQuery && matchesApp && matchesFrom && matchesTo;
  });

  const safeOffset = Number.isNaN(offset) ? 0 : offset;
  if (!Number.isNaN(limit) && limit > 0) {
    return filtered.slice(safeOffset, safeOffset + limit);
  }

  return filtered.slice(safeOffset);
}

export async function startScreenpipeStub(options?: {
  records?: ScreenpipeRecord[];
  fail?: boolean;
}): Promise<ScreenpipeStubController> {
  const records = [...(options?.records ?? [])];
  let fail = options?.fail ?? false;

  const server = createServer((request, response) => {
    if (!request.url) {
      response.statusCode = 404;
      response.end('Not Found');
      return;
    }

    if (fail) {
      response.statusCode = 503;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'screenpipe unavailable' }));
      return;
    }

    const requestUrl = new URL(request.url, 'http://127.0.0.1');

    if (request.method === 'GET' && requestUrl.pathname === '/search') {
      const limited = filterRecords(records, requestUrl);
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(toSearchResponse(limited)));
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    response.statusCode = 404;
    response.end('Not Found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start Screenpipe stub server.');
  }

  return {
    addRecord(record: ScreenpipeRecord): void {
      records.push(record);
    },
    setFailureMode(enabled: boolean): void {
      fail = enabled;
    },
    url: `http://127.0.0.1:${address.port}`,
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
