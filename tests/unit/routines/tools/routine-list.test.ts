/**
 * Unit tests for the routine-list MCP tool handler.
 *
 * Uses in-memory stubs for RoutineStore so no file I/O occurs.
 * Coverage:
 *  - Returns all definitions with latest run info attached
 *  - Applies enabled filter when the input flag is provided
 *  - Handles an empty store gracefully
 *  - Surfaces a store error as an isError result
 *  - Falls back to the definition without history when listRuns fails
 */

import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';

import { registerRoutineListTool } from '../../../../src/mcp/tools/routine-list.js';
import type { AppContext } from '../../../../src/types/app-config.js';
import type { RoutineDefinition, RoutineRunRecord, RoutineStore } from '../../../../src/services/routines/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefinition(overrides: Partial<RoutineDefinition> = {}): RoutineDefinition {
  const now = '2026-05-01T09:00:00.000Z';
  return {
    name: 'daily-summary',
    schedule: '0 9 * * *',
    enabled: true,
    prompt: 'Summarize the day',
    recentActivityMinutes: 60,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeRunRecord(overrides: Partial<RoutineRunRecord> = {}): RoutineRunRecord {
  return {
    runId: 'run-1',
    name: 'daily-summary',
    startedAt: '2026-05-01T09:00:00.000Z',
    completedAt: '2026-05-01T09:00:01.000Z',
    status: 'success',
    summary: 'Success summary',
    output: 'Success output',
    ...overrides
  };
}

/** Builds a stub RoutineStore that returns the supplied definitions and runs. */
function makeStubStore(opts: {
  definitions?: RoutineDefinition[];
  runsByName?: Record<string, RoutineRunRecord[]>;
  listDefinitionsError?: Error;
  listRunsError?: Error;
}): RoutineStore {
  return {
    async listDefinitions(): Promise<RoutineDefinition[]> {
      if (opts.listDefinitionsError) throw opts.listDefinitionsError;
      return opts.definitions ?? [];
    },
    async readDefinition(name): Promise<RoutineDefinition | undefined> {
      return (opts.definitions ?? []).find((d) => d.name === name);
    },
    async writeDefinition(definition): Promise<boolean> {
      return true;
    },
    async appendRun(_record): Promise<void> {},
    async listRuns(name, limit): Promise<RoutineRunRecord[]> {
      if (opts.listRunsError) throw opts.listRunsError;
      const runs = opts.runsByName?.[name] ?? [];
      return runs.slice(0, limit);
    }
  };
}

/** Builds a minimal AppContext with a stub routines store. */
function makeAppContext(store: RoutineStore): AppContext {
  return {
    config: {} as AppContext['config'],
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    services: {
      routines: { store, scheduler: undefined }
    } as unknown as AppContext['services']
  };
}

/**
 * Registers the routine-list tool on a fresh McpServer and invokes the
 * handler directly via the internal `_registeredTools` plain-object registry.
 * This avoids spinning up a full stdio/HTTP transport for unit tests.
 */
async function invokeRoutineList(
  app: AppContext,
  input: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerRoutineListTool(server, app);

  // The MCP SDK stores registered tools in a plain object keyed by tool name.
  // Each entry has a `handler` callable that matches the registered callback.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { handler: (input: unknown) => Promise<unknown> }>;
  const tool = tools['routine-list'];
  if (!tool) throw new Error('routine-list not registered');
  return tool.handler(input) as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routine-list tool — basic listing', () => {
  it('returns all definitions with structured content', async () => {
    const definition = makeDefinition();
    const store = makeStubStore({ definitions: [definition] });
    const app = makeAppContext(store);

    const result = await invokeRoutineList(app);

    expect(result).toMatchObject({
      content: [{ type: 'text', text: '1 routine(s) configured.' }],
      structuredContent: {
        total: 1,
        routines: [
          {
            name: 'daily-summary',
            schedule: '0 9 * * *',
            enabled: true,
            prompt: 'Summarize the day',
            recentActivityMinutes: 60
          }
        ]
      }
    });
  });

  it('attaches the latest run record to each definition', async () => {
    const definition = makeDefinition();
    const run = makeRunRecord({ status: 'success', summary: 'All done' });
    const store = makeStubStore({
      definitions: [definition],
      runsByName: { 'daily-summary': [run] }
    });
    const app = makeAppContext(store);

    const result = await invokeRoutineList(app);

    const structured = result.structuredContent as { routines: Array<{ latestRun?: { status: string; summary: string } }> };
    expect(structured.routines[0].latestRun).toEqual({
      runId: 'run-1',
      startedAt: '2026-05-01T09:00:00.000Z',
      completedAt: '2026-05-01T09:00:01.000Z',
      status: 'success',
      summary: 'All done'
    });
  });

  it('omits latestRun when the routine has no run history', async () => {
    const definition = makeDefinition();
    const store = makeStubStore({ definitions: [definition], runsByName: {} });
    const app = makeAppContext(store);

    const result = await invokeRoutineList(app);

    const structured = result.structuredContent as { routines: Array<Record<string, unknown>> };
    expect('latestRun' in structured.routines[0]).toBe(false);
  });

  it('returns an empty list when no routines are configured', async () => {
    const store = makeStubStore({ definitions: [] });
    const app = makeAppContext(store);

    const result = await invokeRoutineList(app);

    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'No routines configured.' }],
      structuredContent: { total: 0, routines: [] }
    });
  });
});

