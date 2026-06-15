import * as nodeCron from 'node-cron';
import type { ApiRouter } from '../api-router.js';
import { sendJson } from '../api-router.js';
import type { RoutineDefinition } from '../../services/routines/types.js';

/**
 * Convert an arbitrary string into a URL-safe slug.
 * Lowercases, replaces whitespace runs with hyphens, strips non-alphanumeric
 * characters (except hyphens), and trims leading/trailing hyphens.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

/** Register /routines routes onto the given router. */
export function registerRoutinesRoutes(router: ApiRouter): void {
  // GET /routines — list all routine definitions, optionally filtered by ?enabled
  router.register('GET', '/routines', async (ctx, app) => {
    const enabledFilter = ctx.req.query.get('enabled');

    let definitions = await app.services.routines.store.listDefinitions();

    // Apply optional ?enabled filter (accepts 'true' or 'false').
    if (enabledFilter !== null) {
      const wantEnabled = enabledFilter === 'true';
      definitions = definitions.filter((d) => d.enabled === wantEnabled);
    }

    // Enrich each definition with the latest run record.
    const enriched = await Promise.all(
      definitions.map(async (def) => {
        const runs = await app.services.routines.store.listRuns(def.name, 1);
        return {
          ...def,
          latestRun: runs[0] ?? null
        };
      })
    );

    sendJson(ctx.res, 200, { routines: enriched, total: enriched.length });
  });

  // POST /routines — create or update a routine definition
  router.register('POST', '/routines', async (ctx, app) => {
    const body = ctx.req.body as Record<string, unknown> | undefined;

    if (!body || typeof body !== 'object') {
      sendJson(ctx.res, 400, { error: 'Request body is required' });
      return;
    }

    const { name, prompt, schedule, enabled, recentActivityMinutes } = body as {
      name?: unknown;
      prompt?: unknown;
      schedule?: unknown;
      enabled?: unknown;
      recentActivityMinutes?: unknown;
    };

    // Validate required fields.
    if (typeof name !== 'string' || name.trim() === '') {
      sendJson(ctx.res, 400, { error: 'Field "name" is required and must be a non-empty string' });
      return;
    }
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      sendJson(ctx.res, 400, { error: 'Field "prompt" is required and must be a non-empty string' });
      return;
    }
    if (typeof schedule !== 'string' || schedule.trim() === '') {
      sendJson(ctx.res, 400, { error: 'Field "schedule" is required and must be a non-empty string' });
      return;
    }

    // Validate cron expression.
    if (!nodeCron.validate(schedule)) {
      sendJson(ctx.res, 400, { error: `Invalid cron expression: "${schedule}"` });
      return;
    }

    // Slugify the name to create a stable identifier.
    const sluggedName = slugify(name);
    if (sluggedName === '') {
      sendJson(ctx.res, 400, { error: 'Field "name" must contain at least one alphanumeric character' });
      return;
    }

    const now = new Date().toISOString();

    // Check whether this is a create or update by reading the existing definition.
    const existing = await app.services.routines.store.readDefinition(sluggedName);

    const definition: RoutineDefinition = {
      name: sluggedName,
      schedule,
      enabled: typeof enabled === 'boolean' ? enabled : true,
      kind: 'daily_summary',
      prompt,
      recentActivityMinutes:
        typeof recentActivityMinutes === 'number' && recentActivityMinutes > 0
          ? Math.floor(recentActivityMinutes)
          : 60,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    // writeDefinition returns true when the definition is new.
    const isNew = await app.services.routines.store.writeDefinition(definition);

    // Refresh the scheduler when it is running so the new/updated cron
    // expression takes effect without a server restart.
    if (app.services.routines.scheduler !== undefined) {
      await app.services.routines.scheduler.refresh();
    }

    // Re-read the saved definition to return the canonical on-disk record.
    const saved = await app.services.routines.store.readDefinition(sluggedName);
    if (saved === undefined) {
      sendJson(ctx.res, 500, { error: 'Failed to read back saved routine definition' });
      return;
    }

    sendJson(ctx.res, isNew ? 201 : 200, { routine: saved, isNew });
  });

  // GET /routines/:name/history — list run history for a specific routine
  router.register('GET', '/routines/:name/history', async (ctx, app) => {
    const { name } = ctx.req.params;

    const rawLimit = ctx.req.query.get('limit');
    let limit = 20;
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(Math.floor(parsed), 100);
      }
    }

    const runs = await app.services.routines.store.listRuns(name, limit);
    sendJson(ctx.res, 200, { name, runs, total: runs.length });
  });
}
