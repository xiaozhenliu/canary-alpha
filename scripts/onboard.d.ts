export interface RecentActivityValidationSummary {
  resultCount: number;
  itemIds: string[];
}

export interface SearchScreenValidationSummary {
  searchResultCount: number;
  searchItemIds: string[];
  searchStatus: string;
}

export interface ValidationToolCallSummary extends RecentActivityValidationSummary, SearchScreenValidationSummary {
  status: unknown;
}

export interface ValidationToolClient {
  callTool(request: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{
    structuredContent?: unknown;
  }>;
}

export interface JsonProbeResult {
  ok: boolean;
  status?: number | null;
  body?: string;
  error?: string;
}

export interface OllamaModelProbeSummary {
  available: boolean;
  reason: string;
}

export function askSecret(question: string, fallback?: string, options?: {
  visiblePrompt?: (question: string, fallback?: string) => Promise<string>;
  inputIsTTY?: boolean;
  outputIsTTY?: boolean;
}): Promise<string>;
export function createSearchScreenWindow(now?: Date): {
  from: string;
  to: string;
};
export function summarizeRecentActivityValidation(structuredContent: unknown): RecentActivityValidationSummary;
export function summarizeSearchScreenValidation(structuredContent: unknown): SearchScreenValidationSummary;
export function summarizeOllamaModelProbe(probe: JsonProbeResult, model: string): OllamaModelProbeSummary;
export function runValidationToolCalls(client: ValidationToolClient, now?: Date): Promise<ValidationToolCallSummary>;
