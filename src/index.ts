import { execFile } from 'node:child_process';
import { readFile, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import { promisify } from 'node:util';

import YAML from 'yaml';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { createApp, startIndexingPoller } from './bootstrap/create-app.js';
import { getPackageVersion } from './lib/version.js';
import {
  acquireRebuildLock,
  ensureRebuildLockNotHeld,
  findActiveRuntimeProcesses,
  registerRuntimeProcess
} from './services/runtime-process-registry.js';
import { resolveVectorStoreDirectory, resolveVectorStoreFilePath } from './services/retrieval/vector-store.js';
import { startHttpTransport } from './transports/http.js';
import { startStdioTransport } from './transports/stdio.js';
import type { AppContext, ServerMode } from './types/app-config.js';
import { runConfigCommand } from './config-cli.js';

const execFileAsync = promisify(execFile);

function readCliMode(argv: string[]): ServerMode | undefined {
  const modeFlagIndex = argv.findIndex((value) => value === '--mode');
  if (modeFlagIndex === -1) {
    return undefined;
  }

  const value = argv[modeFlagIndex + 1];
  if (value === 'stdio' || value === 'http') {
    return value;
  }

  throw new Error(`Unsupported mode: ${value ?? '(missing)'}`);
}

function readCliCommand(argv: string[]): 'serve' | 'rebuild-index' {
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--mode') {
      index += 1;
      continue;
    }

    if (!value.startsWith('--')) {
      positional.push(value);
    }
  }

  const command = positional[0];
  if (!command) {
    return 'serve';
  }

  if (command === 'rebuild-index') {
    return command;
  }

  throw new Error(`Unsupported command: ${command}`);
}

function formatCheckpoint(checkpoint: AppContext['services']['retrieval']['checkpointStore'] extends { readLatest(): Promise<infer T>; } ? T : never): string {
  if (!checkpoint) {
    return 'none';
  }

  const backlog = checkpoint.backlog
    ? `, backlog nextOffset=${checkpoint.backlog.nextOffset}`
    : '';
  return `${checkpoint.timestamp}${checkpoint.cursor ? ` (${checkpoint.cursor})` : ''}${backlog}`;
}

function normalizeRetrievalPath(path: string): string {
  return normalize(path);
}

function getRecoveryStatus(
  checkpoint: AppContext['services']['retrieval']['checkpointStore'] extends { readLatest(): Promise<infer T>; } ? T : never,
  vectorStoreState: { persisted: boolean; readable: boolean; recordCount?: number; }
): 'ready' | 'needs-rebuild' {
  if (!checkpoint || checkpoint.backlog || !vectorStoreState.readable) {
    return 'needs-rebuild';
  }

  const emptyButUsableVectorStore = vectorStoreState.persisted === false && vectorStoreState.recordCount === 0;
  if (!vectorStoreState.persisted && !emptyButUsableVectorStore) {
    return 'needs-rebuild';
  }

  return 'ready';
}

function createClient(): Client {
  return new Client({
    name: 'canary-alpha-mcp-rebuild-index',
    version: getPackageVersion()
  });
}

function parseOptionalPort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function parseManagedServiceEnvironmentFromPlist(rawPlist: string): Record<string, string> {
  const environmentBlock = rawPlist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!environmentBlock) {
    return {};
  }

  const parsedEnvironment: Record<string, string> = {};
  const keyValuePattern = /<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/g;

  for (const match of environmentBlock[1].matchAll(keyValuePattern)) {
    parsedEnvironment[match[1]] = match[2]
      .replaceAll('&apos;', "'")
      .replaceAll('&quot;', '"')
      .replaceAll('&gt;', '>')
      .replaceAll('&lt;', '<')
      .replaceAll('&amp;', '&');
  }

  return parsedEnvironment;
}

function resolveManagedServiceServer(server: AppContext['config']['server'], environment: Record<string, string>): AppContext['config']['server'] {
  let managedPort: number | undefined;

  try {
    managedPort = parseOptionalPort(environment.MCP_PORT);
  } catch {
    managedPort = undefined;
  }

  managedPort ??= parseOptionalPort(environment.CANARY_ALPHA_MCP_SERVER_PORT);

  return {
    host: environment.CANARY_ALPHA_MCP_SERVER_HOST || server.host,
    port: managedPort ?? server.port,
    mode: 'http'
  };
}

