import { describe, expect, it } from 'vitest';

import { createFreshnessPolicy } from '../../../src/services/retrieval/freshness-policy.js';

describe('retrieval freshness policy', () => {
  const policy = createFreshnessPolicy({
    freshnessWindowMinutes: 15
  });

  it('classifies a recent checkpoint as fresh', () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    const result = policy.evaluate(
      {
        cursor: 'cursor-1',
        timestamp: '2026-04-13T11:50:00.000Z'
      },
      now
    );

    expect(result.status).toBe('fresh');
    expect(result.lagMinutes).toBe(10);
    expect(result.windowMinutes).toBe(15);
  });

  it('classifies a slightly stale checkpoint as stale-catchup-allowed', () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    const result = policy.evaluate(
      {
        cursor: 'cursor-2',
        timestamp: '2026-04-13T11:40:00.000Z'
      },
      now
    );

    expect(result.status).toBe('stale-catchup-allowed');
    expect(result.lagMinutes).toBe(20);
  });

  it('classifies a far-behind checkpoint as stale-beyond-window', () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    const result = policy.evaluate(
      {
        cursor: 'cursor-3',
        timestamp: '2026-04-13T11:20:00.000Z'
      },
      now
    );

    expect(result.status).toBe('stale-beyond-window');
    expect(result.lagMinutes).toBe(40);
  });

  it('treats a missing checkpoint as stale-beyond-window', () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    const result = policy.evaluate(null, now);

    expect(result.status).toBe('stale-beyond-window');
    expect(result.checkpoint).toBeNull();
    expect(result.lagMinutes).toBeNull();
  });

  it('treats an unfinished backlog as stale-catchup-allowed even within the freshness window', () => {
    const now = new Date('2026-04-13T12:00:00.000Z');
    const result = policy.evaluate(
      {
        cursor: 'cursor-4',
        timestamp: '2026-04-13T11:58:00.000Z',
        backlog: {
          from: '2026-04-13T11:45:00.000Z',
          to: '2026-04-13T12:00:00.000Z',
          nextOffset: 2
        }
      },
      now
    );

    expect(result.status).toBe('stale-catchup-allowed');
    expect(result.lagMinutes).toBe(2);
    expect(result.checkpoint?.backlog?.nextOffset).toBe(2);
  });
});
