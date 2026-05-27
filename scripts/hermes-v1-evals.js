#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import YAML from 'yaml';

import { startEmbeddingStub } from '../tests/helpers/embedding-stub.ts';
import { startScreenpipeStub } from '../tests/helpers/screenpipe-stub.ts';
import { startHttpServer } from '../tests/helpers/start-http-server.ts';
import { writeTestConfig } from '../tests/helpers/test-config.ts';
import { V1_EVALUATION_TASKS } from '../tests/evaluations/v1-evaluation-manifest.ts';
import { testTempRoot } from './test-tmp.js';

const execFileAsync = promisify(execFile);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const evidenceDirectory = join(repositoryRoot, '.planning', 'evaluations', 'v1-hermes');
const hermesCommand = 'hermes';
const hermesServerName = 'screenpipe-memory-v1-evals';
const FIXTURE_NOW = new Date('2026-04-13T12:00:00.000Z');

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function minusFixtureMinutes(minutes) {
  return new Date(FIXTURE_NOW.getTime() - minutes * 60_000).toISOString();
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
}

async function writeEvidenceFile(fileName, content) {
  await ensureDirectory(evidenceDirectory);
  await writeFile(join(evidenceDirectory, fileName), content, 'utf8');
}

async function probeEndpoint(host, port) {
  const response = await fetch(`http://${host}:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'v1-evals-health', method: 'ping' })
  });

  return {
    status: response.status,
    body: await response.text()
  };
}

async function runHermes(args, options = {}) {
  return execFileAsync(hermesCommand, args, {
    cwd: repositoryRoot,
    env: options.env ?? process.env,
    timeout: options.timeout ?? 180_000,
    maxBuffer: 10 * 1024 * 1024
  });
}

async function detectHermes() {
  try {
    const result = await runHermes(['--version'], { timeout: 30_000 });
    return (result.stdout || result.stderr || '').trim() || 'unknown';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Hermes CLI is not available. Install or expose 'hermes' on PATH before running the v1 evaluation layer. (${detail})`);
  }
}

function buildIsolatedHermesConfig(endpoint) {
  return YAML.stringify({
    model: '',
    provider: 'auto',
    mcp_servers: {
      [hermesServerName]: {
        url: endpoint,
        enabled: true,
        tools: {
          include: ['internal-status', 'search-screen', 'recent-activity', 'memory-read', 'memory-write']
        }
      }
    }
  });
}

async function createIsolatedHermesHome(endpoint) {
  const tempHome = await mkdtemp(join(testTempRoot(), 'screenpipe-memory-v1-evals-hermes-'));
  await ensureDirectory(join(tempHome, '.hermes'));
  await writeFile(join(tempHome, '.hermes', 'config.yaml'), buildIsolatedHermesConfig(endpoint), 'utf8');
  return tempHome;
}

function buildFixtureRecords() {
  return [
    {
      id: 'eval-recent-1',
      text: 'Recent activity fixture for evaluation status checks',
      timestamp: minusFixtureMinutes(1),
      appName: 'Claude'
    },
    {
      id: 'eval-search-1',
      text: 'Budget planning evaluation note for retrieval summary coverage',
      timestamp: minusFixtureMinutes(15),
      appName: 'Finance'
    },
    {
      id: 'eval-refine-1',
      text: 'Action item evaluation note that survives refinement',
      timestamp: minusFixtureMinutes(20),
      appName: 'Meetings'
    },
    {
      id: 'eval-fallback-1',
      text: 'Fallback failure evaluation keyword record for degraded recovery coverage',
      timestamp: minusFixtureMinutes(90),
      appName: 'Claude'
    }
  ];
}

async function setupControlledEnvironment() {
  const homeDir = await mkdtemp(join(testTempRoot(), 'screenpipe-memory-v1-evals-'));
  const port = 8791;

  const screenpipe = await startScreenpipeStub({
    records: buildFixtureRecords()
  });

  const embedding = await startEmbeddingStub({
    failOnInputs: ['fallback failure evaluation']
  });

  await writeTestConfig(homeDir, {
    embeddingBaseUrl: embedding.url,
    screenpipeBaseUrl: screenpipe.url,
    mode: 'http',
    port
  });

  const checkpointDir = join(homeDir, '.canary-alpha-mcp');
  await ensureDirectory(checkpointDir);
  await writeFile(
    join(checkpointDir, 'retrieval-checkpoint.json'),
    JSON.stringify({
      cursor: 'v1-evals-checkpoint',
      timestamp: minusFixtureMinutes(1)
    }, null, 2),
    'utf8'
  );

  const memoryDirectory = join(homeDir, '.canary-alpha-mcp', 'memory');
  await ensureDirectory(memoryDirectory);
  await writeFile(join(memoryDirectory, 'memory.md'), 'seed-memory-prefix', 'utf8');

  const server = await startHttpServer(port, { HOME: homeDir });

  return {
    endpoint: `http://127.0.0.1:${server.port}/mcp`,
    homeDir,
    server,
    async cleanup() {
      await Promise.allSettled([
        server.stop(),
        screenpipe.stop(),
        embedding.stop()
      ]);
      await rm(homeDir, { recursive: true, force: true });
    }
  };
}

