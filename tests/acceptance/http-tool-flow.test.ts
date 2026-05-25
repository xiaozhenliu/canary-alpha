import { afterEach, describe, expect, it } from 'vitest';

import {
  expectEvidenceId,
  expectFreshnessStatus,
  expectRawId,
  expectStructuredArtifact
} from '../helpers/acceptance-artifacts.js';
import { setupRetrievalWorkflowScenario } from '../helpers/acceptance-scenarios.js';
import { minusMinutes } from '../helpers/timestamps.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  delete process.env.HOME;

  while (cleanup.length > 0) {
    const task = cleanup.pop();
    if (task) {
      await task();
    }
  }
});

describe('http MCP tool flow', () => {
  it('serves retrieval tools with structured content over streamable HTTP', async () => {
    const scenario = await setupRetrievalWorkflowScenario({
      prefix: 'http-tool-flow-',
      mode: 'http',
      port: 8767,
      records: [
        {
          id: 'fixture-1',
          text: 'Claude retrieval fixture note over HTTP',
          timestamp: minusMinutes(5),
          appName: 'Claude'
        }
      ]
    });
    cleanup.push(() => scenario.cleanup());

    const connection = await scenario.connect();
    cleanup.push(() => connection.close());

    const searchResult = await connection.client.callTool({
      name: 'search-screen',
      arguments: {
        query: 'fixture',
        mode: 'hybrid',
        appName: 'Claude'
      }
    });

    const searchStructured = expectStructuredArtifact<{
      summary: string;
      evidence: Array<{ id: string; text: string; source: string }>;
      freshness?: { status: string };
    }>(searchResult);

    expect(searchStructured.summary).toContain('fixture');
    expectEvidenceId(searchStructured, 'fixture-1');
    expectFreshnessStatus(searchStructured);

    scenario.addRecord({
      id: 'fixture-2',
      text: 'New HTTP retrieval fixture arrived from acceptance harness',
      timestamp: minusMinutes(1),
      appName: 'FixtureApp'
    });

    const recentResult = await connection.client.callTool({
      name: 'recent-activity',
      arguments: {
        minutes: 10,
        format: 'raw'
      }
    });

    const recentStructured = expectStructuredArtifact<{
      summary: string;
      evidence: Array<{ id: string }>;
      raw?: Array<{ id: string }>;
    }>(recentResult);

    expect(recentStructured.summary).toContain('Recent activity returned');
    expectEvidenceId(recentStructured, 'fixture-2');
    expectRawId(recentStructured, 'fixture-2');
  });
});
