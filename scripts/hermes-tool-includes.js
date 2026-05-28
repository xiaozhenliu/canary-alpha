// Single source of truth for Hermes-side tools.include arrays.
// Every entry MUST appear in TOOL_MANIFEST (src/mcp/tool-manifest.ts).
// Drift is enforced by tests/contract/hermes-tools-include.contract.test.ts.

export const PHASE4_TOOL_INCLUDES = Object.freeze([
  'internal-status',
  'recall'
]);

export const V1_EVALS_TOOL_INCLUDES = Object.freeze([
  'internal-status',
  'find',
  'recall',
  'memory-read',
  'memory-write'
]);
