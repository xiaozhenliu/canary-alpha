import type { Stats } from 'node:fs';

export interface FileAnalyzeRequest {
  path: string;
  question?: string;
}

export interface FileAnalyzeEvidenceItem {
  lineNumber: number;
  text: string;
  score: number;
}

export interface FileAnalyzeFileInfo {
  path: string;
  name: string;
  extension: string;
  lineCount: number;
}

export interface FileAnalyzeValidationError {
  code: 'FILE_NOT_FOUND' | 'PATH_IS_DIRECTORY' | 'UNSUPPORTED_EXTENSION' | 'BINARY_CONTENT' | 'FILE_READ_FAILED';
  message: string;
}

export interface FileAnalyzeResult {
  summary: string;
  answer?: string;
  highlights: string[];
  evidence: FileAnalyzeEvidenceItem[];
  file?: FileAnalyzeFileInfo;
  error?: FileAnalyzeValidationError;
}

export interface FileAnalyzeService {
  analyze(request: FileAnalyzeRequest): Promise<FileAnalyzeResult>;
}

export interface FileAnalyzeFileReader {
  stat(filePath: string): Promise<Stats>;
  readFile(filePath: string): Promise<Buffer>;
}
