import type { IndexedCheckpoint, FreshnessPolicy, FreshnessStatus } from './types.js';

export interface FreshnessPolicyOptions {
  freshnessWindowMinutes: number;
}

function getLagMinutes(checkpoint: IndexedCheckpoint | null, now: Date): number | null {
  if (!checkpoint) {
    return null;
  }

  const checkpointTime = new Date(checkpoint.timestamp);
  const lagMs = now.getTime() - checkpointTime.getTime();
  return Math.max(0, Math.floor(lagMs / 60_000));
}

export class RetrievalFreshnessPolicy implements FreshnessPolicy {
  constructor(private readonly options: FreshnessPolicyOptions) {}

  evaluate(checkpoint: IndexedCheckpoint | null, now = new Date()): FreshnessStatus {
    const lagMinutes = getLagMinutes(checkpoint, now);
    const windowMinutes = this.options.freshnessWindowMinutes;

    if (!checkpoint) {
      return {
        status: 'stale-beyond-window',
        lagMinutes,
        windowMinutes,
        checkpoint
      };
    }

    if (checkpoint.backlog) {
      return {
        status: 'stale-catchup-allowed',
        lagMinutes,
        windowMinutes,
        checkpoint
      };
    }

    if ((lagMinutes ?? 0) <= windowMinutes) {
      return {
        status: 'fresh',
        lagMinutes,
        windowMinutes,
        checkpoint
      };
    }

    if ((lagMinutes ?? 0) <= windowMinutes * 2) {
      return {
        status: 'stale-catchup-allowed',
        lagMinutes,
        windowMinutes,
        checkpoint
      };
    }

    return {
      status: 'stale-beyond-window',
      lagMinutes,
      windowMinutes,
      checkpoint
    };
  }
}

export function createFreshnessPolicy(options: FreshnessPolicyOptions): FreshnessPolicy {
  return new RetrievalFreshnessPolicy(options);
}
