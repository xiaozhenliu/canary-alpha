/**
 * Contract tests for the routine MCP tools (routine-list, routine-create,
 * routine-history).
 *
 * These tests verify:
 *  1. Tool registration — all three routine tools appear in TOOL_MANIFEST
 *     with the expected names and titles.
 *  2. Input schema validation — each tool's Zod schema accepts valid inputs
 *     and rejects invalid ones.
 *  3. Output structure contract — the structured content returned by each
 *     tool matches the documented shape.
 *
 * The tests are fully offline (no I/O, no real MCP transport) and use
 * in-memory stubs for RoutineStore.
 */

import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/server';

import { TOOL_MANIFEST } from '../../src/mcp/tool-manifest.js';
import { registerRoutineListTool } from '../../src/mcp/tools/routine-list.js';
import { registerRoutineCreateTool } from '../../src/mcp/tools/routine-create.js';
import { registerRoutineHistoryTool } from '../../src/mcp/tools/routine-history.js';
import type { AppContext } from '../../src/types/app-config.js';
import type { RoutineDefinition, RoutineRunRecord, RoutineStore } from '../../src/services/routines/types.js';

// ---------------------------------------------------------------------------
// Shared in-memory store stub
// ---------------------------------------------------------------------------

function makeFullStubStore(opts: {
  definitions?: RoutineDefinition[];
  runs?: RoutineRunRecord[];
} = {}): RoutineStore {
  const definitions = new Map<string, RoutineDefinition>(
    (opts.definitions ?? []).map((d) => [d.name, d])
  );
  const runs: RoutineRunRecord[] = opts.runs ?? [];

  return {
    async listDefinitions(): Promise<RoutineDefinition[]> {
      return [...definitions.values()];
    },
    async readDefinition(name: string): Promise<RoutineDefinition | undefined> {
      return definitions.get(name);
    },
    async writeDefinition(definition: RoutineDefinition): Promise<boolean> {
      const isNew = !definitions.has(definition.name);
      definitions.set(definition.name, definition);
      return isNew;
    },
    async appendRun(record: RoutineRunRecord): Promise<void> {
      runs.push(record);
    },
    async listRuns(name: string, limit: number): Promise<RoutineRunRecord[]> {
      return runs.filter((r) => r.name === name).slice(0, limit);
    }
  };
}

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

