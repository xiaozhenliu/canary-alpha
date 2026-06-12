// src/config/config-cli-service.ts
import { z } from 'zod';
import { appConfigSchema } from './schema.js';
import { ConfigFileStore } from './config-file-store.js';
import { resolveSchemaAtPath, coerceValue } from './config-path-resolver.js';
import { computeConfigProvenance } from './config-provenance.js';
import { isSecretPath, maskValue } from './config-secrets.js';
import type { Document } from 'yaml';

// list 展示文件态：字段在文件中显式存在为 'file'，否则回落 schema 默认为 'default'。
export type ConfigValueSource = 'file' | 'default';

export interface ConfigGetResult {
  path: string;
  display: string;
  overriddenByEnv?: string;
  envDegraded?: boolean;
}
export interface ConfigMutateResult {
  path: string;
  ok: boolean;
  message: string;
  overriddenByEnv?: string;
  noop?: boolean;
}
export interface ConfigValidateResult {
  ok: boolean;
  syntaxError?: string;
  errors: Array<{ path: string; message: string }>;
}
export interface ConfigListEntry {
  path: string;
  display: string;
  source: ConfigValueSource;
  overriddenByEnv?: string;
}

function splitPath(dotted: string): string[] {
  return dotted.split('.');
}

function safeProvenance(): Map<string, { overriddenByEnv?: string }> | null {
  try {
    return computeConfigProvenance();
  } catch {
    return null;
  }
}

export class ConfigCliService {
  constructor(private readonly store: ConfigFileStore = new ConfigFileStore()) {}

  configPath(): string {
    return this.store.path();
  }

  private formatValue(path: string, value: unknown, reveal: boolean): string {
    if (isSecretPath(path) && !reveal) {
      return maskValue(value);
    }
    if (value === undefined) return '(unset)';
    if (Array.isArray(value)) return value.length ? value.join(', ') : '(empty)';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  // resolved 必为失败态。showAvailable=true 时附带同层可选 key 提示。
  private pathError(
    resolved: { error: 'not-found'; availableKeys: string[] } | { error: 'unsupported' },
    dotted: string,
    showAvailable = false
  ): CliError {
    if (resolved.error === 'unsupported') {
      return new CliError(`Unsupported schema type at ${dotted}; edit config.yaml manually`);
    }
    const hint = showAvailable && resolved.availableKeys.length
      ? ` (available: ${resolved.availableKeys.join(', ')})` : '';
    return new CliError(`Unknown config path: ${dotted}${hint}`);
  }

  async get(dotted: string, opts: { reveal: boolean }): Promise<ConfigGetResult> {
    const path = splitPath(dotted);
    const resolved = resolveSchemaAtPath(path);
    if (!resolved.ok) {
      throw this.pathError(resolved, dotted, true);
    }
    const { doc } = await this.store.readDocument();
    const fileValue = this.store.getAtPath(doc, path);
    const prov = safeProvenance();
    const override = prov?.get(dotted);
    return {
      path: dotted,
      display: this.formatValue(dotted, fileValue, opts.reveal),
      overriddenByEnv: override?.overriddenByEnv,
      envDegraded: prov === null
    };
  }

  async set(dotted: string, rawValue: string): Promise<ConfigMutateResult> {
    const path = splitPath(dotted);
    const resolved = resolveSchemaAtPath(path);
    if (!resolved.ok) {
      throw this.pathError(resolved, dotted);
    }
    if (resolved.isArray) {
      throw new CliError(`Use 'config add/remove' for array field ${dotted}`);
    }
    const coerced = coerceValue(resolved.schema, rawValue, resolved.nullable);
    if (!coerced.ok) {
      throw new CliError(`Cannot set ${dotted}: ${coerced.message}`);
    }
    const { doc, existed } = await this.store.readDocument();
    // null 字面量（仅 nullable 字段可达）等价于 unset：删除该 key。
    if (coerced.value === null) {
      this.store.deleteAtPath(doc, path);
    } else {
      this.store.setScalarAtPath(doc, path, coerced.value);
    }
    this.assertValid(doc);
    await this.store.write(doc);
    const prov = safeProvenance();
    return {
      path: dotted,
      ok: true,
      message: existed ? `set ${dotted}` : `created config and set ${dotted}`,
      overriddenByEnv: prov?.get(dotted)?.overriddenByEnv
    };
  }

  async unset(dotted: string): Promise<ConfigMutateResult> {
    const path = splitPath(dotted);
    const resolved = resolveSchemaAtPath(path);
    if (!resolved.ok) {
      throw this.pathError(resolved, dotted);
    }
    const { doc } = await this.store.readDocument();
    const had = this.store.getAtPath(doc, path) !== undefined;
    if (!had) {
      return { path: dotted, ok: true, message: `${dotted} was not set`, noop: true };
    }
    this.store.deleteAtPath(doc, path);
    try {
      this.assertValid(doc);
    } catch (err) {
      if (err instanceof CliError) {
        throw new CliError(`Cannot unset required field ${dotted}`);
      }
      throw err;
    }
    await this.store.write(doc);
    return {
      path: dotted,
      ok: true,
      message: `unset ${dotted}`
    };
  }

  async addToArray(dotted: string, item: string): Promise<ConfigMutateResult> {
    return this.mutateArray(dotted, item, 'add');
  }

  async removeFromArray(dotted: string, item: string): Promise<ConfigMutateResult> {
    return this.mutateArray(dotted, item, 'remove');
  }

  private async mutateArray(dotted: string, item: string, op: 'add' | 'remove'): Promise<ConfigMutateResult> {
    const path = splitPath(dotted);
    const resolved = resolveSchemaAtPath(path);
    if (!resolved.ok) throw this.pathError(resolved, dotted);
    if (!resolved.isArray) throw new CliError(`${dotted} is not an array field`);
    const { doc } = await this.store.readDocument();
    const changed = op === 'add'
      ? this.store.addToSeqAtPath(doc, path, item)
      : this.store.removeFromSeqAtPath(doc, path, item);
    if (!changed) {
      return {
        path: dotted,
        ok: true,
        noop: true,
        message: op === 'add' ? `${item} already present` : `${item} not found`
      };
    }
    this.assertValid(doc);
    await this.store.write(doc);
    return { path: dotted, ok: true, message: `${op} ${item} in ${dotted}` };
  }

  async validate(): Promise<ConfigValidateResult> {
    let doc: Document;
    try {
      ({ doc } = await this.store.readDocument());
    } catch (e) {
      return { ok: false, syntaxError: (e as Error).message, errors: [] };
    }
    const js = doc.toJS() as unknown ?? {};
    const parsed = appConfigSchema.safeParse(js);
    if (parsed.success) return { ok: true, errors: [] };
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    };
  }

