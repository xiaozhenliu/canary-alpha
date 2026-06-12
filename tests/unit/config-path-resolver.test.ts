import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { resolveSchemaAtPath, coerceValue, isNullable } from '../../src/config/config-path-resolver.js';

describe('resolveSchemaAtPath', () => {
  it('resolves a valid scalar path', () => {
    const r = resolveSchemaAtPath(['providers', 'embeddings', 'model']);
    expect(r.ok).toBe(true);
  });
  it('flags array fields', () => {
    const r = resolveSchemaAtPath(['privacy', 'excludeApps']);
    expect(r).toMatchObject({ ok: true, isArray: true });
  });
  it('returns not-found with availableKeys for unknown key', () => {
    const r = resolveSchemaAtPath(['providers', 'nope']);
    expect(r).toMatchObject({ ok: false, error: 'not-found' });
    if (!r.ok && r.error === 'not-found') {
      expect(r.availableKeys).toContain('embeddings');
    }
  });
  it('returns not-found when path stops on an object', () => {
    const r = resolveSchemaAtPath(['providers']);
    expect(r).toMatchObject({ ok: false, error: 'not-found' });
  });
  it('returns not-found for empty path (stops on root object)', () => {
    const r = resolveSchemaAtPath([]);
    expect(r).toMatchObject({ ok: false, error: 'not-found' });
  });
});

describe('coerceValue', () => {
  it('coerces number', () => {
    expect(coerceValue(z.number(), '14', false)).toEqual({ ok: true, value: 14 });
  });
  it('coerces negative number', () => {
    expect(coerceValue(z.number(), '-0.5', false)).toEqual({ ok: true, value: -0.5 });
  });
  it('rejects non-number', () => {
    expect(coerceValue(z.number(), 'abc', false)).toMatchObject({ ok: false });
  });
  it('coerces boolean case-insensitively', () => {
    expect(coerceValue(z.boolean(), 'FALSE', false)).toEqual({ ok: true, value: false });
  });
  it('validates enum members', () => {
    const e = z.enum(['template', 'remote-llm']);
    expect(coerceValue(e, 'remote-llm', false)).toEqual({ ok: true, value: 'remote-llm' });
    expect(coerceValue(e, 'bogus', false)).toMatchObject({ ok: false });
  });
  it('accepts null literal for nullable', () => {
    expect(coerceValue(z.number(), 'null', true)).toEqual({ ok: true, value: null });
  });
});

describe('isNullable', () => {
  it('detects nullable wrapped in default', () => {
    expect(isNullable(z.number().nullable().default(null))).toBe(true);
    expect(isNullable(z.number().default(5))).toBe(false);
  });
  it('detects plain nullable without wrappers', () => {
    expect(isNullable(z.number().nullable())).toBe(true);
  });
  it('detects nullable under optional wrapper', () => {
    expect(isNullable(z.number().nullable().optional())).toBe(true);
  });
  it('returns false for optional non-nullable', () => {
    expect(isNullable(z.string().optional())).toBe(false);
  });
});