async function probeManagedServiceEndpoint(
  host: string,
  port: number,
  expectedConfigFile: string,
  authToken?: string
): Promise<boolean> {
  const client = createClient();
  const transport = new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`), authToken
    ? {
        authProvider: {
          token: async () => authToken
        }
      }
    : undefined);
  let timeout: NodeJS.Timeout | undefined;

  try {
    const result = await Promise.race([
      (async () => {
        await client.connect(transport);
        return client.callTool({
          name: 'internal-status',
          arguments: {}
        });
      })(),
      new Promise<never>((_, reject) => {
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

async function detectActiveManagedService(config: AppContext['config']): Promise<boolean> {
  if (await probeManagedServiceEndpoint(
    config.server.host,
    config.server.port,
    config.paths.configFile,
    config.server.authToken
  )) {
    return true;
  }

  const installedPlistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.canary-alpha-mcp.plist');

  try {
    const plist = await readFile(installedPlistPath, 'utf8');
    const managedEnvironment = parseManagedServiceEnvironmentFromPlist(plist);
    const managedServer = resolveManagedServiceServer(config.server, managedEnvironment);

    if (managedServer.host === config.server.host && managedServer.port === config.server.port) {
      return false;
    }

    return probeManagedServiceEndpoint(
      managedServer.host,
      managedServer.port,
      config.paths.configFile,
      managedEnvironment.CANARY_ALPHA_MCP_AUTH_TOKEN || config.server.authToken
    );
  } catch {
    return false;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCommandEnvironmentValue(command: string, key: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`);
  const match = command.match(pattern);
  return match?.[1] ?? null;
}

const LEGACY_SERVER_ENTRYPOINTS = [
  'src/index.ts',
  'dist/index.js',
  'dist/src/index.js',
  'build/index.js'
] as const;
const REPOSITORY_ROOT = normalizeCommandPathToken(process.cwd());

function stripWrappingQuotes(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }

  return token;
}

function tokenizeCommand(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(stripWrappingQuotes);
}

function normalizeCommandPathToken(token: string): string {
  return token.replaceAll('\\', '/');
}

function commandTokenBaseName(token: string): string {
  const normalized = normalizeCommandPathToken(token);
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function isEnvironmentAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function isLegacyServerEntrypointToken(token: string): boolean {
  const normalized = normalizeCommandPathToken(token);
  return LEGACY_SERVER_ENTRYPOINTS.some((entrypoint) => normalized === entrypoint || normalized === `${REPOSITORY_ROOT}/${entrypoint}`);
}

function extractInterpreterEntrypoint(args: string[]): string | null {
  let sawTsxLoader = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }

    if (token === '--') {
      return args[index + 1] ?? null;
    }

    if (token === '-e' || token === '--eval' || token === '-p' || token === '--print') {
      return null;
    }

    if (token === '--import' || token === '--loader' || token === '--experimental-loader' || token === '-r' || token === '--require') {
      const value = args[index + 1];
      if (value && (normalizeCommandPathToken(value).includes('/tsx/') || value === 'tsx')) {
        sawTsxLoader = true;
      }
      index += 1;
      continue;
    }

    if (token.startsWith('-')) {
      continue;
    }

    if (sawTsxLoader && commandTokenBaseName(token) === 'cli.mjs' && normalizeCommandPathToken(token).includes('/tsx/')) {
      return extractTsxEntrypoint(args.slice(index + 1));
    }

    return token;
  }

  return null;
}

function extractSimpleRunnerEntrypoint(args: string[]): string | null {
  return extractSimpleRunnerEntrypointWithValueFlags(args, new Set<string>());
}

function extractSimpleRunnerEntrypointWithValueFlags(args: string[], flagsWithValues: ReadonlySet<string>): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }

    if (token === '--') {
      return args[index + 1] ?? null;
    }

    if (flagsWithValues.has(token)) {
      index += 1;
      continue;
    }

    if (!token.startsWith('-')) {
      return token;
    }
  }

  return null;
}

const TSX_FLAGS_WITH_VALUES = new Set<string>([
  '--tsconfig',
  '--env-file',
  '--import',
  '--loader'
]);

function extractTsxEntrypoint(args: string[]): string | null {
  return extractSimpleRunnerEntrypointWithValueFlags(args, TSX_FLAGS_WITH_VALUES);
}

