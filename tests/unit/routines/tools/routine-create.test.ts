/**
 * Unit tests for the routine-create MCP tool handler.
 *
 * Uses in-memory stubs for RoutineStore and RoutineScheduler so no
 * file I/O or real cron timers are involved.
 *
 * Coverage:
 *  - Creates a new routine with a valid cron expression
 *  - Updates an existing routine (isNew=false)
 *  - Rejects an invalid cron expression before touching the store
 *  - Rejects a name that contains only special characters
 *  - Normalizes the routine name to a lowercase slug
 *  - Refreshes the scheduler when one is present
 *  - Returns an isError result when the store write fails
 */

import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';

import { registerRoutineCreateTool } from '../../../../src/mcp/tools/routine-create.js';
import type { AppContext } from '../../../../src/types/app-config.js';
import type { RoutineDefinition, RoutineStore } from '../../../../src/services/routines/types.js';
import type { RoutineScheduler } from '../../../../src/services/routines/scheduler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory RoutineStore stub with configurable error injection. */
class StubStore implements RoutineStore {
  private definitions = new Map<string, RoutineDefinition>();
  writeError?: Error;
  readAfterWriteError?: Error;

  async listDefinitions(): Promise<RoutineDefinition[]> {
    return [...this.definitions.values()];
  }

  async readDefinition(name: string): Promise<RoutineDefinition | undefined> {
    if (this.readAfterWriteError) throw this.readAfterWriteError;
    return this.definitions.get(name);
  }

  async writeDefinition(definition: RoutineDefinition): Promise<boolean> {
    if (this.writeError) throw this.writeError;
    const isNew = !this.definitions.has(definition.name);
    if (isNew) {
      // Preserve the incoming createdAt; simulate the real store behavior.
      this.definitions.set(definition.name, definition);
    } else {
      // Update in place but preserve original createdAt.
      const existing = this.definitions.get(definition.name)!;
      this.definitions.set(definition.name, {
        ...definition,
        createdAt: existing.createdAt
      });
    }
    return isNew;
  }

  async appendRun(): Promise<void> {}
  async listRuns(): Promise<[]> { return []; }
}

/** Minimal scheduler stub that records refresh calls. */
function makeSchedulerStub(opts: { throwOnRefresh?: boolean } = {}): RoutineScheduler & { refreshCalls: number } {
  let refreshCalls = 0;
  return {
    get refreshCalls() { return refreshCalls; },
    async start() {},
    async stop() {},
    async refresh() {
      refreshCalls++;
      if (opts.throwOnRefresh) throw new Error('refresh failed');
    }
  } as unknown as RoutineScheduler & { refreshCalls: number };
}

function makeAppContext(store: RoutineStore, scheduler?: RoutineScheduler): AppContext {
  return {
    config: {} as AppContext['config'],
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    services: {
      routines: { store, scheduler }
    } as unknown as AppContext['services']
  };
}

async function invokeRoutineCreate(
  app: AppContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerRoutineCreateTool(server, app);

  // The MCP SDK stores registered tools in a plain object keyed by tool name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { handler: (input: unknown) => Promise<unknown> }>;
  const tool = tools['routine-create'];
  if (!tool) throw new Error('routine-create not registered');
  return tool.handler(input) as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routine-create tool — creation', () => {
  it('creates a new routine and returns isNew=true', async () => {
    const store = new StubStore();
    const app = makeAppContext(store);

    const result = await invokeRoutineCreate(app, {
      name: 'morning-check',
      prompt: 'Check morning activity',
      schedule: '0 8 * * *',
      enabled: true,
      recentActivityMinutes: 30
    });

    expect(result).not.toMatchObject({ isError: true });
    const structured = result.structuredContent as { isNew: boolean; routine: { name: string; schedule: string } };
    expect(structured.isNew).toBe(true);
    expect(structured.routine.name).toBe('morning-check');
    expect(structured.routine.schedule).toBe('0 8 * * *');

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('created');
  });

  it('normalizes the routine name to a lowercase hyphenated slug', async () => {
    const store = new StubStore();
    const app = makeAppContext(store);

    const result = await invokeRoutineCreate(app, {
      name: 'Daily SUMMARY!!!',
      prompt: 'Summarize',
      schedule: '0 9 * * *',
      enabled: true,
      recentActivityMinutes: 60
    });

    expect(result).not.toMatchObject({ isError: true });
    const structured = result.structuredContent as { routine: { name: string } };
    expect(structured.routine.name).toBe('daily-summary');
  });

  it('accepts explicit values for enabled and recentActivityMinutes', async () => {
    const store = new StubStore();
    const app = makeAppContext(store);

    // Provide all fields explicitly to test the handler receives them correctly.
    const result = await invokeRoutineCreate(app, {
      name: 'nightly',
      prompt: 'Nightly report',
      schedule: '0 23 * * *',
      enabled: true,
      recentActivityMinutes: 60
    });

    expect(result).not.toMatchObject({ isError: true });
    const structured = result.structuredContent as { routine: { enabled: boolean; recentActivityMinutes: number } };
    expect(structured.routine.enabled).toBe(true);
    expect(structured.routine.recentActivityMinutes).toBe(60);
  });
});

