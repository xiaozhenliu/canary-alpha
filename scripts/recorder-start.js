#!/usr/bin/env node
//
// Start the Screenpipe recorder as a detached background process.
//
//   npm run recorder:start [-- <screenpipe record flags>]
//
// Unlike the foreground recorder (`npm run screenpipe:safe-record` or
// `npm run up`), this detaches from the terminal so the launching window can be
// closed. Output is redirected to ~/.computer-history-mcp/logs/recorder.log and the
// PID is written to ~/.computer-history-mcp/recorder.pid for later graceful stop.
//
// The detached child is the same safe-record supervisor used in the foreground,
// so its graceful-shutdown chain (forward signal to the Screenpipe process
// group + final DB-maintenance pass) is preserved — `npm run recorder:stop`
// drives it.

import { openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureLogDirectory,
  isProcessAlive,
  readRecorderPid,
  recorderLogPath,
  recorderPidPath,
  rotateRecorderLogIfNeeded,
  writeRecorderPid
} from './recorder-runtime.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const recordScript = join(scriptDirectory, 'screenpipe-safe-record.js');

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  const passthroughArgs = process.argv.slice(2);
  // Default to all-monitor capture so a bare `recorder:start` matches the
  // recorder invocation that `npm run up` uses in the foreground.
  const recorderArgs = passthroughArgs.length > 0 ? passthroughArgs : ['--use-all-monitors'];

  const existingPid = await readRecorderPid();
  if (existingPid !== undefined && isProcessAlive(existingPid)) {
    fail(`A background recorder is already running (pid ${existingPid}). Stop it with \`npm run recorder:stop\` first.`);
  }

  await ensureLogDirectory();
  await rotateRecorderLogIfNeeded();

  // Open the log in append mode and reuse the same fd for stdout and stderr so
  // the child writes both streams into a single chronological log file.
  const logFd = openSync(recorderLogPath, 'a');

  // detached: true makes the recorder a session/process-group leader, so a
  // SIGHUP from the closing terminal will not reach it. stdio is fully detached
  // from the terminal (stdin ignored, stdout/stderr -> log file).
  const child = spawn(process.execPath, [recordScript, ...recorderArgs], {
    cwd: repositoryRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd]
  });

  child.on('error', (error) => {
    fail(`Failed to start the background recorder: ${error instanceof Error ? error.message : String(error)}`);
  });

  if (child.pid === undefined) {
    fail('Failed to start the background recorder: no PID was assigned.');
  }

  await writeRecorderPid(child.pid);

  // Drop the parent's reference so this launcher can exit and free the terminal
  // while the recorder keeps running in its own session.
  child.unref();

  console.log('computer-history-mcp recorder started in the background.');
  console.log(`- pid: ${child.pid}`);
  console.log(`- args: screenpipe record ${recorderArgs.join(' ')}`);
  console.log(`- log: ${recorderLogPath}`);
  console.log(`- pid file: ${recorderPidPath}`);
  console.log('Tail logs with `npm run recorder:logs`; stop gracefully with `npm run recorder:stop`.');
}

await main();