function extractLegacyServerEntrypoint(command: string): string | null {
  const tokens = tokenizeCommand(command);
  let tokenIndex = 0;
  while (tokenIndex < tokens.length && isEnvironmentAssignmentToken(tokens[tokenIndex] ?? '')) {
    tokenIndex += 1;
  }

  const executable = tokens[tokenIndex];
  if (!executable) {
    return null;
  }

  if (isLegacyServerEntrypointToken(executable)) {
    return executable;
  }

  const executableBaseName = commandTokenBaseName(executable);
  const args = tokens.slice(tokenIndex + 1);

  if (executableBaseName === 'node' || executableBaseName === 'bun') {
    return extractInterpreterEntrypoint(args);
  }

  if (executableBaseName === 'tsx') {
    return extractTsxEntrypoint(args);
  }

  if (executableBaseName === 'npx' || executableBaseName === 'pnpx' || executableBaseName === 'pnpm' || executableBaseName === 'yarn' || executableBaseName === 'bunx') {
    const runnerCommand = extractSimpleRunnerEntrypoint(args);
    if (!runnerCommand) {
      return null;
    }

    if (isLegacyServerEntrypointToken(runnerCommand)) {
      return runnerCommand;
    }

    const runnerBaseName = commandTokenBaseName(runnerCommand);
    const runnerArgsStart = args.findIndex((token) => token === runnerCommand);
    const runnerArgs = runnerArgsStart === -1 ? [] : args.slice(runnerArgsStart + 1);

    if (runnerBaseName === 'tsx') {
      return extractTsxEntrypoint(runnerArgs);
    }

    if (runnerBaseName === 'node' || runnerBaseName === 'bun') {
      return extractInterpreterEntrypoint(runnerArgs);
    }
  }

  return null;
}

async function resolveLegacyProcessMetadata(command: string): Promise<{ mode: ServerMode; retrievalPath: string; } | null> {
  const homeDirectory = readCommandEnvironmentValue(command, 'HOME');
  if (!homeDirectory) {
    return null;
  }

  const appDirectory = join(homeDirectory, '.canary-alpha-mcp');
  const configPath = join(appDirectory, 'config.yaml');
  let mode: ServerMode = 'http';
  let retrievalPath = appDirectory;

  try {
    const rawConfig = await readFile(configPath, 'utf8');
    const parsedConfig = YAML.parse(rawConfig) as unknown;
    if (!isObjectRecord(parsedConfig)) {
      return { mode, retrievalPath };
    }

    const server = parsedConfig.server;
    if (isObjectRecord(server) && (server.mode === 'stdio' || server.mode === 'http')) {
      mode = server.mode;
    }

    const vectorStore = parsedConfig.vectorStore;
    if (isObjectRecord(vectorStore) && typeof vectorStore.path === 'string' && vectorStore.path.length > 0) {
      retrievalPath = vectorStore.path.startsWith('~/')
        ? join(homeDirectory, vectorStore.path.slice(2))
        : vectorStore.path;
    }
  } catch {
    return { mode, retrievalPath };
  }

  return { mode, retrievalPath };
}

async function findLegacyRuntimeProcesses(
  config: AppContext['config'],
  excludedPids: ReadonlySet<number>
): Promise<Array<{ mode: ServerMode; pid: number; }>> {
  try {
    const { stdout } = await execFileAsync('ps', ['axeww', '-o', 'pid=,command=']);
    const expectedRetrievalPath = normalizeRetrievalPath(resolveVectorStoreDirectory(config.vectorStore));
    const matches: Array<{ mode: ServerMode; pid: number; }> = [];

    for (const line of stdout
      .split('\n')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)) {
      const firstSpace = line.indexOf(' ');
      if (firstSpace === -1) {
        continue;
      }

      const pid = Number(line.slice(0, firstSpace).trim());
      const command = line.slice(firstSpace + 1);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || excludedPids.has(pid)) {
        continue;
      }

      const entrypoint = extractLegacyServerEntrypoint(command);
      if (!entrypoint || !isLegacyServerEntrypointToken(entrypoint)) {
        continue;
      }

      if (command.includes(' rebuild-index') || command.endsWith('rebuild-index')) {
        continue;
      }

      const metadata = await resolveLegacyProcessMetadata(command);
      const mode: ServerMode | null = command.includes('--mode http')
        ? 'http'
        : command.includes('--mode stdio')
          ? 'stdio'
          : metadata?.mode ?? null;
      if (!mode) {
        continue;
      }

      if (normalizeRetrievalPath(metadata?.retrievalPath ?? '') !== expectedRetrievalPath) {
        continue;
      }

      matches.push({ mode, pid });
    }

    return matches;
  } catch {
    return [];
  }
}

