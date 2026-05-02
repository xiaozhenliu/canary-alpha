import { describe, expect, it } from 'vitest';

import { createFreshnessPolicy } from '../../../src/services/retrieval/freshness-policy.js';

describe('retrieval freshness policy unit', () => {
  const policy = createFreshnessPolicy({ freshnessWindowMinutes: 15 });
  const now = new Date('2026-04-13T12:00:00.000Z');

  it('treats a missing checkpoint as stale beyond the window', () => {
    const result = policy.evaluate(null, now);

    expect(result).toMatchObject({
      status: 'stale-beyond-window',
      lagMinutes: null,
      windowMinutes: 15,
      checkpoint: null
    });
  });

  it('classifies a checkpoint inside the freshness window as fresh', () => {
    const result = policy.evaluate(
      {
        cursor: 'fresh-cursor',
        timestamp: '2026-04-13T11:50:00.000Z'
      },
      now
    );

    expect(result.status).toBe('fresh');
    expect(result.lagMinutes).toBe(10);
  });

  it('treats backlog checkpoints as catchup allowed even when otherwise fresh', () => {
    const result = policy.evaluate(
      {
        cursor: 'backlog-cursor',
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

  it('allows catchup for checkpoints inside the recovery threshold', () => {
    const result = policy.evaluate(
      {
        cursor: 'catchup-cursor',
        timestamp: '2026-04-13T11:40:00.000Z'
      },
      now
    );

    expect(result.status).toBe('stale-catchup-allowed');
    expect(result.lagMinutes).toBe(20);
  });

  it('marks checkpoints beyond twice the freshness window as stale beyond window', () => {
    const result = policy.evaluate(
      {
        cursor: 'stale-cursor',
        timestamp: '2026-04-13T11:20:00.000Z'
      },
      now
    );

    expect(result.status).toBe('stale-beyond-window');
    expect(result.lagMinutes).toBe(40);
  });
});
