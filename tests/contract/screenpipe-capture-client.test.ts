import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { createScreenpipeClient } from '../../src/services/capture/providers/screenpipe/http-client.js';
import { assertCaptureClientContract } from './capture-client.contract.js';

const FIXTURE = {
  data: [
    {
      type: 'OCR',
      content: {
        frame_id: 1,
        offset_index: 0,
        text: 'hello world',
        timestamp: '2026-06-12T00:00:00Z',
        app_name: 'TestApp',
        window_name: 'Main'
      }
    }
  ]
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(FIXTURE));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())));
});

describe('HttpScreenpipeClient satisfies the CaptureClient contract', () => {
  it('passes the provider-agnostic contract', async () => {
    const client = createScreenpipeClient(baseUrl, undefined);
    await assertCaptureClientContract(client);
  });
});
