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

## 2026-05-28: Hermes v1 evals token & time-window anchoring (`hermes-v1-evals-token-anchoring-fix`)

**变更**: Anchored the v1 evaluation harness to the registered tool surface so a real Hermes + real DeepSeek LLM run can satisfy `requiredTranscriptTokens` and recall-window prompts.

**方案**:
- Added stable `frameId` numerics (9101..9104) to the four v1-evals fixture records and swapped `requiredTranscriptTokens` for the four affected tasks (`status-and-recent-activity`, `retrieval-summary`, `find-then-refine`, `failure-recovery`) from screenpipe `record.id` strings (`eval-*-N`) to those `frameId` substrings, since `find`'s `evidenceItemSchema` exposes `frameId` and `recall`'s `sessionItemSchema` exposes `evidenceFrameIds` (neither exposes `record.id`).
- Replaced relative-window phrasing ("last 10/60 minutes") in the two recall-using prompts with explicit ISO `from` / `to` anchored at `FIXTURE_NOW = 2026-04-13T12:00:00.000Z`, so a real Hermes + LLM run's recall window deterministically intersects the fixtures regardless of wall-clock now.
- Extracted `FIXTURE_NOW_ISO` / `FIXTURE_NOW` / `minusFixtureMinutesIso` into a new sibling helper `scripts/hermes-v1-fixture-clock.js` (+ `.d.ts`); extracted the canonical fixture record set into `scripts/hermes-v1-fixture-records.js` (+ `.d.ts`). The v1-evals smoke script and the contract test both import from these helpers.
- Extended `tests/contract/hermes-tools-include.contract.test.ts` with two new assertions: assertion #5 fails when any `requiredTranscriptTokens` fixture-id-shaped token (regex `^(?:eval-[a-z0-9-]+|9\d{3})$`) does not map to a real `V1_EVALS_FIXTURE_RECORDS` entry; assertion #6 fails when either of the two recall-using affected tasks lacks explicit ISO `from`/`to` anchored at `FIXTURE_NOW`.

**决策理由**:
- Path A (fixture frameId + ISO anchoring) over Path B (rewrite v1-evals harness to do structured-content introspection). Path A is a localized data edit; Path B requires a transcript-substring → structured-content shift across the whole harness. The user explicitly chose A; B is tracked for a separate later spec.
- Two helper files instead of one: `hermes-v1-fixture-clock.js` is consumed by both `hermes-v1-fixture-records.js` (for `timestamp`) and `scripts/hermes-v1-evals.js` (for `SUMMARY.json`'s `fixtureNow`), so co-locating it with the records would create a circular import. Keeping the clock anchor in a tiny helper of its own avoids that and matches the prior fix's pattern of one helper per concern (`hermes-tool-includes.js` + this fix's pair).
- Drop the local `function minusFixtureMinutes` from `scripts/hermes-v1-evals.js` and switch its remaining call site (the retrieval-checkpoint timestamp at `setupControlledEnvironment`) to the imported `minusFixtureMinutesIso`. Both helpers return byte-identical ISO strings for the same minute offset, so the checkpoint is byte-identical to pre-fix.
- No `package.json` version bump: per `version.md`, runtime-exposed identifiers (MCP server self-report, HTTP, CLI `--version`) are unchanged. No governed-doc `doc_version` bump either.

**影响范围**:
- New: `scripts/hermes-v1-fixture-clock.js`, `scripts/hermes-v1-fixture-clock.d.ts`, `scripts/hermes-v1-fixture-records.js`, `scripts/hermes-v1-fixture-records.d.ts`
- Modified: `scripts/hermes-v1-evals.js`, `tests/contract/hermes-tools-include.contract.test.ts`, `tests/evaluations/v1-evaluation-manifest.ts`, `CHANGELOG.md`, `docs/develop_log.md`
- Untouched (preservation): `src/**`, `scripts/hermes-phase4-smoke.js`, `scripts/hermes-tool-includes.{js,d.ts}`, `scripts/onboard.js`, `scripts/onboarding-config.js`, `tests/helpers/screenpipe-stub.ts`, `src/services/retrieval/screenpipe-client.ts`, `package.json`, `package-lock.json`, and the `memory-roundtrip` task in `V1_EVALUATION_TASKS`.

**Follow-on (out of scope, tracked by later specs)**:
- Path B: rewrite v1-evals harness to introspect `find` / `recall` structured content directly instead of asserting on transcript substrings. Would let the manifest stop carrying frameId numerics that have to stay in sync with fixture records.
- Hermes CLI installation/detection, Hermes provider/credential changes, Hermes wiring into CI (carry-forward from `hermes-tool-name-alignment-fix`).
- 7 pre-existing typecheck errors documented in `.kiro/specs/hermes-tool-name-alignment-fix/baseline-task-2.md`.
