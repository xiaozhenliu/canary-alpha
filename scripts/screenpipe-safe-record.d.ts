// OCR recognition language names. MUST stay in sync with ocrLanguageSchema in
// src/config/schema.ts (a consistency test guards drift). Declared here (rather
// than imported from src) because tsconfig only includes scripts/**/*.d.ts.
export type OcrLanguage =
  | 'english' | 'chinese' | 'japanese' | 'korean' | 'french' | 'german'
  | 'spanish' | 'russian' | 'portuguese' | 'italian' | 'arabic';

export const DEFAULT_OCR_LANGUAGES: OcrLanguage[];
export const OCR_LANGUAGE_ALLOWLIST: Set<OcrLanguage>;
export function readOcrLanguagesFromConfig(configPath?: string): Promise<OcrLanguage[]>;
export function readScreenpipeRuntimeConfig(configPath?: string): Promise<{
  url: string;
  binaryPath: string;
  dataDirectory: string;
}>;
export function buildScreenpipeSafeRecordArgs(argv?: string[], ocrLanguages?: OcrLanguage[]): string[];
export function buildScreenpipeRuntimeArgs(argv: string[], dataDirectory: string, baseUrl?: string): string[];
export function readScreenpipeDataDirectoryArg(argv: string[]): string | undefined;
export function killProcessGroup(pid: number, signal?: NodeJS.Signals): void;
export function writeMaintenanceLogEntry(
  entry: Record<string, unknown>,
  options?: { logPath?: string; now?: Date }
): Promise<void>;
export function run(
  argv?: string[],
  options?: {
    command?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    // Pre-resolved, allowlisted languages. Typed as OcrLanguage[] so a TS caller
    // cannot inject an unknown language that would bypass readOcrLanguagesFromConfig's validation.
    ocrLanguages?: OcrLanguage[];
    runtimeConfig?: {
      url: string;
      binaryPath: string;
      dataDirectory: string;
    };
  }
): Promise<void>;
