import { createServer } from 'node:http';

export interface EmbeddingStubController {
  setFailureMode(enabled: boolean): void;
  readonly url: string;
  stop(): Promise<void>;
}

export async function startEmbeddingStub(options?: {
  fail?: boolean;
  embedding?: number[];
  delayMs?: number;
  failOnInputs?: string[];
}): Promise<EmbeddingStubController> {
  let fail = options?.fail ?? false;
  const embedding = options?.embedding ?? [0.11, 0.22, 0.33];
  const delayMs = options?.delayMs ?? 0;
  const failOnInputs = new Set(options?.failOnInputs ?? []);

  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/embeddings') {
      response.statusCode = 404;
      response.end('Not Found');
      return;
    }

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks).toString('utf8');
    const parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) as { input?: string | string[] } : {};
    const inputs = Array.isArray(parsedBody.input)
      ? parsedBody.input
      : typeof parsedBody.input === 'string'
        ? [parsedBody.input]
        : [];

    if (fail || inputs.some((input) => Array.from(failOnInputs).some((f) => input.includes(f)))) {
      response.statusCode = 503;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'embedding unavailable' }));
      return;
    }

    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      object: 'list',
      data: [
        {
          object: 'embedding',
          index: 0,
          embedding
        }
      ],
      model: 'acceptance-embedding-model'
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start embedding stub server.');
  }

  return {
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