describe('routine-list tool — enabled filter', () => {
  it('filters to only enabled routines when enabled=true', async () => {
    const store = makeStubStore({
      definitions: [
        makeDefinition({ name: 'active', enabled: true }),
        makeDefinition({ name: 'paused', enabled: false })
      ]
    });
    const app = makeAppContext(store);

    const result = await invokeRoutineList(app, { enabled: true });

    const structured = result.structuredContent as { routines: Array<{ name: string }>; total: number };
    expect(structured.total).toBe(1);
    expect(structured.routines[0].name).toBe('active');
  });

  it('filters to only disabled routines when enabled=false', async () => {
    const store = makeStubStore({
      definitions: [
        makeDefinition({ name: 'active', enabled: true }),
        makeDefinition({ name: 'paused', enabled: false })
      ]
    });
    const app = makeAppContext(store);

    const result = await invokeRoutineList(app, { enabled: false });

    const structured = result.structuredContent as { routines: Array<{ name: string }>; total: number };
    expect(structured.total).toBe(1);
    expect(structured.routines[0].name).toBe('paused');
  });

  it('returns all routines when enabled is omitted', async () => {
    const store = makeStubStore({
      definitions: [
        makeDefinition({ name: 'active', enabled: true }),
        makeDefinition({ name: 'paused', enabled: false })
      ]
    });
    const app = makeAppContext(store);

    const result = await invokeRoutineList(app, {});

    const structured = result.structuredContent as { total: number };
    expect(structured.total).toBe(2);
  });
});

describe('routine-list tool — kind field exclusion', () => {
  it('output does not include kind property (AC #11)', async () => {
    const definition = makeDefinition();
    const store = makeStubStore({ definitions: [definition] });
    const app = makeAppContext(store);

    const result = await invokeRoutineList(app);

    const structured = result.structuredContent as { routines: Array<Record<string, unknown>> };
    const routine = structured.routines[0];
    expect(routine).not.toHaveProperty('kind');
  });
});

describe('routine-list tool — error handling', () => {
  it('returns an isError result when listDefinitions throws', async () => {
    const store = makeStubStore({
      listDefinitionsError: new Error('disk read failed')
    });
    const app = makeAppContext(store);

    const result = await invokeRoutineList(app);

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { routines: [], total: 0 }
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('routine-list failed');
    expect(content[0].text).toContain('disk read failed');
  });

  it('falls back to definition without history when listRuns throws', async () => {
    const definition = makeDefinition();
    const store = makeStubStore({
      definitions: [definition],
      listRunsError: new Error('history corrupt')
    });
    const app = makeAppContext(store);

    const result = await invokeRoutineList(app);

    // The tool should not propagate the error — it returns the definition.
    expect(result).not.toMatchObject({ isError: true });
    const structured = result.structuredContent as { routines: Array<{ name: string }>; total: number };
    expect(structured.total).toBe(1);
    expect(structured.routines[0].name).toBe('daily-summary');
    expect('latestRun' in structured.routines[0]).toBe(false);
  });
});
