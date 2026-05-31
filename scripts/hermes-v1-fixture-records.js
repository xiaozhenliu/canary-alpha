// Single source of truth for the v1-evals fixture record set.
// Every record's `frameId` MUST be referenced by at most one
// `requiredTranscriptTokens` token in
// tests/evaluations/v1-evaluation-manifest.ts; drift is enforced by
// tests/contract/hermes-tools-include.contract.test.ts.

import { minusFixtureMinutesIso } from './hermes-v1-fixture-clock.js';

export const V1_EVALS_FIXTURE_RECORDS = Object.freeze([
  Object.freeze({
    id: 'eval-recent-1',
    frameId: 9101,
    text: 'Recent activity fixture for evaluation status checks',
    timestamp: minusFixtureMinutesIso(1),
    appName: 'Claude'
  }),
  Object.freeze({
    id: 'eval-search-1',
    frameId: 9102,
    text: 'Budget planning evaluation note for retrieval summary coverage',
    timestamp: minusFixtureMinutesIso(15),
    appName: 'Finance'
  }),
  Object.freeze({
    id: 'eval-refine-1',
    frameId: 9103,
    text: 'Action item evaluation note that survives refinement',
    timestamp: minusFixtureMinutesIso(20),
    appName: 'Meetings'
  }),
  Object.freeze({
    id: 'eval-fallback-1',
    frameId: 9104,
    text: 'Fallback failure evaluation keyword record for degraded recovery coverage',
    timestamp: minusFixtureMinutesIso(90),
    appName: 'Claude'
  })
]);
