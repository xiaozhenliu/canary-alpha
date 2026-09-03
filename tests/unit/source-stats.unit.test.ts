import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeProject,
  countLines,
  formatMarkdownReport,
  formatTerminalReport,
  getModuleCategory,
  isExcludedFile
} from '../../scripts/source-stats.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

describe('countLines', () => {
  it('returns zeroes for empty content', () => {
    const stats = countLines('', '.ts');
    expect(stats).toEqual({ total: 0, code: 0, comment: 0, blank: 0 });
  });

  it('correctly categorizes TypeScript code, single-line comments, block comments, and blank lines', () => {
    const tsCode = [
      '// A simple comment',
      'const x: number = 42;',
      '',
      '/**',
      ' * JSDoc comment',
      ' */',
      'function test(): void {',
      '  const url = "http://example.com"; // inline comment',
      '}',
      ''
    ].join('\n');

    const stats = countLines(tsCode, '.ts');
    expect(stats.total).toBe(9);
    expect(stats.comment).toBe(4); // Line 1, 4, 5, 6
    expect(stats.code).toBe(4); // Line 2, 7, 8, 9
    expect(stats.blank).toBe(1); // Line 3
  });

  it('does not treat comment markers inside strings as comments', () => {
    const code = 'const str = "/* this is not a block comment */ // nor this";';
    const stats = countLines(code, '.ts');
    expect(stats.total).toBe(1);
    expect(stats.code).toBe(1);
    expect(stats.comment).toBe(0);
  });

  it('correctly handles Shell comments and shebangs', () => {
    const shCode = [
      '#!/usr/bin/env bash',
      '# This is a comment',
      '',
      'echo "Hello world"',
      '# Another comment'
    ].join('\n');

    const stats = countLines(shCode, '.sh');
    expect(stats.total).toBe(5);
    expect(stats.code).toBe(2); // Shebang + echo
    expect(stats.comment).toBe(2);
    expect(stats.blank).toBe(1);
  });
});

describe('isExcludedFile', () => {
  it('excludes test files and directories', () => {
    expect(isExcludedFile('tests/unit/some.test.ts')).toBe(true);
    expect(isExcludedFile('src/services/some.test.ts')).toBe(true);
    expect(isExcludedFile('src/services/some.spec.js')).toBe(true);
    expect(isExcludedFile('tests/acceptance/mcp-smoke.test.ts')).toBe(true);
    expect(isExcludedFile('tests/fixtures/data.json')).toBe(true);
  });

  it('excludes test scripts and fixtures in scripts directory', () => {
    expect(isExcludedFile('scripts/hermes-e2e.js')).toBe(true);
    expect(isExcludedFile('scripts/hermes-phase4-smoke.js')).toBe(true);
    expect(isExcludedFile('scripts/hermes-v1-evals.js')).toBe(true);
    expect(isExcludedFile('scripts/hermes-v1-fixture-clock.js')).toBe(true);
    expect(isExcludedFile('scripts/hermes-tool-includes.js')).toBe(true);
    expect(isExcludedFile('scripts/e2e-live-run.js')).toBe(true);
    expect(isExcludedFile('scripts/test-tmp.js')).toBe(true);
  });

  it('excludes documentation and markdown files', () => {
    expect(isExcludedFile('README.md')).toBe(true);
    expect(isExcludedFile('docs/index.md')).toBe(true);
    expect(isExcludedFile('docs/architecture.md')).toBe(true);
  });

  it('excludes config files and build outputs', () => {
    expect(isExcludedFile('package.json')).toBe(true);
    expect(isExcludedFile('tsconfig.json')).toBe(true);
    expect(isExcludedFile('vite.config.ts')).toBe(true);
    expect(isExcludedFile('vitest.config.ts')).toBe(true);
    expect(isExcludedFile('dist/index.js')).toBe(true);
    expect(isExcludedFile('node_modules/foo/index.js')).toBe(true);
  });

  it('includes production source files', () => {
    expect(isExcludedFile('src/index.ts')).toBe(false);
    expect(isExcludedFile('src/bootstrap/create-app.ts')).toBe(false);
    expect(isExcludedFile('dashboard/src/App.tsx')).toBe(false);
    expect(isExcludedFile('dashboard/src/globals.css')).toBe(false);
    expect(isExcludedFile('scripts/linear.ts')).toBe(false);
    expect(isExcludedFile('scripts/start-local.js')).toBe(false);
    expect(isExcludedFile('scripts/cleanup-screenpipe.sh')).toBe(false);
  });
});

describe('getModuleCategory', () => {
  it('correctly maps file paths to module categories', () => {
    expect(getModuleCategory('src/services/retrieval.ts').module).toContain('src/');
    expect(getModuleCategory('dashboard/src/components/Card.tsx').module).toContain('dashboard/src/');
    expect(getModuleCategory('scripts/service-start.js').module).toContain('scripts/');
  });
});

describe('analyzeProject and reports', () => {
  it('analyzes the real project and produces expected statistics', async () => {
    const stats = await analyzeProject(REPO_ROOT, { topCount: 5 });

    expect(stats.summary.files).toBeGreaterThan(100);
    expect(stats.summary.total).toBeGreaterThan(20000);
    expect(stats.summary.code).toBeGreaterThan(15000);
    expect(stats.summary.comment).toBeGreaterThan(1000);
    expect(stats.summary.blank).toBeGreaterThan(1000);
    expect(stats.byModule.length).toBeGreaterThanOrEqual(3);
    expect(stats.topFiles.length).toBe(5);

    const mdReport = formatMarkdownReport(stats);
    expect(mdReport).toContain('# 📊 项目源码行数统计报告');
    expect(mdReport).toContain('## 1. 总体概览');
    expect(mdReport).toContain('## 2. 按模块/子系统分布');
    expect(mdReport).toContain('## 3. 按编程语言与文件类型分布');
    expect(mdReport).toContain('## 4. 按核心子目录分布 (Top Directories)');
    expect(mdReport).toContain('## 5. 核心源码文件排行');
    expect(mdReport).toContain('## 6. 过滤与排除规则说明');

    const termReport = formatTerminalReport(stats);
    expect(termReport).toContain('CANARY ALPHA MCP - SOURCE CODE STATS');
  });
});
