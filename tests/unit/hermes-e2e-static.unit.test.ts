import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const E2E_SCRIPT = readFileSync(join(REPO_ROOT, 'scripts', 'hermes-e2e.js'), 'utf8');
const HERMES_DOC = readFileSync(join(REPO_ROOT, 'docs', 'clients', 'hermes.md'), 'utf8');

const FAILURE_MODES = [
  'hermes-missing',
  'llm-not-configured',
  'mcp-service-down',
  'tool-call-failed'
] as const;

describe('hermes-e2e.js static analysis', () => {
  // P4: No-stub invariant
  it('does not import from tests/helpers/', () => {
    expect(E2E_SCRIPT).not.toContain('tests/helpers/');
  });

  it('does not override HOME in env', () => {
    expect(E2E_SCRIPT).not.toMatch(/HOME\s*:/);
  });

  // P6: No LLM-provider credential leakage
  it('does not reference DEEPSEEK_API_KEY', () => {
    expect(E2E_SCRIPT).not.toContain('DEEPSEEK_API_KEY');
  });

  it('does not reference OPENAI_API_KEY', () => {
    expect(E2E_SCRIPT).not.toContain('OPENAI_API_KEY');
  });

  it('does not reference EVAL_JUDGE', () => {
    expect(E2E_SCRIPT).not.toContain('EVAL_JUDGE');
  });

  // P8: Distinct-error-vocabulary invariant
  for (const mode of FAILURE_MODES) {
    it(`failure mode label '${mode}' appears in hermes-e2e.js`, () => {
      expect(E2E_SCRIPT, `Missing failure mode label '${mode}' in hermes-e2e.js`).toContain(mode);
    });

    it(`failure mode label '${mode}' appears in docs/clients/hermes.md`, () => {
      expect(HERMES_DOC, `Missing failure mode label '${mode}' in docs/clients/hermes.md`).toContain(mode);
    });
  }
});
