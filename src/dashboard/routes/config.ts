// src/dashboard/routes/config.ts
// Dashboard API routes for configuration management.
import { sendJson, type ApiRouter } from '../api-router.js';
import { ConfigCliService, CliError } from '../../config/config-cli-service.js';
import { appConfigSchema } from '../../config/schema.js';
import { loadConfig } from '../../config/load-config.js';
import { isSecretPath, maskValue } from '../../config/config-secrets.js';
import { zodToJsonSchema } from '../schema-export.js';

/** Shared CLI service instance for all config route handlers. */
const cliService = new ConfigCliService();

/**
 * Recursively mask secret fields in a plain config object.
 * Fields whose dot-path is in SECRET_PATHS are replaced with '***'.
 */
function maskSecrets(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const dotPath = prefix ? `${prefix}.${key}` : key;
    if (isSecretPath(dotPath)) {
      result[key] = maskValue(value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = maskSecrets(value as Record<string, unknown>, dotPath);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Register /config routes onto the given router. */
export function registerConfigRoutes(router: ApiRouter): void {

  // GET /config/effective — return the fully-resolved (file + env) config with secrets always masked.
  // Bulk reveal is intentionally not supported; use GET /config/get?path=...&reveal=true instead.
  router.register('GET', '/config/effective', async (_ctx, _app) => {
    const config = await loadConfig();
    const masked = maskSecrets(config as unknown as Record<string, unknown>);
    sendJson(_ctx.res, 200, { config: masked });
  });

  // GET /config — list all config entries with provenance (file vs. default).
  // Secrets are always masked; use GET /config/get?path=...&reveal=true for single-field reveal.
  router.register('GET', '/config', async (ctx, _app) => {
    const entries = await cliService.list({ reveal: false });
    sendJson(ctx.res, 200, { entries });
  });

  // GET /config/get — retrieve a single config field value.
  // Query params: path (required), reveal (optional, boolean).
  // Only the specifically requested field is revealed, limiting secret exposure blast radius.
  router.register('GET', '/config/get', async (ctx, _app) => {
    const path = ctx.req.query.get('path');
    if (!path) {
      sendJson(ctx.res, 400, { error: 'Query param "path" is required' });
      return;
    }
    const reveal = ctx.req.query.get('reveal') === 'true';
    try {
      const result = await cliService.get(path, { reveal });
      sendJson(ctx.res, 200, result);
    } catch (err) {
      if (err instanceof CliError) {
        sendJson(ctx.res, 400, { error: err.message });
      } else {
        throw err;
      }
    }
  });

  // GET /config/schema — return the JSON schema derived from appConfigSchema.
  router.register('GET', '/config/schema', async (_ctx, _app) => {
    const schema = zodToJsonSchema(appConfigSchema);
    sendJson(_ctx.res, 200, schema);
  });

  // POST /config/set — set a single config field value.
  // Body: { path: string, value: string }
  router.register('POST', '/config/set', async (ctx, _app) => {
    const body = ctx.req.body as Record<string, unknown> | undefined;
    const path = typeof body?.path === 'string' ? body.path : undefined;
    const value = body?.value !== undefined ? String(body.value) : undefined;
    if (!path || value === undefined) {
      sendJson(ctx.res, 400, { error: 'Body must include "path" (string) and "value"' });
      return;
    }
    try {
      const result = await cliService.set(path, value);
      sendJson(ctx.res, 200, result);
    } catch (err) {
      if (err instanceof CliError) {
        sendJson(ctx.res, 400, { error: err.message });
      } else {
        throw err;
      }
    }
  });

  // POST /config/unset — remove a config field from the file (revert to default).
  // Body: { path: string }
  router.register('POST', '/config/unset', async (ctx, _app) => {
    const body = ctx.req.body as Record<string, unknown> | undefined;
    const path = typeof body?.path === 'string' ? body.path : undefined;
    if (!path) {
      sendJson(ctx.res, 400, { error: 'Body must include "path" (string)' });
      return;
    }
    try {
      const result = await cliService.unset(path);
      sendJson(ctx.res, 200, result);
    } catch (err) {
      if (err instanceof CliError) {
        sendJson(ctx.res, 400, { error: err.message });
      } else {
        throw err;
      }
    }
  });

  // POST /config/array-add — append an item to an array config field.
  // Body: { path: string, item: string }
  router.register('POST', '/config/array-add', async (ctx, _app) => {
    const body = ctx.req.body as Record<string, unknown> | undefined;
    const path = typeof body?.path === 'string' ? body.path : undefined;
    const item = typeof body?.item === 'string' ? body.item : undefined;
    if (!path || item === undefined) {
      sendJson(ctx.res, 400, { error: 'Body must include "path" (string) and "item" (string)' });
      return;
    }
    try {
      const result = await cliService.addToArray(path, item);
      sendJson(ctx.res, 200, result);
    } catch (err) {
      if (err instanceof CliError) {
        sendJson(ctx.res, 400, { error: err.message });
      } else {
        throw err;
      }
    }
  });

  // POST /config/array-remove — remove an item from an array config field.
  // Body: { path: string, item: string }
  router.register('POST', '/config/array-remove', async (ctx, _app) => {
    const body = ctx.req.body as Record<string, unknown> | undefined;
    const path = typeof body?.path === 'string' ? body.path : undefined;
    const item = typeof body?.item === 'string' ? body.item : undefined;
    if (!path || item === undefined) {
      sendJson(ctx.res, 400, { error: 'Body must include "path" (string) and "item" (string)' });
      return;
    }
    try {
      const result = await cliService.removeFromArray(path, item);
      sendJson(ctx.res, 200, result);
    } catch (err) {
      if (err instanceof CliError) {
        sendJson(ctx.res, 400, { error: err.message });
      } else {
        throw err;
      }
    }
  });

  // POST /config/validate — validate the current config file against the schema.
  // Returns 200 on success, 422 on validation failure.
  router.register('POST', '/config/validate', async (_ctx, _app) => {
    const result = await cliService.validate();
    const statusCode = result.ok ? 200 : 422;
    sendJson(_ctx.res, statusCode, result);
  });
}
