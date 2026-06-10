export function buildScreenpipeSafeRecordArgs(argv?: string[]): string[];
export function killProcessGroup(pid: number, signal?: NodeJS.Signals): void;
export function run(
  argv?: string[],
  options?: {
    command?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }
): Promise<void>;
