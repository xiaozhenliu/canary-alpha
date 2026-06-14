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

  it('supports --restart-capture to force a fresh recorder', () => {
    expect(SCRIPT).toContain('--restart-capture');
    expect(SCRIPT).toContain('stopRunningScreenpipe');
    // Forced restart must stop the existing listener before starting fresh.
    expect(SCRIPT).toContain('SIGTERM');
    expect(SCRIPT).toContain('SIGKILL');
  });

  it('supports --detach to run the recorder in the background', () => {
    expect(SCRIPT).toContain('--detach');
    expect(SCRIPT).toContain('--background');
    expect(SCRIPT).toContain('startRecorderBackground');
    // Background mode must delegate to the detached recorder:start lifecycle.
    expect(SCRIPT).toContain('recorder:start');
  });
});

describe('package.json daily-use scripts', () => {
  it('exposes `up` pointing at the orchestrator', () => {
    expect(PACKAGE.scripts.up).toBe('node scripts/start-daily.js');
  });

  it('exposes `down` to stop the managed service', () => {
    expect(PACKAGE.scripts.down).toBe('node scripts/service-stop.js');
  });

  it('exposes the background recorder lifecycle scripts', () => {
    expect(PACKAGE.scripts['recorder:start']).toBe('node scripts/recorder-start.js');
    expect(PACKAGE.scripts['recorder:stop']).toBe('node scripts/recorder-stop.js');
    expect(PACKAGE.scripts['recorder:status']).toBe('node scripts/recorder-status.js');
    expect(PACKAGE.scripts['recorder:logs']).toBe('node scripts/recorder-logs.js');
  });

  it('exposes `down:all` for a one-command graceful teardown', () => {
    expect(PACKAGE.scripts['down:all']).toBe('node scripts/stack-down.js');
  });
});

describe('stack-down.js teardown order', () => {
  const STACK_DOWN = readFileSync(join(REPO_ROOT, 'scripts', 'stack-down.js'), 'utf8');

  it('stops the recorder before the managed service', () => {
    const recorderAt = STACK_DOWN.indexOf('recorder-stop.js');
    const serviceAt = STACK_DOWN.indexOf('service-stop.js');
    expect(recorderAt).toBeGreaterThan(-1);
    expect(serviceAt).toBeGreaterThan(-1);
    // Recorder must be torn down first so its final maintenance pass flushes
    // before the managed service is stopped.
    expect(recorderAt).toBeLessThan(serviceAt);
  });
});

describe('recorder-start.js detach safety', () => {
  const RECORDER_START = readFileSync(join(REPO_ROOT, 'scripts', 'recorder-start.js'), 'utf8');

  it('detaches the recorder from the terminal', () => {
    expect(RECORDER_START).toContain('detached: true');
    expect(RECORDER_START).toContain('child.unref()');
  });

  it('redirects recorder output to the log file instead of the terminal', () => {
    expect(RECORDER_START).toContain('recorderLogPath');
    expect(RECORDER_START).toContain("stdio: ['ignore', logFd, logFd]");
  });

  it('records the PID so it can be stopped gracefully later', () => {
    expect(RECORDER_START).toContain('writeRecorderPid');
  });

  it('refuses to start a second recorder when one is already running', () => {
    expect(RECORDER_START).toContain('already running');
  });
});
