export interface LineStats {
  total: number;
  code: number;
  comment: number;
  blank: number;
}

export interface FileStat extends LineStats {
  path: string;
  module: string;
  language: string;
  extension: string;
}

export interface GroupStats extends LineStats {
  name: string;
  files: number;
}

export interface ProjectStats {
  summary: LineStats & { files: number };
  byModule: GroupStats[];
  byLanguage: GroupStats[];
  byDirectory: GroupStats[];
  topFiles: FileStat[];
  allFiles: FileStat[];
  excludedRules: string[];
}

export interface ScanOptions {
  topCount?: number;
  includeAllFiles?: boolean;
}

export function countLines(content: string, ext: string): LineStats;
export function isExcludedFile(relativePath: string): boolean;
export function getModuleCategory(relativePath: string): { module: string; description: string };
export function collectSourceFiles(rootDir: string, scanRoots?: string[]): Promise<string[]>;
export function analyzeProject(rootDir: string, options?: ScanOptions): Promise<ProjectStats>;
export function formatMarkdownReport(stats: ProjectStats): string;
export function formatTerminalReport(stats: ProjectStats): string;
