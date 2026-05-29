#!/usr/bin/env node

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureAppDirectories,
  ensureDependenciesInstalled,
  ensureSupportedNodeVersion,
  resolveAppPaths,
  writeConfigYamlFile
} from './onboarding-config.js';
import { detectHermes } from './hermes-detector.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const paths = resolveAppPaths();

async function ensureConfigFile() {
  await ensureAppDirectories(paths);

  if ((await import('node:fs')).existsSync(paths.configPath)) {
    return false;
  }

  await writeConfigYamlFile(paths.configPath);
  return true;
}

async function main() {
  ensureSupportedNodeVersion();

  const installedDependencies = ensureDependenciesInstalled(repositoryRoot);
  const createdConfig = await ensureConfigFile();
  const hermesDetection = await detectHermes();

  console.log('canary-alpha-mcp setup complete.');
  console.log(`- repo: ${repositoryRoot}`);
  console.log(`- config: ${paths.configPath}${createdConfig ? ' (created)' : ' (kept existing)'}`);
  console.log(`- logs: ${paths.logDirectory}`);
  console.log(`- routines definitions: ${paths.routinesDefinitionsDirectory}`);
  console.log(`- routines history: ${paths.routinesHistoryDirectory}`);
  console.log(`- dependencies: ${installedDependencies ? 'installed with npm install' : 'already present'}`);
  if (hermesDetection.present) {
    console.log(`- hermes: ${hermesDetection.version}`);
  } else {
    console.log('');
    console.log('⚠ Hermes CLI not found on PATH.');
    console.log(`  Install instructions: ${hermesDetection.installGuidanceUrl}`);
    console.log('  npm run hermes:verify will not be runnable until hermes is on PATH.');
  }
  console.log('');
  console.log('Next steps:');
  console.log('1. Start Screenpipe if it is not already running: npm run screenpipe:safe-record');
  console.log('2. Run npm run onboard for the default-first interactive setup, build, and service start flow.');
  console.log('3. Or review config.yaml manually if you want to customize endpoints before starting the service yourself.');
  console.log('4. Run npm run build.');
  console.log('5. Run npm run service:start.');
  console.log('6. Check npm run service:status and npm run service:logs.');
}

await main();
