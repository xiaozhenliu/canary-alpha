#!/usr/bin/env node

import { existsSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import YAML from 'yaml';

import { APP_DIRECTORY_NAME, ensureAppHomeReady, inspectAppHomeMigrationState } from './app-home-migration.js';
import { LAUNCHD_LABEL, uninstallLegacyManagedService } from './legacy-service.js';
import { applyServerEnvironmentOverrides, readServerConfig, renderManagedServiceEnvironmentXml } from './service-runtime-config.js';
import { migrateLegacyHermesServerRegistration } from './onboarding-config.js';
import { hasCompletedOnboarding, markOnboardingComplete } from './onboarding-state.js';
import { getPackageVersion } from './version.js';

const CONFIG_FILE_NAME = 'config.yaml';
const LABEL = LAUNCHD_LABEL;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const appDirectory = join(homedir(), APP_DIRECTORY_NAME);
const configPath = join(appDirectory, CONFIG_FILE_NAME);
const launchAgentsDirectory = join(homedir(), 'Library', 'LaunchAgents');
const installedPlistPath = join(launchAgentsDirectory, `${LABEL}.plist`);
const templatePlistPath = join(scriptDirectory, `${LABEL}.plist`);
const distEntrypoint = join(repositoryRoot, 'dist', 'src', 'index.js');
const logDirectory = join(appDirectory, 'logs');
const serviceLogPath = join(logDirectory, 'service.log');
const launchdStdoutPath = join(logDirectory, 'launchd.stdout.log');
const launchdStderrPath = join(logDirectory, 'launchd.stderr.log');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function ensureDarwin() {
  if (process.platform !== 'darwin') {
    fail('service:start currently supports macOS launchd only.');
  }
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function loadServerConfigFrom(path) {
  try {
    const raw = YAML.parse(await readFile(path, 'utf8')) ?? {};
    return applyServerEnvironmentOverrides(readServerConfig(raw, path));
  } catch (error) {
    const nodeError = error;
    if (nodeError && typeof nodeError === 'object' && 'code' in nodeError && nodeError.code === 'ENOENT') {
      fail(`Missing config file at ${path}. Run npm run setup first.`);
    }
    throw error;
  }
}

async function loadServerConfig() {
  return loadServerConfigFrom(configPath);
}

function readLaunchctlPid(output) {
  const match = output.match(/\bpid = (\d+)\b/);
  return match ? Number(match[1]) : undefined;
}

function readLaunchctlState(output) {
  const match = output.match(/\bstate = ([^\n]+)\b/);
  return match ? match[1].trim() : undefined;
}

function printService(domain) {
  const result = spawnSync('launchctl', ['print', `${domain}/${LABEL}`], {
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    fail(stderr || stdout || `launchctl print ${domain}/${LABEL} failed.`);
  }

  return result.stdout ?? '';
}

function isServiceLoaded(domain) {
  const result = spawnSync('launchctl', ['print', `${domain}/${LABEL}`], {
    encoding: 'utf8'
  });
  return result.status === 0;
}

function launchctl(args, options = {}) {
  const result = spawnSync('launchctl', args, {
    encoding: 'utf8',
    ...options
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(stderr || stdout || `launchctl ${args.join(' ')} failed.`);
  }
}

function readListeningProcess(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'], {
    encoding: 'utf8'
  });

  if (result.status !== 0 || !result.stdout) {
    return undefined;
  }

  let pid;
  let command;
  let address;

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('c')) {
      command = line.slice(1);
    } else if (line.startsWith('n')) {
      address = line.slice(1);
    }
  }

  if (!pid || !command) {
    return undefined;
  }

  return {
    pid,
    command,
    address
  };
}

function assertPortAvailable(port) {
  const listener = readListeningProcess(port);
  if (!listener) {
    return;
  }

  const addressSuffix = listener.address ? ` on ${listener.address}` : '';
  throw new Error(`Port ${port} is already in use by PID ${listener.pid} (${listener.command})${addressSuffix}. Stop the existing process before starting the managed service.`);
}

function createClient() {
  return new Client({
    name: 'computer-history-mcp-service-script',
    version: getPackageVersion()
  });
}

async function probeManagedService(host, port, expectedConfigFile, expectedPid, authToken) {
  const client = createClient();
  const transport = new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`), authToken
    ? {
        authProvider: {
          token: async () => authToken
        }
      }
    : undefined);
  let timeout;

  try {
    const result = await Promise.race([
      (async () => {
        await client.connect(transport);
        return client.callTool({
          name: 'internal-status',
          arguments: {}
        });
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out probing http://${host}:${port}/mcp`));
        }, 2_000);
        timeout.unref?.();
      })
    ]);

    const structured = result.structuredContent;
    return !!structured
      && typeof structured === 'object'
      && 'status' in structured
      && structured.status === 'ok'
      && 'mode' in structured
      && structured.mode === 'http'
      && 'host' in structured
      && structured.host === host
      && 'port' in structured
      && structured.port === port
      && 'pid' in structured
      && structured.pid === expectedPid
      && 'configFile' in structured
      && structured.configFile === expectedConfigFile;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

