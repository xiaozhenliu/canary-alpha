#!/usr/bin/env node
//
// Report whether the detached background recorder is running.
//
//   npm run recorder:status

import {
  isProcessAlive,
  readRecorderPid,
  recorderLogPath,
  recorderPidPath
} from './recorder-runtime.js';

const pid = await readRecorderPid();

if (pid !== undefined && isProcessAlive(pid)) {
  console.log('canary-alpha-mcp recorder: running');
  console.log(`- pid: ${pid}`);
  console.log(`- log: ${recorderLogPath}`);
} else {
  console.log('canary-alpha-mcp recorder: stopped');
  console.log(`- pid file: ${recorderPidPath}`);
}
