# Develop Log

## 2026-05-28: Hermes-side tool-name alignment (`hermes-tool-name-alignment-fix`)

**变更**: Realigned the Hermes-facing layer with the registered MCP tool surface; replaced retired `search-screen` / `recent-activity` references with `find` / `recall`.

**方案**:
- Introduced `scripts/hermes-tool-includes.js` as the single source of truth for the two Hermes-side `tools.include` arrays (`PHASE4_TOOL_INCLUDES`, `V1_EVALS_TOOL_INCLUDES`). Both `scripts/hermes-phase4-smoke.js` and `scripts/hermes-v1-evals.js` import from it.
- Added `tests/contract/hermes-tools-include.contract.test.ts` as the deterministic drift gate. It asserts both shared arrays and every `V1_EVALUATION_TASKS[*].requiredToolMarkers` entry recovers to a name in `TOOL_MANIFEST` after stripping the Hermes marker prefix.
- Forward-replaced four `V1_EVALUATION_TASKS` entries (`status-and-recent-activity`, `retrieval-summary`, `find-then-refine`, `failure-recovery`) — `query` and `requiredToolMarkers` only; every other field preserved. `memory-roundtrip` is byte-identical.
- Updated `docs/clients/generic-mcp.md` checklist + Retrieval smoke test examples; bumped `doc_version: 2 → 3` per `CLAUDE.md` Governed Documents (independent of `package.json` version per `version.md`).

**决策理由**:
- A new helper module (rather than re-exporting from each smoke script) avoids the top-level `await main()` side effect both scripts have, so the contract test can import plain JS arrays without auto-running a smoke or eval pass.
- Added a sibling `scripts/hermes-tool-includes.d.ts` (5-line `readonly string[]` declarations). Matches the repo convention used by every other imported `scripts/*.js` helper (`onboard.d.ts`, `onboarding-config.d.ts`, etc.) and keeps `npm run typecheck` byte-identical to the pre-fix baseline.
- No `package.json` version bump: `version.md` scopes the software version to runtime-exposed identifiers (MCP server self-report, HTTP, CLI `--version`); none of those changed because `src/` was untouched.

**影响范围**:
- New: `scripts/hermes-tool-includes.js`, `scripts/hermes-tool-includes.d.ts`, `tests/contract/hermes-tools-include.contract.test.ts`
- Modified: `scripts/hermes-phase4-smoke.js`, `scripts/hermes-v1-evals.js`, `tests/evaluations/v1-evaluation-manifest.ts`, `docs/clients/generic-mcp.md`, `CHANGELOG.md`
- Untouched (preservation): `src/**`, `scripts/onboard.js`, `scripts/onboarding-config.js`, `docs/delivery/hermes.md`, `docs/documentation/mcp-tools.md`, `package.json`, `package-lock.json`, and the `memory-roundtrip` task in `V1_EVALUATION_TASKS`

**Follow-on (out of scope, tracked by later specs)**:
- `requiredTranscriptTokens` in the v1 evals manifest still reference screenpipe `record.id` values that are not surfaced through `find` / `recall` structured content. Resolving this requires either exposing a stable `frameId` on fixtures and asserting on those, or rewriting the v1 evals harness to introspect structured content rather than rely on transcript-substring tokens.
- Fixture-clock injection so `recall` time windows in the v1 prompts can deterministically intersect `FIXTURE_NOW = 2026-04-13T12:00:00.000Z` during a real Hermes + LLM run.
