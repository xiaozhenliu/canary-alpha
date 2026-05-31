#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const serviceLogPath = join(homedir(), '.canary-alpha-mcp', 'logs', 'service.log');
const rotatedServiceLogPath = `${serviceLogPath}.1`;
const launchdStdoutPath = join(homedir(), '.canary-alpha-mcp', 'logs', 'launchd.stdout.log');
const launchdStderrPath = join(homedir(), '.canary-alpha-mcp', 'logs', 'launchd.stderr.log');
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
    const nodeError = error;
    if (nodeError && typeof nodeError === 'object' && 'code' in nodeError && nodeError.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

let printed = false;
printed = await printLog(serviceLogPath, 'service log') || printed;
printed = await printLog(rotatedServiceLogPath, 'service log (rotated)') || printed;
printed = await printLog(launchdStderrPath, 'launchd stderr') || printed;
printed = await printLog(launchdStdoutPath, 'launchd stdout') || printed;

if (!printed) {
  console.error('No log output found yet under ~/.canary-alpha-mcp/logs/.');
  process.exit(1);
}
