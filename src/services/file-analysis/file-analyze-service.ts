import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import type {
  FileAnalyzeEvidenceItem,
  FileAnalyzeFileInfo,
  FileAnalyzeFileReader,
  FileAnalyzeRequest,
  FileAnalyzeResult,
  FileAnalyzeService,
  FileAnalyzeValidationError
} from './types.js';

const SUPPORTED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.txt',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.xml'
] as const;

const QUESTION_TOKEN_PATTERN = /[\p{L}\p{M}\p{N}_]+/gu;
const ASCII_TOKEN_PATTERN = /^[a-z0-9_]+$/i;
const CJK_TOKEN_PATTERN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
const ASCII_SEGMENT_PATTERN = /[a-z0-9_]+/g;
const CJK_CHARACTER_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_SEGMENT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

function splitLines(content: string): string[] {
  if (content === '') {
    return [];
  }

  const lines = content.split(/\r?\n/);
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

function normalizeTokens(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function normalizeQuestionText(value: string): string {
  return value
    .replace(/^(?:請問|请问)\s*/u, '')
    .replace(/^(?:哪里提到|哪裡提到)\s*/u, '')
    .replace(/[？?！!]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function expandPureCjkToken(token: string): string[] {
  const characters = Array.from(token);
  if (characters.length <= 1) {
    return [token];
  }

  const expanded = new Set<string>([token]);
  const containsHan = /\p{Script=Han}/u.test(token);
  const minimumSize = containsHan ? 1 : 2;
  for (let size = minimumSize; size <= Math.min(4, characters.length); size += 1) {
    for (let start = 0; start <= characters.length - size; start += 1) {
      expanded.add(characters.slice(start, start + size).join(''));
    }
  }

  return [...expanded];
}

function expandPureCjkQuestionToken(token: string): string[] {
  const characters = Array.from(token);
  if (characters.length <= 1) {
    return [token];
  }

  const expanded = new Set<string>([token]);
  for (let size = 2; size <= Math.min(4, characters.length); size += 1) {
    for (let start = 0; start <= characters.length - size; start += 1) {
      expanded.add(characters.slice(start, start + size).join(''));
    }
  }

  return [...expanded];
}

function countNonMarkCodePoints(token: string): number {
  return Array.from(token.normalize('NFC')).filter((character) => !/^\p{M}$/u.test(character)).length;
}

function hasMinimumNonCjkTokenLength(token: string): boolean {
  return countNonMarkCodePoints(token) >= 3;
}

function expandToken(token: string): string[] {
  if (ASCII_TOKEN_PATTERN.test(token)) {
    return token.length >= 3 ? [token] : [];
  }

  if (CJK_TOKEN_PATTERN.test(token)) {
    return expandPureCjkToken(token);
  }

  if (!CJK_CHARACTER_PATTERN.test(token)) {
    return hasMinimumNonCjkTokenLength(token) ? [token] : [];
  }

  const expanded = new Set<string>([token]);
  for (const asciiSegment of token.match(ASCII_SEGMENT_PATTERN) ?? []) {
    if (asciiSegment.length >= 3) {
      expanded.add(asciiSegment);
    }
  }

  for (const segment of token.match(CJK_SEGMENT_PATTERN) ?? []) {
    for (const expandedSegment of expandPureCjkToken(segment)) {
      expanded.add(expandedSegment);
    }

    if (/\p{Script=Han}/u.test(segment)) {
      for (const character of Array.from(segment)) {
        expanded.add(character);
      }
    }
  }

  return [...expanded];
}

function expandQuestionToken(token: string): string[] {
  if (ASCII_TOKEN_PATTERN.test(token)) {
    return token.length >= 3 ? [token] : [];
  }

  if (CJK_TOKEN_PATTERN.test(token)) {
    return expandPureCjkQuestionToken(token);
  }

  if (!CJK_CHARACTER_PATTERN.test(token)) {
    return hasMinimumNonCjkTokenLength(token) ? [token] : [];
  }

  const expanded = new Set<string>([token]);
  for (const asciiSegment of token.match(ASCII_SEGMENT_PATTERN) ?? []) {
    if (asciiSegment.length >= 3) {
      expanded.add(asciiSegment);
    }
  }

  for (const segment of token.match(CJK_SEGMENT_PATTERN) ?? []) {
    for (const expandedSegment of expandPureCjkQuestionToken(segment)) {
      expanded.add(expandedSegment);
    }
  }

  return [...expanded];
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      (normalizeTokens(value).toLowerCase().match(QUESTION_TOKEN_PATTERN) ?? [])
        .flatMap((token) => expandToken(token))
    )
  );
}

function tokenizeQuestion(value: string): string[] {
  const normalizedQuestion = normalizeQuestionText(normalizeTokens(value).toLowerCase());
  return Array.from(
    new Set(
      (normalizedQuestion.match(QUESTION_TOKEN_PATTERN) ?? [])
        .flatMap((token) => expandQuestionToken(token))
    )
  );
}

function buildSummary(file: FileAnalyzeFileInfo): string {
  return `${file.name} is a supported ${file.extension} file with ${file.lineCount} line(s).`;
}

function buildValidationError(code: FileAnalyzeValidationError['code'], message: string): FileAnalyzeValidationError {
  return { code, message };
}

function buildErrorResult(error: FileAnalyzeValidationError): FileAnalyzeResult {
  return {
    summary: error.message,
    highlights: [],
    evidence: [],
    error
  };
}

function extractHighlights(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);
}

function scoreLine(line: string, questionTokens: string[]): number {
  if (questionTokens.length === 0) {
    return 0;
  }

  const lineTokens = new Set(tokenize(line));
  return questionTokens.reduce((score, token) => score + (lineTokens.has(token) ? 1 : 0), 0);
}

function buildEvidence(lines: string[], question: string): FileAnalyzeEvidenceItem[] {
  const questionTokens = tokenizeQuestion(question);

  return lines
    .map((line, index) => ({
      lineNumber: index + 1,
      text: line.trim(),
      score: scoreLine(line, questionTokens)
    }))
    .filter((item) => item.text.length > 0 && item.score > 0)
    .sort((left, right) => right.score - left.score || left.lineNumber - right.lineNumber)
    .slice(0, 5);
}

export class DefaultFileAnalyzeService implements FileAnalyzeService {
  constructor(private readonly fileReader: FileAnalyzeFileReader = { stat, readFile }) {}

  async analyze(request: FileAnalyzeRequest): Promise<FileAnalyzeResult> {
    const resolvedPath = resolve(request.path);
    const extension = extname(resolvedPath).toLowerCase();

    let fileStats;
    try {
      fileStats = await this.fileReader.stat(resolvedPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return buildErrorResult(buildValidationError('FILE_NOT_FOUND', `File not found: ${request.path}`));
      }

      return buildErrorResult(buildValidationError('FILE_READ_FAILED', `Unable to inspect file: ${request.path}`));
    }

    if (fileStats.isDirectory()) {
      return buildErrorResult(buildValidationError('PATH_IS_DIRECTORY', `Path is a directory, not a file: ${request.path}`));
    }

    if (!SUPPORTED_EXTENSIONS.includes(extension as (typeof SUPPORTED_EXTENSIONS)[number])) {
      return buildErrorResult(buildValidationError(
        'UNSUPPORTED_EXTENSION',
        `Unsupported file type: ${extension || '(no extension)'}. Supported extensions: ${SUPPORTED_EXTENSIONS.join(', ')}`
      ));
    }

    let rawContent;
    try {
      rawContent = await this.fileReader.readFile(resolvedPath);
    } catch {
      return buildErrorResult(buildValidationError('FILE_READ_FAILED', `Unable to read file: ${request.path}`));
    }

    if (rawContent.includes(0)) {
      return buildErrorResult(buildValidationError('BINARY_CONTENT', `Unsupported text input: ${request.path} contains binary content.`));
    }

    const content = rawContent.toString('utf8');
    const lines = splitLines(content);
    const file: FileAnalyzeFileInfo = {
      path: resolvedPath,
      name: basename(resolvedPath),
      extension,
      lineCount: lines.length
    };
    const summary = buildSummary(file);
    const highlights = extractHighlights(lines);

    if (!request.question) {
      return {
        summary,
        highlights,
        evidence: [],
        file
      };
    }

    const evidence = buildEvidence(lines, request.question);
    return {
      summary,
      answer: evidence[0]?.text ?? 'No matching content found for the provided question.',
      highlights,
      evidence,
      file
    };
  }
}
