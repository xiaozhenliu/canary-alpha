#!/usr/bin/env node

import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const LABEL = 'com.canary-alpha-mcp';
const installedPlistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== 'darwin') {
  fail('service:stop currently supports macOS launchd only.');
}

const domain = `gui/${process.getuid()}`;
const loadedResult = spawnSync('launchctl', ['print', `${domain}/${LABEL}`], {
  encoding: 'utf8'
});
const loadedStderr = loadedResult.stderr?.trim() ?? '';
const loadedStdout = loadedResult.stdout?.trim() ?? '';
const loadedMessage = loadedStderr || loadedStdout;

if (loadedResult.status !== 0) {
  const serviceMissing = loadedMessage.includes('Could not find service')
    || loadedMessage.includes('No such process')
    || loadedMessage.includes('Could not find specified service');
  if (!serviceMissing) {
    fail(loadedMessage || `launchctl print ${domain}/${LABEL} failed.`);
  }

  if (existsSync(installedPlistPath)) {
    unlinkSync(installedPlistPath);
  }

  console.log('canary-alpha-mcp service is already stopped.');
  console.log(`- plist removed: ${installedPlistPath}`);
  process.exit(0);
}

const result = spawnSync('launchctl', ['bootout', domain, installedPlistPath], {
  encoding: 'utf8'
});

if (result.status !== 0) {
  const stderr = result.stderr?.trim() ?? '';
  const stdout = result.stdout?.trim() ?? '';
  const combined = stderr || stdout;
  if (combined.includes('Could not find service') || combined.includes('No such process')) {
    if (existsSync(installedPlistPath)) {
      unlinkSync(installedPlistPath);
    }

    console.log('canary-alpha-mcp service is already stopped.');
    console.log(`- plist removed: ${installedPlistPath}`);
    process.exit(0);
  }

  fail(combined || 'Failed to stop canary-alpha-mcp service.');
}

if (existsSync(installedPlistPath)) {
  unlinkSync(installedPlistPath);
}

console.log('canary-alpha-mcp service stopped.');
console.log(`- label: ${LABEL}`);
console.log(`- plist removed: ${installedPlistPath}`);
