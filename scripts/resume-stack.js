#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import YAML from 'yaml';

import {
  DEFAULT_SCREENPIPE_URL,
  ensureRecorderStarted,
  isScreenpipeHealthy,
  runNpmScript,
  waitForScreenpipe
} from './local-stack-runtime.js';
import { resumeStack } from './resume-stack-lib.js';

const configPath = join(homedir(), '.computer-history-mcp', 'config.yaml');

function log(step, message) {
  console.log(`[resume:${step}] ${message}`);
}

async function resolveScreenpipeUrl() {
  try {
    const raw = YAML.parse(await readFile(configPath, 'utf8')) ?? {};
    const configuredUrl = raw?.screenpipe?.url;
    return typeof configuredUrl === 'string' && configuredUrl.length > 0
      ? configuredUrl
      : DEFAULT_SCREENPIPE_URL;
  } catch {
    return DEFAULT_SCREENPIPE_URL;
  }
}

async function main() {
  const screenpipeUrl = await resolveScreenpipeUrl();
  const result = await resumeStack({
    checkService: async () => {
      try {
        await runNpmScript('service:status', { quiet: true });
        return true;
      } catch {
        return false;
      }
    },
    checkScreenpipe: () => isScreenpipeHealthy(screenpipeUrl),
    startService: () => runNpmScript('service:start'),
    startRecorder: () => ensureRecorderStarted((message) => log('capture', message)),
    waitForScreenpipe: () => waitForScreenpipe(screenpipeUrl),
    log
  });

  console.log('');
  console.log('Local stack is ready.');
  console.log(`- MCP service: ${result.service}`);
  console.log(`- Screenpipe: ${result.screenpipe} (${screenpipeUrl})`);
}

await main().catch((error) => {
  console.error(`[resume:error] ${error instanceof Error ? error.message : String(error)}`);
  console.error('Inspect failures with `npm run service:logs` or `npm run recorder:logs`.');
  process.exit(1);
});
