import { afterEach, describe, expect, it } from 'vitest';

import {
  expectEvidenceId,
  expectFreshnessStatus,
  expectRawId,
  expectStructuredArtifact
} from '../helpers/acceptance-artifacts.js';
import { setupRetrievalWorkflowScenario } from '../helpers/acceptance-scenarios.js';
import { minusMinutes } from '../helpers/timestamps.js';

describe('retrieval core acceptance', () => {
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

  it('retrieves search and recent activity results through a real MCP stdio client', async () => {
    const scenario = await setupRetrievalWorkflowScenario({
      prefix: 'retrieval-acceptance-',
      mode: 'stdio',
      records: [
        {
          id: 'fixture-1',
          text: 'Claude retrieval fixture note',
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
      text: 'New retrieval fixture arrived from acceptance harness',
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

