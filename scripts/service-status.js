#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import YAML from 'yaml';

import { applyServerEnvironmentOverrides, parseManagedServiceEnvironmentFromPlist, readServerConfig, resolveManagedServiceServer } from './service-runtime-config.js';
import { getPackageVersion } from './version.js';

const APP_DIRECTORY_NAME = '.canary-alpha-mcp';
const CONFIG_FILE_NAME = 'config.yaml';
const LABEL = 'com.canary-alpha-mcp';
const installedPlistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const configPath = join(homedir(), APP_DIRECTORY_NAME, CONFIG_FILE_NAME);
const serviceLogPath = join(homedir(), APP_DIRECTORY_NAME, 'logs', 'service.log');
const DEFAULT_SERVER = {
  host: '127.0.0.1',
  port: 8765
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function loadServerConfig() {
  try {
    const raw = YAML.parse(await readFile(configPath, 'utf8')) ?? {};
    return {
      server: readServerConfig(raw, configPath)
    };
  } catch (error) {
    const nodeError = error;
    if (nodeError && typeof nodeError === 'object' && 'code' in nodeError && nodeError.code === 'ENOENT') {
      return {
        server: DEFAULT_SERVER
      };
    }

    return {
      server: DEFAULT_SERVER,
      configError: error instanceof Error ? error.message : String(error)
    };
  }
}

function readLaunchctlPid(output) {
  const match = output.match(/\bpid = (\d+)\b/);
  return match ? Number(match[1]) : undefined;
}

function createClient() {
  return new Client({
    name: 'canary-alpha-mcp-service-script',
    version: getPackageVersion()
  });
}

async function probeManagedService(host, port, expectedConfigFile, expectedPid) {
  const client = createClient();
  const authToken = typeof process.env.SCREENPIPE_MEMORY_MCP_AUTH_TOKEN === 'string' && process.env.SCREENPIPE_MEMORY_MCP_AUTH_TOKEN.length > 0
    ? process.env.SCREENPIPE_MEMORY_MCP_AUTH_TOKEN
    : undefined;
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
  } catch {
    return false;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

if (process.platform !== 'darwin') {
  fail('service:status currently supports macOS launchd only.');
}

const domain = `gui/${process.getuid()}`;
const launchctlPrint = spawnSync('launchctl', ['print', `${domain}/${LABEL}`], {
  encoding: 'utf8'
});

const managedEnvironment = existsSync(installedPlistPath)
  ? parseManagedServiceEnvironmentFromPlist(await readFile(installedPlistPath, 'utf8'))
  : {};
const { server: parsedServer, configError } = await loadServerConfig();
const managedEnvironmentErrors = [];
let configuredServer = parsedServer;
try {
  configuredServer = applyServerEnvironmentOverrides(parsedServer, managedEnvironment);
} catch (error) {
  managedEnvironmentErrors.push(error instanceof Error ? error.message : String(error));
}
let server = configuredServer;
try {
  server = resolveManagedServiceServer(configuredServer, managedEnvironment);
} catch (error) {
  managedEnvironmentErrors.push(error instanceof Error ? error.message : String(error));
}
const managedEnvironmentError = managedEnvironmentErrors.length > 0
  ? managedEnvironmentErrors.join('; ')
  : undefined;
const launchctlLoaded = launchctlPrint.status === 0;
const launchctlMessage = (launchctlPrint.stderr?.trim() || launchctlPrint.stdout?.trim() || '').trim();
const launchctlMissing = launchctlMessage.includes('Could not find service')
  || launchctlMessage.includes('No such process')
  || launchctlMessage.includes('Could not find specified service');
const launchctlError = !launchctlLoaded && !launchctlMissing
  ? launchctlMessage || `launchctl print ${domain}/${LABEL} failed.`
  : undefined;
const launchctlRunning = launchctlLoaded && /\bstate = running\b/.test(launchctlPrint.stdout ?? '');
const launchctlPid = launchctlRunning ? readLaunchctlPid(launchctlPrint.stdout ?? '') : undefined;
const endpointHealthy = launchctlRunning && launchctlPid
  ? await probeManagedService(server.host, server.port, configPath, launchctlPid)
  : false;
const healthy = launchctlRunning && endpointHealthy;

console.log(`label: ${LABEL}`);
console.log(`launchctl: ${launchctlError ? 'error' : launchctlRunning ? 'running' : launchctlLoaded ? 'loaded' : 'not loaded'}`);
console.log(`endpoint: http://${server.host}:${server.port}/mcp (${endpointHealthy ? 'healthy' : 'unhealthy'})`);
console.log(`service log: ${serviceLogPath}`);
if (launchctlError) {
  console.log(`launchctl error: ${launchctlError}`);
}
if (configError) {
  console.log(`config: invalid (${configError})`);
}
if (managedEnvironmentError) {
  console.log(`managed environment: invalid (${managedEnvironmentError})`);
}

if (!healthy) {
  process.exit(1);
}