  async list(opts: { reveal: boolean }): Promise<ConfigListEntry[]> {
    const { doc } = await this.store.readDocument();
    const prov = safeProvenance();
    const entries: ConfigListEntry[] = [];
    for (const path of enumerateSchemaPaths()) {
      const dotted = path.join('.');
      const fileValue = this.store.getAtPath(doc, path);
      entries.push({
        path: dotted,
        display: this.formatValue(dotted, fileValue, opts.reveal),
        source: fileValue === undefined ? 'default' : 'file',
        overriddenByEnv: prov?.get(dotted)?.overriddenByEnv
      });
    }
    return entries;
  }

  private assertValid(doc: Document): void {
    const js = doc.toJS() as unknown ?? {};
    const parsed = appConfigSchema.safeParse(js);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new CliError(`Validation failed at ${first.path.join('.')}: ${first.message}`);
    }
  }
}

export class CliError extends Error {}

function enumerateSchemaPaths(): string[][] {
  const out: string[][] = [];
  const walk = (schema: z.ZodTypeAny, prefix: string[]): void => {
    let s: z.ZodTypeAny = schema;
    while (s instanceof z.ZodDefault || s instanceof z.ZodOptional || s instanceof z.ZodNullable) {
      s = s.unwrap() as z.ZodTypeAny;
    }
    if (s instanceof z.ZodObject) {
      for (const [k, v] of Object.entries(s.shape as Record<string, z.ZodTypeAny>)) {
        walk(v, [...prefix, k]);
      }
    } else {
      out.push(prefix);
    }
  };
  walk(appConfigSchema, []);
  return out;
}
