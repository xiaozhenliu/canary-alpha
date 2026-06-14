#!/usr/bin/env node
//
// Gracefully tear down the full background stack in one command:
//
//   npm run down:all
//
// Stops the detached recorder first (so its final DB-maintenance pass runs and
// Screenpipe shuts down cleanly), then stops the launchd-managed MCP service.
// Both steps run even if the other fails, so a partially-running stack is still
// fully cleaned up; the command exits non-zero when any step failed.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const recorderStopScript = join(scriptDirectory, 'recorder-stop.js');
const serviceStopScript = join(scriptDirectory, 'service-stop.js');

function runNode(scriptPath, label) {
  console.log(`[down:all] ${label}…`);
  const result = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit' });
  const code = result.status ?? 1;
  if (code !== 0) {
    console.error(`[down:all] ${label} failed (exit ${code}).`);
  }
  return code;
}

// Recorder first: let its final maintenance pass flush before the service goes
// away. Both stop scripts are idempotent (they report "already stopped" when
// nothing is running), so this is safe even on a partially-up stack.
const recorderCode = runNode(recorderStopScript, 'Stopping the background recorder');
const serviceCode = runNode(serviceStopScript, 'Stopping the managed MCP service');

if (recorderCode !== 0 || serviceCode !== 0) {
  process.exit(1);
}

console.log('[down:all] Full stack stopped.');
