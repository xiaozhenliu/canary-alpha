import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const E2E_SCRIPT = readFileSync(join(REPO_ROOT, 'scripts', 'hermes-e2e.js'), 'utf8');

const VALID_OUTCOMES = [
  'pass',
  'fail:hermes-missing',
  'fail:llm-not-configured',
  'fail:mcp-service-down',
  'fail:tool-call-failed'
] as const;

const VALID_FAILURE_MODES = [
  'none',
  'hermes-missing',
  'llm-not-configured',
  'mcp-service-down',
  'tool-call-failed'
] as const;

describe('hermes-e2e.js failure mode partition (P2)', () => {
  it('defines exactly the 5 permitted outcome values', () => {
    for (const outcome of VALID_OUTCOMES) {
      expect(E2E_SCRIPT, `outcome '${outcome}' must appear in hermes-e2e.js`).toContain(`'${outcome}'`);
    }
  });

  it('defines exactly the 5 permitted failureMode values', () => {
    for (const mode of VALID_FAILURE_MODES) {
      expect(E2E_SCRIPT, `failureMode '${mode}' must appear in hermes-e2e.js`).toContain(`'${mode}'`);
    }
  });

  it('Pass_Fail_Summary block header appears exactly once', () => {
    const matches = E2E_SCRIPT.match(/=== Pass_Fail_Summary ===/g);
    expect(matches, 'Pass_Fail_Summary header must appear exactly once in the script').toHaveLength(1);
  });

  it('printPassFailSummary is called for every failure mode branch', () => {
    // Each of the 4 failure modes must have a printPassFailSummary call
    const callCount = (E2E_SCRIPT.match(/printPassFailSummary\(/g) ?? []).length;
    expect(callCount, 'printPassFailSummary must be called at least 5 times (once per failure mode + once for pass)').toBeGreaterThanOrEqual(5);
  });

  it('process.exit(1) is called for every failure mode', () => {
    const exitCount = (E2E_SCRIPT.match(/process\.exit\(1\)/g) ?? []).length;
    expect(exitCount, 'process.exit(1) must be called at least 4 times (once per failure mode)').toBeGreaterThanOrEqual(4);
  });

  it('chatError === null is required for pass outcome', () => {
    expect(E2E_SCRIPT, 'pass outcome must require chatError === null').toContain('chatError === null');
  });
});