describe('routine-create tool — update', () => {
  it('updates an existing routine and returns isNew=false', async () => {
    const store = new StubStore();
    // Pre-populate with an existing definition.
    await store.writeDefinition({
      name: 'daily-summary',
      schedule: '0 9 * * *',
      enabled: true,
      prompt: 'Old prompt',
      recentActivityMinutes: 60,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });

    const app = makeAppContext(store);

    const result = await invokeRoutineCreate(app, {
      name: 'daily-summary',
      prompt: 'New prompt',
      schedule: '30 9 * * *',
      enabled: false,
      recentActivityMinutes: 90
    });

    expect(result).not.toMatchObject({ isError: true });
    const structured = result.structuredContent as {
      isNew: boolean;
      routine: { prompt: string; schedule: string; enabled: boolean };
    };
    expect(structured.isNew).toBe(false);
    expect(structured.routine.prompt).toBe('New prompt');
    expect(structured.routine.schedule).toBe('30 9 * * *');
    expect(structured.routine.enabled).toBe(false);

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('updated');
  });
});

describe('routine-create tool — validation', () => {
  it('rejects an invalid cron expression without touching the store', async () => {
    const store = new StubStore();
    store.writeError = new Error('should not be called');
    const app = makeAppContext(store);

    const result = await invokeRoutineCreate(app, {
      name: 'bad-schedule',
      prompt: 'Test',
      schedule: 'not-a-cron',
      enabled: true,
      recentActivityMinutes: 60
    });

    expect(result).toMatchObject({ isError: true });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('invalid cron expression');
    expect(content[0].text).toContain('not-a-cron');
  });

  it('rejects a name that contains only special characters', async () => {
    const store = new StubStore();
    const app = makeAppContext(store);

    const result = await invokeRoutineCreate(app, {
      name: '!!!',
      prompt: 'Test',
      schedule: '0 9 * * *',
      enabled: true,
      recentActivityMinutes: 60
    });

    expect(result).toMatchObject({ isError: true });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('name must contain at least one letter or number');
  });
});

describe('routine-create tool — scheduler integration', () => {
  it('calls scheduler.refresh() after a successful write when scheduler is present', async () => {
    const store = new StubStore();
    const scheduler = makeSchedulerStub();
    const app = makeAppContext(store, scheduler);

    await invokeRoutineCreate(app, {
      name: 'with-scheduler',
      prompt: 'Has scheduler',
      schedule: '0 10 * * *',
      enabled: true,
      recentActivityMinutes: 60
    });

    expect(scheduler.refreshCalls).toBe(1);
  });

  it('returns success even when scheduler.refresh() throws', async () => {
    const store = new StubStore();
    const scheduler = makeSchedulerStub({ throwOnRefresh: true });
    const app = makeAppContext(store, scheduler);

    const result = await invokeRoutineCreate(app, {
      name: 'scheduler-fail',
      prompt: 'Refresh will fail',
      schedule: '0 10 * * *',
      enabled: true,
      recentActivityMinutes: 60
    });

    // Scheduler failure is non-fatal; the definition is persisted.
    expect(result).not.toMatchObject({ isError: true });
    const structured = result.structuredContent as { isNew: boolean };
    expect(structured.isNew).toBe(true);
  });

  it('does not call refresh when no scheduler is present', async () => {
    const store = new StubStore();
    // No scheduler provided.
    const app = makeAppContext(store, undefined);

    // Should not throw even without a scheduler.
    const result = await invokeRoutineCreate(app, {
      name: 'no-scheduler',
      prompt: 'No scheduler',
      schedule: '0 10 * * *',
      enabled: true,
      recentActivityMinutes: 60
    });

    expect(result).not.toMatchObject({ isError: true });
  });
});

