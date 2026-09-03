#!/usr/bin/env node

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureAppHomeReady, inspectAppHomeMigrationState } from './app-home-migration.js';
import { uninstallLegacyManagedService } from './legacy-service.js';
import {
  ensureAppDirectories,
  ensureDependenciesInstalled,
  ensureSupportedNodeVersion,
  migrateLegacyHermesServerRegistration,
  resolveAppPaths,
  writeConfigYamlFile
} from './onboarding-config.js';
import { detectHermes } from './hermes-detector.js';
import { hasCompletedOnboarding, markOnboardingComplete } from './onboarding-state.js';

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

  const conflictCheck = inspectAppHomeMigrationState();
  if (conflictCheck.status === 'both-present') {
    throw new Error(
      `Both ${conflictCheck.legacyDirectory} and ${conflictCheck.targetDirectory} exist. Resolve the conflict manually before continuing.`
    );
  }
  const alreadyOnboarded = hasCompletedOnboarding();
  uninstallLegacyManagedService();
  const migration = await ensureAppHomeReady({ failOnConflict: true });
  if (alreadyOnboarded) {
    await markOnboardingComplete();
  }
  await migrateLegacyHermesServerRegistration();
  const installedDependencies = ensureDependenciesInstalled(repositoryRoot);
  const createdConfig = await ensureConfigFile();
  const hermesDetection = await detectHermes();

  console.log('computer-history-mcp setup complete.');
  console.log(`- repo: ${repositoryRoot}`);
  if (migration.status === 'migrated') {
    console.log(`- app home migrated from ${migration.legacyDirectory}`);
    console.log(`- migration backup: ${migration.backupDirectory}`);
  }
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
  console.log('1. Run npm start; it selects onboarding, build recovery, or fast resume automatically.');
  console.log('2. Review config.yaml first only if you want to customize endpoints.');
  console.log('3. For targeted maintenance, use npm run service:status or npm run service:logs.');
}

await main();
