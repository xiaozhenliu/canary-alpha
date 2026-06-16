/**
 * RoutineExecutor — interface definitions for routine execution.
 *
 * Each executor receives a RoutineDefinition and produces a structured result
 * containing a short human-readable summary and a longer output body.
 */

import type { RoutineDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RoutineExecutionResult {
  summary: string;
  output: string;
}

export interface RoutineExecutor {
  execute(definition: RoutineDefinition): Promise<RoutineExecutionResult>;
}
