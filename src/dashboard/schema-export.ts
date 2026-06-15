// src/dashboard/schema-export.ts
// Converts the Zod 4.x appConfigSchema into a JSON Schema node tree for the dashboard UI.
import { z } from 'zod';
import { SECRET_PATHS } from '../config/config-secrets.js';

/** A node in the emitted JSON schema tree. */
export interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  required?: string[];
  nullable?: boolean;
  minimum?: number;
  format?: string;
  isSecret?: boolean;
}

/**
 * Recursively convert a Zod 4 schema into a JsonSchemaNode.
 *
 * @param schema     Any Zod schema instance.
 * @param pathPrefix Dot-path prefix used to detect secret fields (e.g. "providers.embeddings").
 */
export function zodToJsonSchema(
  schema: z.ZodTypeAny,
  pathPrefix?: string
): JsonSchemaNode {
  const node: JsonSchemaNode = {};

  // Mark secrets at the leaf level before unwrapping wrappers.
  if (pathPrefix && SECRET_PATHS.has(pathPrefix)) {
    node.isSecret = true;
  }

  // --- Unwrap ZodDefault: extract the default value, then recurse on the inner type ---
  if (schema instanceof z.ZodDefault) {
    const inner = schema.unwrap() as z.ZodTypeAny;
    const defaultVal = (schema as z.ZodDefault<z.ZodTypeAny>).def.defaultValue;
    const innerNode = zodToJsonSchema(inner, pathPrefix);
    // Merge: default overrides any value from the inner node.
    return { ...innerNode, default: typeof defaultVal === 'function' ? defaultVal() : defaultVal, ...node };
  }

  // --- Unwrap ZodOptional ---
  if (schema instanceof z.ZodOptional) {
    const inner = schema.unwrap() as z.ZodTypeAny;
    return { ...zodToJsonSchema(inner, pathPrefix), ...node };
  }

  // --- Unwrap ZodNullable: mark nullable then recurse ---
  if (schema instanceof z.ZodNullable) {
    const inner = schema.unwrap() as z.ZodTypeAny;
    const innerNode = zodToJsonSchema(inner, pathPrefix);
    return { ...innerNode, nullable: true, ...node };
  }

  // --- ZodObject: recurse into shape, track required fields ---
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchemaNode> = {};
    const required: string[] = [];

    for (const [key, fieldSchema] of Object.entries(shape)) {
      const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      properties[key] = zodToJsonSchema(fieldSchema, fieldPath);

      // A field is required when it is not ZodOptional and has no ZodDefault wrapper.
      if (!(fieldSchema instanceof z.ZodOptional) && !(fieldSchema instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    node.type = 'object';
    node.properties = properties;
    if (required.length > 0) node.required = required;
    return node;
  }

  // --- ZodString ---
  if (schema instanceof z.ZodString) {
    node.type = 'string';
    return node;
  }

  // --- ZodNumber: use Zod 4 instance properties isInt and minValue ---
  if (schema instanceof z.ZodNumber) {
    node.type = 'number';
    if ((schema as z.ZodNumber).isInt) {
      node.format = 'integer';
    }
    const min = (schema as z.ZodNumber).minValue;
    if (min !== null && min !== undefined && min !== -Infinity) {
      node.minimum = min;
    }
    return node;
  }

  // --- ZodBoolean ---
  if (schema instanceof z.ZodBoolean) {
    node.type = 'boolean';
    return node;
  }

  // --- ZodEnum: emit type string + enum values ---
  if (schema instanceof z.ZodEnum) {
    node.type = 'string';
    // Access options via the def.entries values to stay compatible with Zod 4 types.
    const entries = (schema as z.ZodEnum<Record<string, string>>).def.entries;
    node.enum = Object.values(entries);
    return node;
  }

  // --- ZodArray: recurse into element type ---
  if (schema instanceof z.ZodArray) {
    node.type = 'array';
    const elementSchema = (schema as z.ZodArray<z.ZodTypeAny>).def.element as z.ZodTypeAny;
    node.items = zodToJsonSchema(elementSchema, pathPrefix ? `${pathPrefix}[]` : undefined);
    return node;
  }

  // Fallback: unknown schema type — return empty node.
  return node;
}
