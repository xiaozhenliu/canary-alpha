import { describe, expect, it } from 'vitest';

import {
  classifyPath,
  classifyPaths,
  globToRegExp,
  parseManifest
} from '../../scripts/public-release-classify.js';

const SAMPLE_MANIFEST = `
include README.md
exclude src/private/**
include src/**
exclude docs/guide/internal/**
include docs/guide/**
`;

describe('public release classifier', () => {
  it('matches glob patterns against repository paths', () => {
    expect(globToRegExp('src/**').test('src/index.ts')).toBe(true);
    expect(globToRegExp('src/**').test('src/nested/file.ts')).toBe(true);
    expect(globToRegExp('README.md').test('README.md')).toBe(true);
    expect(globToRegExp('PRD_*').test('PRD_canary_alpha_mcp_5.md')).toBe(true);
  });

  it('classifies paths using first matching manifest rule', () => {
    const rules = parseManifest(SAMPLE_MANIFEST);
    expect(classifyPath('README.md', rules)).toBe('include');
    expect(classifyPath('src/index.ts', rules)).toBe('include');
    expect(classifyPath('src/private/secret.ts', rules)).toBe('exclude');
    expect(classifyPath('docs/guide/quickstart.md', rules)).toBe('include');
    expect(classifyPath('docs/guide/internal/notes.md', rules)).toBe('exclude');
    expect(classifyPath('unlisted.txt', rules)).toBe('unclassified');
  });

  it('partitions paths into approved, excluded, and unclassified buckets', () => {
    const rules = parseManifest(SAMPLE_MANIFEST);
    const result = classifyPaths([
      'README.md',
      'src/index.ts',
      'src/private/secret.ts',
      'unlisted.txt'
    ], rules);

    expect(result.approved).toEqual(['README.md', 'src/index.ts']);
    expect(result.excluded).toEqual(['src/private/secret.ts']);
    expect(result.unclassified).toEqual(['unlisted.txt']);
  });
});
