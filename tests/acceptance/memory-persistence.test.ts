import { afterEach, describe, expect, it } from 'vitest';

import { expectStructuredArtifact } from '../helpers/acceptance-artifacts.js';
import { setupMemoryWorkflowScenario } from '../helpers/acceptance-scenarios.js';

describe('memory persistence acceptance', () => {
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

  it('persists memory and user scopes across real MCP stdio client reconnects', async () => {
    const scenario = await setupMemoryWorkflowScenario({
      prefix: 'memory-persistence-'
    });
    cleanup.push(() => scenario.cleanup());

    const firstConnection = await scenario.connect();
    try {
      await firstConnection.client.callTool({
        name: 'memory-write',
        arguments: {
          scope: 'memory',
          content: 'persistent memory note',
          mode: 'append'
        }
      });

      await firstConnection.client.callTool({
        name: 'memory-write',
        arguments: {
          scope: 'user',
          content: 'persistent user preference',
          mode: 'append'
        }
      });
    } finally {
      await firstConnection.close();
    }

    const secondConnection = await scenario.connect();
    cleanup.push(() => secondConnection.close());

    const readResult = await secondConnection.client.callTool({
      name: 'memory-read',
      arguments: {
        scope: 'all'
      }
    });

    const structured = expectStructuredArtifact<{
      scope: string;
      content: string;
      memory: string;
      user: string;
    }>(readResult);

    expect(structured.scope).toBe('all');
    expect(structured.memory).toContain('persistent memory note');
    expect(structured.user).toContain('persistent user preference');
    expect(structured.content).toContain('memory:\npersistent memory note');
    expect(structured.content).toContain('user:\npersistent user preference');
  });
});

