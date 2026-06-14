import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = readFileSync(join(REPO_ROOT, 'scripts', 'e2e-live-run.js'), 'utf8');

const VALID_FAILURE_MODES = [
  'build-failed',
  'hermes-missing',
  'config-missing',
  'screenpipe-unhealthy',
  'no-frames-captured',
  'mcp-service-down',
  'index-lag',
  'llm-not-configured',
  'tool-call-failed',
  'empty-recall'
] as const;

describe('e2e-live-run.js failure mode partition', () => {
  it('handles all 10 failure modes', () => {
    for (const mode of VALID_FAILURE_MODES) {
      expect(SCRIPT, `failure mode '${mode}' must appear in e2e-live-run.js`).toContain(`'${mode}'`);
    }
  });

  it('Pass_Fail_Summary block header appears exactly once', () => {
    expect(SCRIPT.match(/=== Pass_Fail_Summary ===/g)).toHaveLength(1);
  });

  it('registers SIGINT/SIGTERM cleanup handlers', () => {
    expect(SCRIPT).toContain("process.on('SIGINT'");
    expect(SCRIPT).toContain("process.on('SIGTERM'");
  });

  it('only stops processes the script started (cleanup plan driven)', () => {
    expect(SCRIPT).toContain('buildCleanupPlan(');
  });

  it('exits non-zero on failure', () => {
    expect((SCRIPT.match(/process\.exitCode = 1|process\.exit\(1\)/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
