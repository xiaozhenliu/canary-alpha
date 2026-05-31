// Type declarations for scripts/hermes-v1-fixture-records.js.
// Mirrors the runtime shape: a frozen array of records each with the
// five fields below. Used by the contract test to assert tokens map to
// real fixture records.

export interface V1EvalsFixtureRecord {
  readonly id: string;
  readonly frameId: number;
  readonly text: string;
  readonly timestamp: string;
  readonly appName: string;
}
export const V1_EVALS_FIXTURE_RECORDS: readonly V1EvalsFixtureRecord[];
