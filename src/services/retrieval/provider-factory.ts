import type { AppConfig } from '../../types/app-config.js';
import type { EmbeddingProvider } from './types.js';

interface OpenAICompatibleEmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
  embedding?: number[];
}

function extractEmbedding(payload: OpenAICompatibleEmbeddingResponse): number[] {
  if (Array.isArray(payload.embedding)) {
    return payload.embedding;
  }

  const embedding = payload.data?.[0]?.embedding;
  if (Array.isArray(embedding)) {
    return embedding;
  }

  throw new Error('Embedding provider response did not contain an embedding vector.');
}

function buildEmbeddingsUrl(baseUrl: string): URL {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('embeddings', normalizedBase);
}

function buildHeaders(apiKey?: string): Record<string, string> {
  return apiKey
    ? {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      }
    : {
        'content-type': 'application/json'
      };
}

class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly kind: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly apiKey?: string;

  constructor(config: AppConfig['providers']['embeddings']) {
    this.kind = config.kind;
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.apiKey = config.apiKey;
  }

  async embed(input: string): Promise<number[]> {
    if (!this.baseUrl) {
      throw new Error(`Embedding provider ${this.kind} is not configured with a baseUrl.`);
    }

    const response = await fetch(buildEmbeddingsUrl(this.baseUrl), {
      method: 'POST',
      headers: buildHeaders(this.apiKey),
      body: JSON.stringify({
        model: this.model,
        input
      })
    });

    if (!response.ok) {
      throw new Error(`Embedding provider ${this.kind} returned ${response.status}.`);
    }

    const payload = await response.json() as OpenAICompatibleEmbeddingResponse;
    return extractEmbedding(payload);
  }
}

class ConcurrencyLimitedEmbeddingProvider implements EmbeddingProvider {
  readonly kind: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly apiKey?: string;

  #activeCount = 0;

  #queue: Array<() => void> = [];

  #limit: number;

  #provider: EmbeddingProvider;

  constructor(provider: EmbeddingProvider, limit: number) {
    this.kind = provider.kind;
    this.baseUrl = provider.baseUrl;
    this.model = provider.model;
    this.#provider = provider;
    this.#limit = limit;
  }

  async embed(input: string): Promise<number[]> {
    await this.#acquire();
    try {
      return await this.#provider.embed(input);
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#activeCount < this.#limit) {
      this.#activeCount += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.#queue.push(() => {
        this.#activeCount += 1;
        resolve();
      });
    });
  }

  #release(): void {
    this.#activeCount -= 1;
    const next = this.#queue.shift();
    next?.();
  }
}

function withEmbeddingConcurrencyLimit(provider: EmbeddingProvider, limit?: number): EmbeddingProvider {
  if (!limit || limit <= 0) {
    return provider;
  }

  return new ConcurrencyLimitedEmbeddingProvider(provider, limit);
}

export function createEmbeddingProvider(config: AppConfig): EmbeddingProvider {
  const embeddingConfig = config.providers.embeddings;

  switch (embeddingConfig.kind) {
    case 'openai-compatible':
    case 'openai':
    case 'ollama':
    case 'dashscope':
    case 'azure-openai':
      return withEmbeddingConcurrencyLimit(new OpenAICompatibleEmbeddingProvider(embeddingConfig), embeddingConfig.concurrency);
    default:
      return withEmbeddingConcurrencyLimit(new OpenAICompatibleEmbeddingProvider(embeddingConfig), embeddingConfig.concurrency);
  }
}
