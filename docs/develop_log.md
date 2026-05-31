# Develop Log

## 2026-07-15: hermes-real-end-to-end-integration

**Change**: Delivered real end-to-end Hermes integration path (Spec 2 of 3).
**Approach**: Added shared `hermes-detector.js` module; new `hermes:verify` script runs real Hermes chat against live `~/.hermes/config.yaml` with no stubs; new `docs/clients/hermes.md` walkthrough; fixed `DEFAULT_HERMES_TOOL_INCLUDE` stale names in `onboarding-config.js`; added Hermes detection to `setup` and `onboard`.
**Decision**: Onboard "Next commands" hint updated to include `npm run hermes:verify` as step 5 — it is the canonical post-onboarding smoke gate and not surfacing it would force users to read docs to find it.
**Affected files**: `scripts/hermes-detector.js` (new), `scripts/hermes-e2e.js` (new), `docs/clients/hermes.md` (new), `docs/develop_log.md` (new), `scripts/onboarding-config.js`, `scripts/setup.js`, `scripts/onboard.js`, `scripts/hermes-phase4-smoke.js`, `scripts/hermes-v1-evals.js`, `scripts/hermes-tool-includes.js`, `package.json`, `CHANGELOG.md`, `docs/documentation/governed-documents.md`, `README.md`, `tests/contract/hermes-tools-include.contract.test.ts`.