describe('routine-create tool — store error handling', () => {
  it('returns an isError result when the store write fails', async () => {
    const store = new StubStore();
    store.writeError = new Error('disk full');
    const app = makeAppContext(store);

    const result = await invokeRoutineCreate(app, {
      name: 'will-fail',
      prompt: 'Test',
      schedule: '0 9 * * *',
      enabled: true,
      recentActivityMinutes: 60
    });

    expect(result).toMatchObject({ isError: true });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('routine-create failed');
    expect(content[0].text).toContain('disk full');
  });
});

describe('routine-create tool — schedule-aware recentActivityMinutes inference', () => {
  it('infers 1440 minutes for a daily schedule when recentActivityMinutes is omitted', async () => {
    // "0 9 * * *" = daily at 09:00 → 24 hours = 1440 minutes
    const store = new StubStore();
    const app = makeAppContext(store);

    const result = await invokeRoutineCreate(app, {
      name: 'daily-infer',
      prompt: 'Daily check',
      schedule: '0 9 * * *'
    });

    expect(result).not.toMatchObject({ isError: true });
    const structured = result.structuredContent as { routine: { recentActivityMinutes: number } };
    expect(structured.routine.recentActivityMinutes).toBe(1440);
  });

  it('infers 60 minutes for a sub-daily schedule when recentActivityMinutes is omitted', async () => {
    // "*/30 * * * *" = every 30 minutes → sub-daily fallback = 60 minutes
    const store = new StubStore();
    const app = makeAppContext(store);

    const result = await invokeRoutineCreate(app, {
      name: 'half-hourly-infer',
      prompt: 'Frequent check',
      schedule: '*/30 * * * *'
    });

    expect(result).not.toMatchObject({ isError: true });
    const structured = result.structuredContent as { routine: { recentActivityMinutes: number } };
    expect(structured.routine.recentActivityMinutes).toBe(60);
  });

  it('infers 10080 minutes for a weekly schedule when recentActivityMinutes is omitted', async () => {
    // "0 9 * * 1" = weekly on Monday at 09:00 → 7 days = 10080 minutes
    const store = new StubStore();
    const app = makeAppContext(store);

    const result = await invokeRoutineCreate(app, {
      name: 'weekly-infer',
      prompt: 'Weekly review',
      schedule: '0 9 * * 1'
    });

    expect(result).not.toMatchObject({ isError: true });
    const structured = result.structuredContent as { routine: { recentActivityMinutes: number } };
    expect(structured.routine.recentActivityMinutes).toBe(10080);
  });

  it('infers 43200 minutes for a monthly schedule when recentActivityMinutes is omitted', async () => {
    // "0 9 1 * *" = monthly on the 1st at 09:00 → 30 days = 43200 minutes
    const store = new StubStore();
    const app = makeAppContext(store);

    const result = await invokeRoutineCreate(app, {
      name: 'monthly-infer',
      prompt: 'Monthly report',
      schedule: '0 9 1 * *'
    });

    expect(result).not.toMatchObject({ isError: true });
    const structured = result.structuredContent as { routine: { recentActivityMinutes: number } };
    expect(structured.routine.recentActivityMinutes).toBe(43200);
  });

  it('uses explicit recentActivityMinutes when provided, overriding schedule inference', async () => {
    // Supply explicit 120; schedule would infer 1440 for "0 9 * * *".
    const store = new StubStore();
    const app = makeAppContext(store);

    const result = await invokeRoutineCreate(app, {
      name: 'explicit-override',
      prompt: 'Explicit window',
      schedule: '0 9 * * *',
      recentActivityMinutes: 120
    });

    expect(result).not.toMatchObject({ isError: true });
    const structured = result.structuredContent as { routine: { recentActivityMinutes: number } };
    expect(structured.routine.recentActivityMinutes).toBe(120);
  });
});