async function ensureRecoveryTargetIsOffline(config: AppContext['config']): Promise<void> {
  const activeProcesses = await findActiveRuntimeProcesses(config);
  const activeProcessPids = new Set(activeProcesses.map((record) => record.pid));
  const legacyProcesses = await findLegacyRuntimeProcesses(config, activeProcessPids);
  if (legacyProcesses.length > 0) {
    throw new Error(
      `Refusing to run rebuild-index while legacy MCP server processes are active for ${config.paths.configFile} (${legacyProcesses.map((record) => `${record.mode}:${record.pid}`).join(', ')}). Stop them first to avoid stale in-memory retrieval state being written back over rebuilt artifacts.`
    );
  }

  if (activeProcesses.length > 0) {
    const processSummary = activeProcesses
      .map((record) => `${record.mode}:${record.pid}`)
      .join(', ');
    throw new Error(
      `Refusing to run rebuild-index while live MCP server processes are active for retrieval artifacts at ${resolveVectorStoreDirectory(config.vectorStore)} (${processSummary}). Stop them first to avoid stale in-memory retrieval state being written back over rebuilt artifacts.`
    );
  }

  if (await detectActiveManagedService(config)) {
    throw new Error(
      `Refusing to run rebuild-index while the managed HTTP service is active for ${config.paths.configFile}. Stop the service first to avoid stale in-memory retrieval state being written back over rebuilt artifacts.`
    );
  }
}

async function replaceRecoveryArtifact(
  sourcePath: string,
  targetPath: string,
  backupPath: string
): Promise<{ replacedExisting: boolean; }> {
  await rm(backupPath, { force: true });

  let targetMoved = false;
  try {
    await rename(targetPath, backupPath);
    targetMoved = true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await rename(sourcePath, targetPath);
    return {
      replacedExisting: targetMoved
    };
  } catch (error) {
    if (targetMoved) {
      await rm(targetPath, { force: true }).catch(() => undefined);
      await rename(backupPath, targetPath).catch(() => undefined);
    }
    throw error;
  }
}

