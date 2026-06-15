import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../../../src/dashboard/schema-export.js';

describe('zodToJsonSchema (Zod 4)', () => {
  it('converts string type', () => {
    const result = zodToJsonSchema(z.string().default('hello'));
    expect(result.type).toBe('string');
    expect(result.default).toBe('hello');
  });

  it('converts number with int constraint', () => {
    const schema = z.number().int().positive().default(30);
    const result = zodToJsonSchema(schema);
    expect(result.type).toBe('number');
    expect(result.default).toBe(30);
  });

  it('converts boolean with default', () => {
    const schema = z.boolean().default(true);
    const result = zodToJsonSchema(schema);
    expect(result.type).toBe('boolean');
    expect(result.default).toBe(true);
  });

  it('converts enum to string type with enum values', () => {
    const schema = z.enum(['stdio', 'http']).default('http');
    const result = zodToJsonSchema(schema);
    expect(result.type).toBe('string');
    expect(result.enum).toEqual(['stdio', 'http']);
    expect(result.default).toBe('http');
  });

  it('converts array of strings', () => {
    const schema = z.array(z.string()).default(['a', 'b']);
    const result = zodToJsonSchema(schema);
    expect(result.type).toBe('array');
    expect(result.items?.type).toBe('string');
    expect(result.default).toEqual(['a', 'b']);
  });

  it('converts nested objects with required tracking', () => {
    const schema = z.object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().default(8765),
      mode: z.enum(['stdio', 'http']).default('http')
    });
    const result = zodToJsonSchema(schema);
    expect(result.type).toBe('object');
    expect(Object.keys(result.properties!)).toEqual(['host', 'port', 'mode']);
    expect(result.required).toBeUndefined();
  });

  it('marks optional fields as non-required', () => {
    const schema = z.object({
      name: z.string(),
      optional: z.string().optional()
    });
    const result = zodToJsonSchema(schema);
    expect(result.required).toEqual(['name']);
  });

  it('handles nullable fields', () => {
    const schema = z.number().nullable().default(null);
    const result = zodToJsonSchema(schema);
    expect(result.nullable).toBe(true);
  });

  it('marks secret paths', () => {
    const schema = z.object({
      apiKey: z.string().optional()
    });
    const result = zodToJsonSchema(schema, 'providers.embeddings');
    expect(result.properties!.apiKey.isSecret).toBe(true);
  });

  it('handles the full appConfigSchema without throwing', async () => {
    const { appConfigSchema } = await import('../../../src/config/schema.js');
    const result = zodToJsonSchema(appConfigSchema);
    expect(result.type).toBe('object');
    expect(result.properties!.server).toBeDefined();
    expect(result.properties!.capture).toBeDefined();
    expect(result.properties!.privacy).toBeDefined();
  });
});