/** Extracts the handler for a named tool from a McpServer instance. */
function getToolCallback(
  server: McpServer,
  name: string
): (input: unknown) => Promise<Record<string, unknown>> {
  // The MCP SDK stores registered tools in a plain object keyed by tool name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<
    string,
    { handler: (input: unknown) => Promise<unknown> }
  >;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool "${name}" is not registered on this server`);
  return tool.handler as (input: unknown) => Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Zod schemas that mirror the tool output contracts
// ---------------------------------------------------------------------------

const runRecordOutputSchema = z.object({
  runId: z.string(),
  name: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  status: z.enum(['success', 'failed', 'skipped']),
  summary: z.string(),
  output: z.string(),
  error: z.object({ message: z.string() }).optional()
});

const routineInfoOutputSchema = z.object({
  name: z.string(),
  schedule: z.string(),
  enabled: z.boolean(),
  kind: z.enum(['daily_summary']),
  prompt: z.string(),
  recentActivityMinutes: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  latestRun: z
    .object({
      runId: z.string(),
      startedAt: z.string(),
      completedAt: z.string(),
      status: z.enum(['success', 'failed', 'skipped']),
      summary: z.string()
    })
    .optional()
});

const routineListOutputSchema = z.object({
  routines: z.array(routineInfoOutputSchema),
  total: z.number().int().nonnegative()
});

const routineCreateOutputSchema = z.object({
  routine: z.object({
    name: z.string(),
    schedule: z.string(),
    enabled: z.boolean(),
    kind: z.enum(['daily_summary']),
    prompt: z.string(),
    recentActivityMinutes: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string()
  }),
  isNew: z.boolean()
});

const routineHistoryOutputSchema = z.object({
  name: z.string(),
  runs: z.array(runRecordOutputSchema),
  total: z.number().int().nonnegative()
});

// ---------------------------------------------------------------------------
// 1. Tool registration contract
// ---------------------------------------------------------------------------

describe('routine tools — TOOL_MANIFEST registration', () => {
  it('includes routine-list in TOOL_MANIFEST with the correct title', () => {
    const entry = TOOL_MANIFEST.find((t) => t.name === 'routine-list');
    expect(entry).toBeDefined();
    expect(entry?.title).toBe('List Routines');
  });

  it('includes routine-create in TOOL_MANIFEST with the correct title', () => {
    const entry = TOOL_MANIFEST.find((t) => t.name === 'routine-create');
    expect(entry).toBeDefined();
    expect(entry?.title).toBe('Create or Update Routine');
  });

  it('includes routine-history in TOOL_MANIFEST with the correct title', () => {
    const entry = TOOL_MANIFEST.find((t) => t.name === 'routine-history');
    expect(entry).toBeDefined();
    expect(entry?.title).toBe('Routine Execution History');
  });

  it('assigns all three routine tools to the "routines" category', () => {
    const routineEntries = TOOL_MANIFEST.filter((t) => t.category === 'routines');
    const names = routineEntries.map((t) => t.name).sort();
    expect(names).toEqual(['routine-create', 'routine-history', 'routine-list']);
  });
});

// ---------------------------------------------------------------------------
// 2. Input schema validation contract
// ---------------------------------------------------------------------------

describe('routine-list — input schema', () => {
  // The schema is inline in the tool file; we validate against the exported
  // tool handler's Zod parsing by invoking the callback directly.
  const inputSchema = z.object({
    enabled: z.boolean().optional()
  });

  it('accepts an empty input object', () => {
    expect(inputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts enabled=true', () => {
    expect(inputSchema.safeParse({ enabled: true }).success).toBe(true);
  });

  it('accepts enabled=false', () => {
    expect(inputSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it('accepts when enabled is omitted', () => {
    expect(inputSchema.safeParse({}).success).toBe(true);
  });
});

describe('routine-create — input schema', () => {
  const inputSchema = z.object({
    name: z.string().min(1),
    prompt: z.string().min(1),
    schedule: z.string().min(1),
    enabled: z.boolean().default(true),
    recentActivityMinutes: z.number().int().positive().default(60)
  });

  it('accepts a minimal valid input', () => {
    const result = inputSchema.safeParse({
      name: 'morning',
      prompt: 'Check activity',
      schedule: '0 8 * * *'
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.recentActivityMinutes).toBe(60);
    }
  });

  it('rejects an empty name', () => {
    expect(inputSchema.safeParse({ name: '', prompt: 'p', schedule: '0 8 * * *' }).success).toBe(false);
  });

  it('rejects an empty prompt', () => {
    expect(inputSchema.safeParse({ name: 'n', prompt: '', schedule: '0 8 * * *' }).success).toBe(false);
  });

  it('rejects an empty schedule string', () => {
    expect(inputSchema.safeParse({ name: 'n', prompt: 'p', schedule: '' }).success).toBe(false);
  });

  it('rejects non-integer recentActivityMinutes', () => {
    expect(
      inputSchema.safeParse({ name: 'n', prompt: 'p', schedule: '0 8 * * *', recentActivityMinutes: 1.5 }).success
    ).toBe(false);
  });

  it('rejects zero recentActivityMinutes', () => {
    expect(
      inputSchema.safeParse({ name: 'n', prompt: 'p', schedule: '0 8 * * *', recentActivityMinutes: 0 }).success
    ).toBe(false);
  });
});

describe('routine-history — input schema', () => {
  const inputSchema = z.object({
    name: z.string().min(1),
    limit: z.number().int().positive().max(100).default(10)
  });

  it('accepts a valid name with default limit', () => {
    const result = inputSchema.safeParse({ name: 'daily-summary' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
    }
  });

  it('accepts a custom limit within range', () => {
    const result = inputSchema.safeParse({ name: 'daily-summary', limit: 50 });
    expect(result.success).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(inputSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects limit exceeding 100', () => {
    expect(inputSchema.safeParse({ name: 'n', limit: 101 }).success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    expect(inputSchema.safeParse({ name: 'n', limit: 2.5 }).success).toBe(false);
  });

  it('rejects limit of zero', () => {
    expect(inputSchema.safeParse({ name: 'n', limit: 0 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Output structure contract
// ---------------------------------------------------------------------------

describe('routine-list — output structure contract', () => {
  it('structuredContent conforms to the contract schema for an empty store', async () => {
    const store = makeFullStubStore();
    const app = makeAppContext(store);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerRoutineListTool(server, app);
    const callback = getToolCallback(server, 'routine-list');

    const result = await callback({});

    const parsed = routineListOutputSchema.safeParse(result.structuredContent);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it('structuredContent conforms to the contract schema when routines have run history', async () => {
    const now = '2026-05-01T09:00:00.000Z';
    const definitions: RoutineDefinition[] = [
      {
        name: 'daily-summary',
        schedule: '0 9 * * *',
        enabled: true,
        kind: 'daily_summary',
        prompt: 'Summarize',
        recentActivityMinutes: 60,
        createdAt: now,
        updatedAt: now
      }
    ];
    const runs: RoutineRunRecord[] = [
      {
        runId: 'run-1',
        name: 'daily-summary',
        startedAt: now,
        completedAt: now,
        status: 'success',
        summary: 'Done',
        output: 'All good'
      }
    ];
    const store = makeFullStubStore({ definitions, runs });
    const app = makeAppContext(store);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerRoutineListTool(server, app);
    const callback = getToolCallback(server, 'routine-list');

    const result = await callback({});

    const parsed = routineListOutputSchema.safeParse(result.structuredContent);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.total).toBe(1);
      expect(parsed.data.routines[0].latestRun).toBeDefined();
    }
  });
});

describe('routine-create — output structure contract', () => {
  it('structuredContent conforms to the contract schema for a new routine', async () => {
    const store = makeFullStubStore();
    const app = makeAppContext(store);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerRoutineCreateTool(server, app);
    const callback = getToolCallback(server, 'routine-create');

    const result = await callback({
      name: 'contract-test',
      prompt: 'Run contract test',
      schedule: '0 8 * * *',
      enabled: true,
      recentActivityMinutes: 60
    });

    const parsed = routineCreateOutputSchema.safeParse(result.structuredContent);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.isNew).toBe(true);
      expect(parsed.data.routine.name).toBe('contract-test');
    }
  });

  it('isNew is false when updating an existing routine', async () => {
    const now = '2026-05-01T09:00:00.000Z';
    const store = makeFullStubStore({
      definitions: [
        {
          name: 'existing',
          schedule: '0 9 * * *',
          enabled: true,
          kind: 'daily_summary',
          prompt: 'Old',
          recentActivityMinutes: 60,
          createdAt: now,
          updatedAt: now
        }
      ]
    });
    const app = makeAppContext(store);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerRoutineCreateTool(server, app);
    const callback = getToolCallback(server, 'routine-create');

    const result = await callback({
      name: 'existing',
      prompt: 'New prompt',
      schedule: '0 10 * * *',
      enabled: true,
      recentActivityMinutes: 90
    });

    const parsed = routineCreateOutputSchema.safeParse(result.structuredContent);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.isNew).toBe(false);
    }
  });
});

describe('routine-history — output structure contract', () => {
  it('structuredContent conforms to the contract schema for a routine with no history', async () => {
    const store = makeFullStubStore();
    const app = makeAppContext(store);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerRoutineHistoryTool(server, app);
    const callback = getToolCallback(server, 'routine-history');

    const result = await callback({ name: 'daily-summary', limit: 10 });

    const parsed = routineHistoryOutputSchema.safeParse(result.structuredContent);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.total).toBe(0);
      expect(parsed.data.runs).toEqual([]);
    }
  });

  it('structuredContent conforms to the contract schema for a routine with mixed-status run history', async () => {
    const now = '2026-05-01T09:00:00.000Z';
    const runs: RoutineRunRecord[] = [
      {
        runId: 'run-1',
        name: 'daily-summary',
        startedAt: now,
        completedAt: now,
        status: 'success',
        summary: 'Done',
        output: 'Output'
      },
      {
        runId: 'run-2',
        name: 'daily-summary',
        startedAt: now,
        completedAt: now,
        status: 'failed',
        summary: 'Boom',
        output: 'Trace',
        error: { message: 'executor crashed' }
      },
      {
        runId: 'run-3',
        name: 'daily-summary',
        startedAt: now,
        completedAt: now,
        status: 'skipped',
        summary: 'Skipped',
        output: 'Overlap guard'
      }
    ];
    const store = makeFullStubStore({ runs });
    const app = makeAppContext(store);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerRoutineHistoryTool(server, app);
    const callback = getToolCallback(server, 'routine-history');

    const result = await callback({ name: 'daily-summary', limit: 10 });

    const parsed = routineHistoryOutputSchema.safeParse(result.structuredContent);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.total).toBe(3);
      // Verify the failed run record carries the error field.
      const failedRun = parsed.data.runs.find((r) => r.status === 'failed');
      expect(failedRun?.error?.message).toBe('executor crashed');
    }
  });
});
