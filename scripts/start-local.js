#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APP_DIRECTORY_NAME,
  ensureAppHomeReady,
  inspectAppHomeMigrationState
} from './app-home-migration.js';
import { uninstallLegacyManagedService } from './legacy-service.js';
import {
  DEFAULT_SCREENPIPE_URL,
  ensureRecorderStarted,
  isScreenpipeHealthy,
  runNpmScript,
  waitForScreenpipe
} from './local-stack-runtime.js';
import { startLocalStack } from './start-local-lib.js';
import { hasCompletedOnboarding, markOnboardingComplete } from './onboarding-state.js';
import { migrateLegacyHermesServerRegistration } from './onboarding-config.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const configPath = join(homedir(), APP_DIRECTORY_NAME, 'config.yaml');
const distEntrypoint = join(repositoryRoot, 'dist', 'src', 'index.js');

function looksLikeCompletedDataInstall(appDirectory) {
  return [
    '.onboarding-complete',
    'chroma',
    'derived.sqlite',
    'memory'
  ].some((name) => existsSync(join(appDirectory, name)));
}

function directoryHasEntries(directory) {
  try {
    return readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}

function isLikelySetupOnlyInstall(appDirectory) {
  if (!existsSync(join(appDirectory, 'config.yaml'))) {
    return false;
  }
  if (looksLikeCompletedDataInstall(appDirectory)) {
    return false;
  }
  // `npm run setup` always creates empty logs/routines directories. A config-only
  // legacy stdio install typically has neither, and must not be re-onboarded.
  if (directoryHasEntries(join(appDirectory, 'logs'))) {
    return false;
  }
  if (directoryHasEntries(join(appDirectory, 'routines', 'definitions'))) {
    return false;
  }
  return existsSync(join(appDirectory, 'logs'))
    && existsSync(join(appDirectory, 'routines'));
}

function hasLegacyMigrationBackup(homeDirectory) {
  try {
    return readdirSync(homeDirectory).some((name) => name.startsWith('.canary-alpha-mcp.backup-'));
  } catch {
    return false;
  }
}

function log(step, message) {
  console.log(`[start:${step}] ${message}`);
}

async function ensureFirstRunScreenpipe() {
  if (await isScreenpipeHealthy(DEFAULT_SCREENPIPE_URL)) {
    log('capture', `Reusing Screenpipe at ${DEFAULT_SCREENPIPE_URL}.`);
    return;
  }

  log('capture', 'Screenpipe is unavailable; starting the background recorder.');
  await ensureRecorderStarted((message) => log('capture', message));
  await waitForScreenpipe(DEFAULT_SCREENPIPE_URL);
  log('capture', 'Screenpipe is ready for onboarding.');
}

async function main() {
  const conflictCheck = inspectAppHomeMigrationState();
  if (conflictCheck.status === 'both-present') {
    throw new Error(
      `Both ${conflictCheck.legacyDirectory} and ${conflictCheck.targetDirectory} exist. Resolve the conflict manually before continuing.`
    );
  }

  // Capture before uninstall: legacy launchd plist is one onboarding signal.
  const alreadyOnboarded = hasCompletedOnboarding();
  uninstallLegacyManagedService();
  await ensureAppHomeReady({ failOnConflict: true });
  // Durable signals: marker/plist, or a migration backup with a non-setup config.
  // Setup-only installs keep empty logs/routines and must still enter onboarding.
  const appDirectory = join(homedir(), APP_DIRECTORY_NAME);
  const treatAsOnboarded = alreadyOnboarded
    || hasCompletedOnboarding()
    || (hasLegacyMigrationBackup(homedir())
      && existsSync(configPath)
      && !isLikelySetupOnlyInstall(appDirectory));
  if (treatAsOnboarded) {
    await migrateLegacyHermesServerRegistration();
    await markOnboardingComplete();
  }

  const result = await startLocalStack({
    hasConfig: () => existsSync(configPath),
    hasCompletedOnboarding,
    hasBuild: () => existsSync(distEntrypoint),
    ensureFirstRunScreenpipe,
    onboard: () => runNpmScript('onboard'),
    build: () => runNpmScript('build'),
    resume: () => runNpmScript('resume'),
    log
  });

  if (result.mode === 'resume' || treatAsOnboarded) {
    await markOnboardingComplete();
  }

  console.log('');
  console.log(`Local startup completed via ${result.mode}${result.built ? ' after build recovery' : ''}.`);
}

await main().catch((error) => {
  console.error(`[start:error] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