async function waitForManagedService(domain, host, port, expectedConfigFile, authToken, timeoutMs = 10_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (!isServiceLoaded(domain)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }

      const serviceState = printService(domain);
      const servicePid = readLaunchctlPid(serviceState);
      const serviceLifecycleState = readLaunchctlState(serviceState);
      if (!servicePid || serviceLifecycleState !== 'running') {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }

      const ready = await probeManagedService(host, port, expectedConfigFile, servicePid, authToken);
      if (ready) {
        return;
      }
    } catch {
      // Service is still starting or another process is bound to the port.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`computer-history-mcp did not become ready at http://${host}:${port}/mcp within ${timeoutMs}ms.`);
}

async function installResolvedPlist() {
  const template = await readFile(templatePlistPath, 'utf8');
  const server = await loadServerConfig();
  const rendered = template
    .replaceAll('__NODE_BINARY__', xmlEscape(process.execPath))
    .replaceAll('__PROJECT_ROOT__', xmlEscape(repositoryRoot))
    .replaceAll('__HOME_DIRECTORY__', xmlEscape(homedir()))
    .replaceAll('__ENVIRONMENT_VARIABLES__', renderManagedServiceEnvironmentXml(homedir(), process.env, server))
    .replaceAll('__LAUNCHD_STDOUT_PATH__', xmlEscape(launchdStdoutPath))
    .replaceAll('__LAUNCHD_STDERR_PATH__', xmlEscape(launchdStderrPath));

  await mkdir(launchAgentsDirectory, { recursive: true, mode: 0o700 });
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  await writeFile(installedPlistPath, rendered, { encoding: 'utf8', mode: 0o600 });
}

async function main() {
  ensureDarwin();

  const conflictCheck = inspectAppHomeMigrationState();
  if (conflictCheck.status === 'both-present') {
    fail(
      `Both ${conflictCheck.legacyDirectory} and ${conflictCheck.targetDirectory} exist. Resolve the conflict manually before continuing.`
    );
  }

  if (!existsSync(distEntrypoint)) {
    fail(`Missing built service entrypoint at ${distEntrypoint}. Run npm run build first.`);
  }

  // Validate config and host before stopping the legacy writer or moving data.
  const preflightConfigPath = conflictCheck.status === 'legacy-only'
    ? join(conflictCheck.legacyDirectory, CONFIG_FILE_NAME)
    : configPath;
  const server = await loadServerConfigFrom(preflightConfigPath);
  if (server.host !== '127.0.0.1') {
    fail(`Refusing to start service with non-local host ${server.host}. Expected 127.0.0.1.`);
  }

  const alreadyOnboarded = hasCompletedOnboarding();
  const legacyService = uninstallLegacyManagedService();
  const migration = await ensureAppHomeReady({ failOnConflict: true });
  if (alreadyOnboarded) {
    await markOnboardingComplete();
  }
  await migrateLegacyHermesServerRegistration();

  await installResolvedPlist();

  const domain = `gui/${process.getuid()}`;
  try {
    if (isServiceLoaded(domain)) {
      launchctl(['bootout', domain, installedPlistPath]);
    }

    assertPortAvailable(server.port);
    launchctl(['bootstrap', domain, installedPlistPath]);
    launchctl(['kickstart', '-k', `${domain}/${LABEL}`]);
    // The readiness probe must authenticate against the auth-protected HTTP
    // transport. Resolve the token the same way the launchd service does —
    // env override first, then `server.authToken` from config — so a standard
    // `service:start` (token in config, not env) does not falsely time out.
    const probeAuthToken =
      typeof process.env.CANARY_ALPHA_MCP_AUTH_TOKEN === 'string' && process.env.CANARY_ALPHA_MCP_AUTH_TOKEN.length > 0
        ? process.env.CANARY_ALPHA_MCP_AUTH_TOKEN
        : server.authToken;
    await waitForManagedService(domain, server.host, server.port, configPath, probeAuthToken);
  } catch (error) {
    if (isServiceLoaded(domain)) {
      spawnSync('launchctl', ['bootout', domain, installedPlistPath], { encoding: 'utf8' });
    }
    if (existsSync(installedPlistPath)) {
      unlinkSync(installedPlistPath);
    }

    throw error;
  }

  const endpoint = `http://${server.host}:${server.port}/mcp`;
  console.log('computer-history-mcp service started.');
  console.log(`- label: ${LABEL}`);
  console.log(`- plist: ${installedPlistPath}`);
  console.log(`- endpoint: ${endpoint}`);
  console.log(`- service log: ${serviceLogPath}`);
  if (legacyService.status === 'removed') {
    console.log(`- legacy service removed: ${legacyService.label}`);
  }
}

await main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
