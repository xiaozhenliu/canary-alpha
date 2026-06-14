import { describe, expect, it } from 'vitest';
import * as z from 'zod';

const inputSchema = z.object({
  scope: z.enum(['memory', 'user']).default('memory'),
  content: z.string().min(1).max(65536),
  mode: z.enum(['append', 'replace']).default('append')
});

describe('memory-write input schema', () => {
  it('accepts content within limit', () => {
    const result = inputSchema.safeParse({ content: 'hello' });
    expect(result.success).toBe(true);
  });

  it('rejects empty content', () => {
    const result = inputSchema.safeParse({ content: '' });
    expect(result.success).toBe(false);
  });

  it('rejects content exceeding 64KB', () => {
    const result = inputSchema.safeParse({ content: 'x'.repeat(65537) });
    expect(result.success).toBe(false);
  });

  it('accepts content at exactly 64KB', () => {
    const result = inputSchema.safeParse({ content: 'x'.repeat(65536) });
    expect(result.success).toBe(true);
  });
});
