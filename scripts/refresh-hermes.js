#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';

import { runNpmScript } from './local-stack-runtime.js';
import { refreshHermes } from './refresh-hermes-lib.js';
import { DEFAULT_HERMES_SERVER_NAME, resolveHermesPaths } from './onboarding-config.js';
import { ONBOARDING_TOOL_INCLUDES } from './hermes-tool-includes.js';

function log(step, message) {
  console.log(`[refresh:${step}] ${message}`);
}

async function syncHermesConfig() {
  const hermesPaths = resolveHermesPaths();
  let raw;
  try {
    raw = await readFile(hermesPaths.configPath, 'utf8');
  } catch {
    log('config', 'No Hermes config found; skipping tools.include sync (run npm run onboard first).');
    return;
  }
  const config = YAML.parse(raw) ?? {};
  const serverEntry = config?.mcp_servers?.[DEFAULT_HERMES_SERVER_NAME];
  if (!serverEntry) {
    log('config', `No ${DEFAULT_HERMES_SERVER_NAME} entry in Hermes config; skipping tools.include sync.`);
    return;
  }
  serverEntry.tools = { ...serverEntry.tools, include: [...ONBOARDING_TOOL_INCLUDES] };
  await writeFile(hermesPaths.configPath, YAML.stringify(config), 'utf8');
  log('config', 'Hermes tools.include updated.');
}

await refreshHermes({
  build: () => runNpmScript('build'),
  restartService: () => runNpmScript('service:start'),
  resumeStack: () => runNpmScript('resume'),
  syncHermesConfig,
  verifyHermes: () => runNpmScript('hermes:verify'),
  log
}).then(() => {
  console.log('');
  console.log('MCP refresh completed and Hermes verification passed.');
}).catch((error) => {
  console.error(`[refresh:error] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
