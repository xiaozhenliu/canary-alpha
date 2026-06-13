import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static contract for the daily bring-up orchestrator (`npm run up`).
 *
 * The script has no pure logic worth unit-testing in isolation — it shells out
 * to the existing, already-tested scripts — so these checks lock the
 * orchestration order and the safety properties that matter:
 *   - it rebuilds before starting the service (no stale-dist validation),
 *   - it starts the managed service and the Screenpipe recorder,
 *   - it reuses an already-healthy Screenpipe instead of double-recording.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = readFileSync(join(REPO_ROOT, 'scripts', 'start-daily.js'), 'utf8');
const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('start-daily.js orchestration', () => {
  it('builds before starting the service', () => {
    const buildAt = SCRIPT.indexOf("'build'");
    const serviceAt = SCRIPT.indexOf("'service:start'");
    expect(buildAt).toBeGreaterThan(-1);
    expect(serviceAt).toBeGreaterThan(-1);
    expect(buildAt).toBeLessThan(serviceAt);
  });

  it('starts the managed MCP service', () => {
    expect(SCRIPT).toContain("'service:start'");
  });

  it('starts the Screenpipe recorder', () => {
    expect(SCRIPT).toContain('screenpipe-safe-record.js');
  });

  it('reuses an already-healthy Screenpipe instead of double-recording', () => {
    expect(SCRIPT).toContain('isScreenpipeHealthy');
    expect(SCRIPT).toContain('/health');
  });
});

describe('package.json daily-use scripts', () => {
  it('exposes `up` pointing at the orchestrator', () => {
    expect(PACKAGE.scripts.up).toBe('node scripts/start-daily.js');
  });

  it('exposes `down` to stop the managed service', () => {
    expect(PACKAGE.scripts.down).toBe('node scripts/service-stop.js');
  });
});
