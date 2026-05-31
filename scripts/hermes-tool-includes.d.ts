// Type declarations for scripts/hermes-tool-includes.js.
//
// The runtime helper is plain JS (frozen string arrays) so the two
// Hermes-side scripts can `import` it without pulling in tsx, but the
// contract test in tests/contract/hermes-tools-include.contract.test.ts
// is TypeScript and needs typings to keep `npm run typecheck` clean.
//
// Both arrays are produced via `Object.freeze([...])` at runtime, so the
// closest faithful type is `readonly string[]`.

export const PHASE4_TOOL_INCLUDES: readonly string[];
export const V1_EVALS_TOOL_INCLUDES: readonly string[];
export const ONBOARDING_TOOL_INCLUDES: readonly string[];
