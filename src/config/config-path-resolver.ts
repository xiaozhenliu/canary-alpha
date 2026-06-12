import { z } from 'zod';
import { appConfigSchema } from './schema.js';

export type SchemaResolveResult =
  | { ok: true; schema: z.ZodTypeAny; isArray: boolean; nullable: boolean }
  | { ok: false; error: 'not-found'; availableKeys: string[] }
  | { ok: false; error: 'unsupported' };

// Unwrap ZodDefault/ZodOptional/ZodNullable wrappers layer by layer to obtain the inner type.
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (
    current instanceof z.ZodDefault ||
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable
  ) {
    current = current.unwrap() as z.ZodTypeAny;
  }
  return current;
}

const SUPPORTED_LEAF = [
  z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodEnum, z.ZodArray
] as const;

function isSupportedLeaf(schema: z.ZodTypeAny): boolean {
  return SUPPORTED_LEAF.some((ctor) => schema instanceof ctor);
}

export function resolveSchemaAtPath(path: string[]): SchemaResolveResult {
  let current: z.ZodTypeAny = appConfigSchema;

  for (let i = 0; i < path.length; i += 1) {
    const inner = unwrap(current);
    if (!(inner instanceof z.ZodObject)) {
      return { ok: false, error: 'not-found', availableKeys: [] };
    }
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    const key = path[i];
    if (!(key in shape)) {
      return { ok: false, error: 'not-found', availableKeys: Object.keys(shape) };
    }
    current = shape[key];
  }

  const leaf = unwrap(current);
  if (leaf instanceof z.ZodObject) {
    return { ok: false, error: 'not-found', availableKeys: Object.keys(leaf.shape as object) };
  }
  if (!isSupportedLeaf(leaf)) {
    return { ok: false, error: 'unsupported' };
  }
  return { ok: true, schema: leaf, isArray: leaf instanceof z.ZodArray, nullable: isNullable(current) };
}

export type CoerceResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

// Coerce a CLI string to the leaf zod type. leaf is already unwrapped. rawValue has had '--' terminator handled by the caller.
// Callers must not invoke this function when resolveSchemaAtPath returns isArray===true (arrays go through add/remove, not coerce).
export function coerceValue(leaf: z.ZodTypeAny, rawValue: string, nullable: boolean): CoerceResult {
  if (nullable && rawValue.toLowerCase() === 'null') {
    return { ok: true, value: null };
  }
  if (leaf instanceof z.ZodNumber) {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) {
      return { ok: false, message: `expected number, got '${rawValue}'` };
    }
    return { ok: true, value: n };
  }
  if (leaf instanceof z.ZodBoolean) {
    const lower = rawValue.toLowerCase();
    if (lower === 'true') return { ok: true, value: true };
    if (lower === 'false') return { ok: true, value: false };
    return { ok: false, message: `expected true|false, got '${rawValue}'` };
  }
  if (leaf instanceof z.ZodEnum) {
    const options = leaf.options as string[];
    if (!options.includes(rawValue)) {
      return { ok: false, message: `expected one of ${options.join('|')}, got '${rawValue}'` };
    }
    return { ok: true, value: rawValue };
  }
  if (leaf instanceof z.ZodString) {
    return { ok: true, value: rawValue };
  }
  return { ok: false, message: `cannot set this field type directly` };
}

// Determine whether a leaf (possibly wrapped in any number of ZodDefault/ZodOptional/ZodNullable layers) is nullable.
export function isNullable(schema: z.ZodTypeAny): boolean {
  let current = schema;
  while (
    current instanceof z.ZodDefault ||
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable
  ) {
    if (current instanceof z.ZodNullable) return true;
    current = current.unwrap() as z.ZodTypeAny;
  }
  return false;
}
