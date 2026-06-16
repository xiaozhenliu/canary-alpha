/**
 * Tests for the RoutineExecutor and RoutineExecutionResult interfaces.
 *
 * DailySummaryExecutor has been removed as part of the Routines v2 refactor.
 * These tests verify the interface contract only.
 */

import { describe, expect, it } from 'vitest';

import type { RoutineExecutionResult, RoutineExecutor } from '../../../src/services/routines/executor.js';
import type { RoutineDefinition } from '../../../src/services/routines/types.js';

// ---------------------------------------------------------------------------
// Interface contract tests
// ---------------------------------------------------------------------------

describe('RoutineExecutor interface', () => {
  it('can be implemented by an inline object', async () => {
    const now = new Date().toISOString();
    const definition: RoutineDefinition = {
      name: 'test-routine',
      schedule: '0 9 * * *',
      enabled: true,
      prompt: 'Summarize the day',
      recentActivityMinutes: 60,
      createdAt: now,
      updatedAt: now
    };

    const executor: RoutineExecutor = {
      execute: async (def): Promise<RoutineExecutionResult> => ({
        summary: `Ran ${def.name}`,
        output: 'Output text'
      })
    };

    const result = await executor.execute(definition);

    expect(result.summary).toBe('Ran test-routine');
    expect(result.output).toBe('Output text');
  });
});
