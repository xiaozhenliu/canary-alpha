#!/usr/bin/env node
//
// Gracefully stop the detached background recorder.
//
//   npm run recorder:stop
//
// Sends SIGTERM to the recorder PID recorded by `recorder:start`. The recorder
// supervisor handles SIGTERM by forwarding it to the Screenpipe process group
// (Screenpipe shuts down cleanly) and running a final DB-maintenance pass
// before it exits, so capture data and the SQLite store are left consistent.
//
// If the recorder does not exit within the grace window (e.g. a stuck final
// maintenance pass), it escalates to SIGKILL so the command still returns.

import {
  clearRecorderPid,
  isProcessAlive,
  readRecorderPid,
  recorderPidPath
} from './recorder-runtime.js';

// The final DB-maintenance pass can take several seconds, so allow a generous
// graceful window before escalating.
const GRACEFUL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reportAlreadyStopped() {
  await clearRecorderPid();
  console.log('computer-history-mcp recorder is already stopped.');
  console.log(`- pid file removed: ${recorderPidPath}`);
}

async function main() {
  const pid = await readRecorderPid();
  if (pid === undefined || !isProcessAlive(pid)) {
    await reportAlreadyStopped();
    return;
  }

  console.log(`Stopping background recorder gracefully (pid ${pid})…`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
      await reportAlreadyStopped();
      return;
    }
    throw error;
  }

  const deadline = Date.now() + GRACEFUL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (!isProcessAlive(pid)) {
      await clearRecorderPid();
      console.log('computer-history-mcp recorder stopped.');
      console.log(`- pid file removed: ${recorderPidPath}`);
      return;
    }
  }

  // Backstop: the recorder ignored or could not complete graceful shutdown in
  // time. Force-kill so the terminal command does not hang indefinitely.
  console.error(`Recorder pid ${pid} did not exit within ${GRACEFUL_TIMEOUT_MS}ms; sending SIGKILL.`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process already gone between the timeout check and the kill.
  }
  await sleep(POLL_INTERVAL_MS);
  await clearRecorderPid();
  console.log('computer-history-mcp recorder force-stopped.');
  console.log(`- pid file removed: ${recorderPidPath}`);
}

await main();
