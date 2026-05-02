export function buildScreenpipeSafeRecordArgs(argv?: string[]): string[];
export function run(
  argv?: string[],
  options?: {
    command?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }
): Promise<void>;
