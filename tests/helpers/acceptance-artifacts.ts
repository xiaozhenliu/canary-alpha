import { expect } from 'vitest';

interface McpResultLike {
  content?: Array<{ type?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export function expectStructuredArtifact<T>(result: McpResultLike, options?: { isError?: boolean }): T {
  expect(Boolean(result.isError)).toBe(options?.isError ?? false);
  expect(result.content?.[0]).toMatchObject({ type: 'text' });
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as T;
}

export function expectFreshnessStatus(structured: { freshness?: { status?: string } }, status = 'fresh'): void {
  expect(structured.freshness?.status).toBe(status);
}

export function expectEvidenceId(structured: { evidence: Array<{ id: string }> }, id: string): void {
  expect(structured.evidence.some((item) => item.id === id)).toBe(true);
}

export function expectRawId(structured: { raw?: Array<{ id: string }> }, id: string): void {
  expect(structured.raw?.some((item) => item.id === id)).toBe(true);
}