function findMissingTokens(transcript, tokens, options = {}) {
  const haystack = options.caseInsensitive ? transcript.toLowerCase() : transcript;
  return tokens.filter((token) => !haystack.includes(options.caseInsensitive ? token.toLowerCase() : token));
}

async function main() {
  await ensureDirectory(evidenceDirectory);

  const hermesVersion = await detectHermes();
  await writeEvidenceFile('hermes-version.txt', `${hermesVersion}\n`);

  const environment = await setupControlledEnvironment();
  const isolatedHome = await createIsolatedHermesHome(environment.endpoint);
  const hermesEnv = {
    ...process.env,
    HOME: isolatedHome
  };

  try {
    await writeEvidenceFile('hermes-config.yaml', await readFile(join(isolatedHome, '.hermes', 'config.yaml'), 'utf8'));

    const endpointProbe = await probeEndpoint('127.0.0.1', environment.server.port).catch((error) => {
      throw new Error(`Evaluation HTTP server is not reachable at ${environment.endpoint}. ${error instanceof Error ? error.message : String(error)}`);
    });
    await writeEvidenceFile('endpoint-probe.json', `${JSON.stringify({ endpoint: environment.endpoint, probe: endpointProbe }, null, 2)}\n`);

    const listResult = await runHermes(['mcp', 'list'], { env: hermesEnv, timeout: 60_000 });
    await writeEvidenceFile('hermes-mcp-list.txt', listResult.stdout || listResult.stderr || '');

    const testResult = await runHermes(['mcp', 'test', hermesServerName], { env: hermesEnv, timeout: 120_000 });
    await writeEvidenceFile('hermes-mcp-test.txt', [testResult.stdout, testResult.stderr].filter(Boolean).join('\n'));

    const summary = [];

    for (const task of V1_EVALUATION_TASKS) {
      let outcome = 'passed';
      let transcript = '';
      let errorMessage = '';
      let missingTranscriptTokens = [];
      let missingToolMarkers = [];

      try {
        const result = await runHermes([
          'chat',
          '--quiet',
          '--max-turns',
          String(task.maxTurns),
          '--toolsets',
          hermesServerName,
          '--query',
          task.query
        ], {
          env: hermesEnv,
          timeout: 240_000
        });
        transcript = [result.stdout, result.stderr].filter(Boolean).join('\n');
      } catch (error) {
        outcome = 'blocked';
        const stdout = typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout ?? '') : '';
        const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr ?? '') : '';
        errorMessage = error instanceof Error ? error.message : String(error);
        transcript = [stdout, stderr, errorMessage].filter(Boolean).join('\n');
      }

      missingTranscriptTokens = findMissingTokens(transcript, task.requiredTranscriptTokens, {
        caseInsensitive: true
      });
      missingToolMarkers = findMissingTokens(transcript, task.requiredToolMarkers);
      if (outcome === 'passed' && (missingTranscriptTokens.length > 0 || missingToolMarkers.length > 0)) {
        outcome = 'failed';
        errorMessage = [
          missingTranscriptTokens.length > 0
            ? `Missing transcript tokens: ${missingTranscriptTokens.join(', ')}`
            : '',
          missingToolMarkers.length > 0
            ? `Missing tool markers: ${missingToolMarkers.join(', ')}`
            : ''
        ].filter(Boolean).join(' | ');
      }

      await writeEvidenceFile(task.evidenceFile, `${transcript}\n`);

      summary.push({
        id: task.id,
        goal: task.goal,
        transportProfile: task.transportProfile,
        topology: task.topology,
        fixtureDependencyMode: task.fixtureDependencyMode,
        maxTurns: task.maxTurns,
        evidenceFile: task.evidenceFile,
        requiredTranscriptTokens: task.requiredTranscriptTokens,
        requiredToolMarkers: task.requiredToolMarkers,
        missingTranscriptTokens,
        missingToolMarkers,
        outcome,
        errorMessage
      });
    }

    await writeEvidenceFile('SUMMARY.json', `${JSON.stringify({
      hermesVersion,
      endpoint: environment.endpoint,
      fixtureNow: FIXTURE_NOW.toISOString(),
      tasks: summary
    }, null, 2)}\n`);

    const failedTasks = summary.filter((task) => task.outcome !== 'passed');
    if (failedTasks.length > 0) {
      fail(`Focused v1 real-agent evaluations failed. See ${join(evidenceDirectory, 'SUMMARY.json')} for details.`);
    }
  } finally {
    await Promise.allSettled([
      rm(isolatedHome, { recursive: true, force: true }),
      environment.cleanup()
    ]);
  }

  console.log('Focused v1 real-agent evaluations passed.');
  console.log(`- evidence: ${evidenceDirectory}`);
}

await main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
