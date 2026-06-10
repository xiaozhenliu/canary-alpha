export function parseDuration(text: string): number;

export function parseLiveRunArgs(argv?: string[]): {
  durationMs: number;
  indexTimeoutMs: number;
};
