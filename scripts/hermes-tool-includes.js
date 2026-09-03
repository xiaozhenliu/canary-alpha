/**
 * Onboarding tool whitelist — controls which MCP tools are exposed to
 * Hermes by default after `npm run onboard`.
 *
 * Excluded tools and rationale:
 *   - screenpipe-control: Allows agent to start/stop the screen-capture
 *                         daemon — high operational risk.
 *   - routine-create:     Allows agent to create or modify cron-scheduled
 *                         background tasks — should be operator-initiated.
 *
 * Operators can add excluded tools to ~/.hermes/config.yaml manually.
 * `npm run refresh:hermes` syncs this list to the Hermes config.
 */
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

// Full onboarding tool set written to ~/.hermes/config.yaml by npm run onboard.
export const ONBOARDING_TOOL_INCLUDES = Object.freeze([
  'internal-status',
  'find',
  'recall',
  'inspect',
  'memory-read',
  'memory-write',
  'file-analyze',
  'privacy-control',
  'routine-list',
  'routine-history'
]);
