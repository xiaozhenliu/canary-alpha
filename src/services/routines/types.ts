export type RoutineRunStatus = 'success' | 'failed' | 'skipped';

export interface RoutineDefinition {
  name: string;
  schedule: string;
  enabled: boolean;
  prompt: string;
  recentActivityMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineRunError {
  message: string;
}

export interface RoutineRunRecord {
  runId: string;
  name: string;
  startedAt: string;
  completedAt: string;
  status: RoutineRunStatus;
  summary: string;
  output: string;
  error?: RoutineRunError;
}

export interface RoutineStore {
  listDefinitions(): Promise<RoutineDefinition[]>;
  readDefinition(name: string): Promise<RoutineDefinition | undefined>;
  writeDefinition(definition: RoutineDefinition): Promise<boolean>;
  appendRun(record: RoutineRunRecord): Promise<void>;
  listRuns(name: string, limit: number): Promise<RoutineRunRecord[]>;
}
