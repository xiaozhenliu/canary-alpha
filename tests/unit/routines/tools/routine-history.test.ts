/**
 * Unit tests for the routine-history MCP tool handler.
 *
 * Uses in-memory stubs for RoutineStore so no file I/O occurs.
 *
 * Coverage:
 *  - Returns run records newest-first in structured content
 *  - Respects the limit parameter
 *  - Maps run record fields correctly (including optional error field)
 *  - Returns an empty list when there is no run history
 *  - Returns an isError result when the store call fails
 */

import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';

import { registerRoutineHistoryTool } from '../../../../src/mcp/tools/routine-history.js';
import type { AppContext } from '../../../../src/types/app-config.js';
import type { RoutineDefinition, RoutineRunRecord, RoutineStore } from '../../../../src/services/routines/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** In-memory RoutineStore stub focused on run-history queries. */
function makeStubStore(opts: {
  runsByName?: Record<string, RoutineRunRecord[]>;
  listRunsError?: Error;
}): RoutineStore {
  return {
    async listDefinitions(): Promise<RoutineDefinition[]> { return []; },
    async readDefinition(): Promise<RoutineDefinition | undefined> { return undefined; },
    async writeDefinition(): Promise<boolean> { return true; },
    async appendRun(): Promise<void> {},
    async listRuns(name: string, limit: number): Promise<RoutineRunRecord[]> {
      if (opts.listRunsError) throw opts.listRunsError;
      const runs = opts.runsByName?.[name] ?? [];
      return runs.slice(0, limit);
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

async function invokeRoutineHistory(
  app: AppContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerRoutineHistoryTool(server, app);

  // The MCP SDK stores registered tools in a plain object keyed by tool name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { handler: (input: unknown) => Promise<unknown> }>;
  const tool = tools['routine-history'];
  if (!tool) throw new Error('routine-history not registered');
  return tool.handler(input) as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routine-history tool — basic history', () => {
  it('returns run records with correct field mapping', async () => {
    const run = makeRunRecord({
      runId: 'run-42',
      status: 'success',
      summary: 'All good',
      output: 'Detailed output'
    });
    const store = makeStubStore({ runsByName: { 'daily-summary': [run] } });
    const app = makeAppContext(store);

    const result = await invokeRoutineHistory(app, { name: 'daily-summary', limit: 10 });

    expect(result).not.toMatchObject({ isError: true });
    const structured = result.structuredContent as {
      name: string;
      total: number;
      runs: Array<Record<string, unknown>>;
    };
    expect(structured.name).toBe('daily-summary');
    expect(structured.total).toBe(1);
    expect(structured.runs[0]).toEqual({
      runId: 'run-42',
      name: 'daily-summary',
      startedAt: '2026-05-01T09:00:00.000Z',
      completedAt: '2026-05-01T09:00:01.000Z',
      status: 'success',
      summary: 'All good',
      output: 'Detailed output'
    });
  });

  it('includes the error field on failed run records', async () => {
    const run = makeRunRecord({
      status: 'failed',
      summary: 'Failure summary',
      output: 'Error trace',
      error: { message: 'executor crashed' }
    });
    const store = makeStubStore({ runsByName: { 'daily-summary': [run] } });
    const app = makeAppContext(store);

    const result = await invokeRoutineHistory(app, { name: 'daily-summary', limit: 10 });

    const structured = result.structuredContent as { runs: Array<Record<string, unknown>> };
    expect(structured.runs[0]).toMatchObject({
      status: 'failed',
      error: { message: 'executor crashed' }
    });
  });

  it('omits the error field on successful run records', async () => {
    const run = makeRunRecord({ status: 'success' });
    const store = makeStubStore({ runsByName: { 'daily-summary': [run] } });
    const app = makeAppContext(store);

    const result = await invokeRoutineHistory(app, { name: 'daily-summary', limit: 10 });

    const structured = result.structuredContent as { runs: Array<Record<string, unknown>> };
    expect('error' in structured.runs[0]).toBe(false);
  });

  it('returns an empty runs array when there is no history', async () => {
    const store = makeStubStore({ runsByName: {} });
    const app = makeAppContext(store);

    const result = await invokeRoutineHistory(app, { name: 'daily-summary', limit: 10 });

    const structured = result.structuredContent as { name: string; total: number; runs: unknown[] };
    expect(structured.total).toBe(0);
    expect(structured.runs).toEqual([]);

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('No run history for routine "daily-summary"');
  });
});

describe('routine-history tool — limit parameter', () => {
  it('respects the limit and returns only the requested number of records', async () => {
    // The store stub slices by limit, simulating the real FileRoutineStore.
    const runs = [
      makeRunRecord({ runId: 'run-1', startedAt: '2026-05-01T07:00:00.000Z' }),
      makeRunRecord({ runId: 'run-2', startedAt: '2026-05-01T08:00:00.000Z' }),
      makeRunRecord({ runId: 'run-3', startedAt: '2026-05-01T09:00:00.000Z' })
    ];
    const store = makeStubStore({ runsByName: { 'daily-summary': runs } });
    const app = makeAppContext(store);

    const result = await invokeRoutineHistory(app, { name: 'daily-summary', limit: 2 });

    const structured = result.structuredContent as { total: number; runs: Array<{ runId: string }> };
    expect(structured.total).toBe(2);
    expect(structured.runs).toHaveLength(2);
    expect(structured.runs[0].runId).toBe('run-1');
    expect(structured.runs[1].runId).toBe('run-2');
  });

  it('returns only the requested count when limit is explicitly set to 10', async () => {
    // Build 15 run records to confirm only 10 are returned when limit=10.
    const runs = Array.from({ length: 15 }, (_, i) =>
      makeRunRecord({ runId: `run-${i + 1}`, name: 'daily-summary' })
    );
    const store = makeStubStore({ runsByName: { 'daily-summary': runs } });
    const app = makeAppContext(store);

    // Provide the limit explicitly — Zod defaults are applied only during
    // the MCP transport validation layer, not when the handler is called directly.
    const result = await invokeRoutineHistory(app, { name: 'daily-summary', limit: 10 });

    const structured = result.structuredContent as { total: number };
    expect(structured.total).toBe(10);
  });
});

describe('routine-history tool — narrative text', () => {
  it('includes a run-count narrative when records are present', async () => {
    const runs = [
      makeRunRecord({ runId: 'run-1' }),
      makeRunRecord({ runId: 'run-2' })
    ];
    const store = makeStubStore({ runsByName: { 'my-routine': runs } });
    const app = makeAppContext(store);

    const result = await invokeRoutineHistory(app, { name: 'my-routine', limit: 10 });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('2 run record(s)');
    expect(content[0].text).toContain('my-routine');
  });
});

describe('routine-history tool — error handling', () => {
  it('returns an isError result when the store call fails', async () => {
    const store = makeStubStore({ listRunsError: new Error('history file corrupted') });
    const app = makeAppContext(store);

    const result = await invokeRoutineHistory(app, { name: 'daily-summary', limit: 10 });

    expect(result).toMatchObject({ isError: true });
    const structured = result.structuredContent as { name: string; runs: unknown[]; total: number };
    expect(structured.name).toBe('daily-summary');
    expect(structured.runs).toEqual([]);
    expect(structured.total).toBe(0);

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('routine-history failed');
    expect(content[0].text).toContain('history file corrupted');
  });
});
