// Single source of truth for the v1-evals fixture clock anchor.
// Used by scripts/hermes-v1-evals.js (fixture timestamps),
// scripts/hermes-v1-fixture-records.js (fixture timestamps), and the
// drift-gate contract test (canonical fixture id ↔ frameId set).

export const FIXTURE_NOW_ISO = '2026-04-13T12:00:00.000Z';

// Expose a frozen Date for callers that need a Date object (e.g.
// scripts/hermes-v1-evals.js's SUMMARY.json fixtureNow field).
// The object itself is frozen so external mutation cannot affect
// minusFixtureMinutesIso's output.
export const FIXTURE_NOW = Object.freeze(new Date(FIXTURE_NOW_ISO));

// Derive from the ISO string (not from the exported Date object) so
// that even if a caller somehow bypasses the freeze, this function
// always returns a value anchored to the canonical ISO literal.
const FIXTURE_NOW_EPOCH = new Date(FIXTURE_NOW_ISO).getTime();

export function minusFixtureMinutesIso(minutes) {
  return new Date(FIXTURE_NOW_EPOCH - minutes * 60_000).toISOString();
}