async function runRebuildIndex(): Promise<void> {
  const primaryApp = await createApp({
    startIndexingPoller: false
  });
  const rebuildLock = await acquireRebuildLock(primaryApp.config);

  try {
    await ensureRecoveryTargetIsOffline(primaryApp.config);
    const vectorStoreDirectory = resolveVectorStoreDirectory(primaryApp.config.vectorStore);
    const targetVectorStorePath = resolveVectorStoreFilePath(primaryApp.config.vectorStore);
    const targetCheckpointPath = join(vectorStoreDirectory, 'retrieval-checkpoint.json');

    const rebuildPath = join(vectorStoreDirectory, `.rebuild-index-${process.pid}-${Date.now()}`);
    const rebuiltVectorStorePath = join(rebuildPath, 'vector-store.json');
    const rebuiltCheckpointPath = join(rebuildPath, 'retrieval-checkpoint.json');
    const vectorStoreBackupPath = `${targetVectorStorePath}.bak`;
    const checkpointBackupPath = `${targetCheckpointPath}.bak`;

    await mkdir(rebuildPath, { recursive: true });

    const app = await createApp({
      mode: 'stdio',
      startIndexingPoller: false,
      vectorStorePath: rebuildPath
    });

    await app.services.retrieval.vectorStore.reset();
    await app.services.retrieval.checkpointStore.reset();

    const rebuildStartedAt = new Date();
    const fullHistoryBacklog = {
      from: '1970-01-01T00:00:00.000Z',
      to: rebuildStartedAt.toISOString(),
      nextOffset: 0
    };
    let firstCheckpointBefore: Awaited<ReturnType<AppContext['services']['retrieval']['checkpointStore']['readLatest']>> | null = null;
    let recordedCheckpointBefore = false;
    let finalResult: Awaited<ReturnType<AppContext['services']['retrieval']['indexing']['runOnce']>> | null = null;
    let totalFetched = 0;
    let totalIndexed = 0;
    let nextForcedBacklog: typeof fullHistoryBacklog | null = fullHistoryBacklog;

    try {
      while (nextForcedBacklog) {
        const previousOffset = nextForcedBacklog.nextOffset;
        const runResult = await app.services.retrieval.indexing.runOnce(
          rebuildStartedAt,
          nextForcedBacklog
        );
        if (runResult.hadEmbeddingFailures) {
          throw new Error(`rebuild-index detected embedding failures while rebuilding backlog page at offset ${previousOffset}. Resolve provider/data issues before retrying recovery.`);
        }
        if (!recordedCheckpointBefore) {
          firstCheckpointBefore = runResult.checkpointBefore;
          recordedCheckpointBefore = true;
        }
        finalResult = runResult;
        totalFetched += runResult.fetched;
        totalIndexed += runResult.indexed;

        const backlogAfter = runResult.checkpointAfter?.backlog ?? null;
        if (!backlogAfter) {
          nextForcedBacklog = null;
          break;
        }

        if (backlogAfter.nextOffset <= previousOffset) {
          throw new Error(`rebuild-index could not make progress beyond backlog offset ${previousOffset}.`);
        }

        nextForcedBacklog = backlogAfter;
      }

      if (!finalResult) {
        finalResult = await app.services.retrieval.indexing.runOnce(rebuildStartedAt, fullHistoryBacklog);
        if (!recordedCheckpointBefore) {
          firstCheckpointBefore = finalResult.checkpointBefore;
          recordedCheckpointBefore = true;
        }
        totalFetched += finalResult.fetched;
        totalIndexed += finalResult.indexed;
      }

      const rebuiltInspection = await app.services.retrieval.vectorStore.inspect?.();
      const rebuiltVectorStoreState = {
        persisted: rebuiltInspection?.persisted ?? false,
        readable: rebuiltInspection?.readable ?? true,
        recordCount: rebuiltInspection?.recordCount
      };

      await ensureRecoveryTargetIsOffline(primaryApp.config);

      const { replacedExisting: replacedExistingVectorStore } = await replaceRecoveryArtifact(
        rebuiltVectorStorePath,
        targetVectorStorePath,
        vectorStoreBackupPath
      );

      try {
        if (finalResult.checkpointAfter) {
          await replaceRecoveryArtifact(rebuiltCheckpointPath, targetCheckpointPath, checkpointBackupPath);
        } else {
          await rm(targetCheckpointPath, { force: true });
          await rm(rebuiltCheckpointPath, { force: true });
        }
      } catch (error) {
        if (replacedExistingVectorStore) {
          await replaceRecoveryArtifact(vectorStoreBackupPath, targetVectorStorePath, rebuiltVectorStorePath).catch(() => undefined);
        } else {
          await rm(targetVectorStorePath, { force: true }).catch(() => undefined);
          await rm(rebuiltVectorStorePath, { force: true }).catch(() => undefined);
          await rm(vectorStoreBackupPath, { force: true }).catch(() => undefined);
        }
        throw error;
      }

      await rm(vectorStoreBackupPath, { force: true }).catch(() => undefined);
      await rm(checkpointBackupPath, { force: true }).catch(() => undefined);

      process.stdout.write(`${JSON.stringify({
        command: 'rebuild-index',
        reset: ['vector-store.json', 'retrieval-checkpoint.json'],
        fetched: totalFetched,
        indexed: totalIndexed,
        checkpointBefore: formatCheckpoint(firstCheckpointBefore),
        checkpointAfter: formatCheckpoint(finalResult.checkpointAfter),
        recoveryStatus: getRecoveryStatus(finalResult.checkpointAfter, rebuiltVectorStoreState)
      }, null, 2)}\n`);
    } catch (error) {
      await rm(rebuildPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    await rm(rebuildPath, { recursive: true, force: true }).catch(() => undefined);
  } finally {
    await rebuildLock.release().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Short-circuit for the config subcommand before any heavy bootstrap (createApp) — spec I6.
  const firstPositional = argv.find((v) => !v.startsWith('--'));
  if (firstPositional === 'config') {
    // Slice from the config token so any preceding flags (e.g. --mode http) do not leak
    // as extra positional arguments into the config command parser.
    const configIndex = argv.indexOf('config');
    const code = await runConfigCommand(argv.slice(configIndex));
    process.exit(code);
  }

  const command = readCliCommand(argv);

  if (command === 'rebuild-index') {
    await runRebuildIndex();
    return;
  }

  const mode = readCliMode(argv);
  const app = await createApp({ mode, startIndexingPoller: false });
  await ensureRebuildLockNotHeld(app.config);
  const runtimeGuard = await registerRuntimeProcess(app.config);
  const releaseRuntimeGuardSync = (): void => {
    runtimeGuard.releaseSync();
  };
  const exitForSignal = (code: number): void => {
    releaseRuntimeGuardSync();
    process.exit(code);
  };
  process.once('exit', releaseRuntimeGuardSync);
  process.once('SIGINT', () => {
    exitForSignal(130);
  });
  process.once('SIGTERM', () => {
    exitForSignal(143);
  });
  await ensureRebuildLockNotHeld(app.config);
  startIndexingPoller(app);

  if (app.config.server.mode === 'http') {
    await startHttpTransport(app);
    return;
  }

  await startStdioTransport(app);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal startup error: ${message}`);
  process.exit(1);
});
