#!/usr/bin/env node
//
// Tail the detached background recorder log.
//
//   npm run recorder:logs
//
// Prints the most recent lines from recorder.log (and the rotated copy when
// present), mirroring `npm run service:logs` for the managed MCP service.

import { readFile } from 'node:fs/promises';

import {
  isProcessAlive,
  readRecorderPid,
  recorderLogPath,
  rotatedRecorderLogPath
} from './recorder-runtime.js';

const MAX_LINES = 80;

function tailLines(content) {
  return content
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(-MAX_LINES)
    .join('\n');
}

async function printLog(filePath, label) {
  try {
    const content = await readFile(filePath, 'utf8');
    const tail = tailLines(content);
    if (!tail) {
      return false;
    }

    console.log(`== ${label}: ${filePath} ==`);
    console.log(tail);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

const pid = await readRecorderPid();
const running = pid !== undefined && isProcessAlive(pid);
if (running) {
  console.log(`== recorder status: running (pid ${pid}) ==`);
}

let printed = await printLog(recorderLogPath, 'recorder log');
printed = (await printLog(rotatedRecorderLogPath, 'recorder log (rotated)')) || printed;

// A running recorder with an empty log (just started) is still a healthy state,
// so only treat "no status and no log" as an error.
if (!printed && !running) {
  console.error('No recorder log output found yet under ~/.computer-history-mcp/logs/.');
  process.exit(1);
}
