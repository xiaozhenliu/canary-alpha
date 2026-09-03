#!/usr/bin/env node

/**
 * Source code statistics script for computer-history-mcp.
 * Measures source code lines (total, code/SLOC, comment, blank)
 * strictly excluding test suites, documentation, build outputs, and configuration files.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  '.dist',
  'coverage',
  'tests',
  'test',
  '__tests__',
  'fixtures',
  'evaluations',
  'docs',
  'experiments',
  '.git',
  '.github',
  '.planning',
  '.codex',
  '.claude',
  '.agents',
  '.zed',
  '.omo',
  '.omx',
  '.commandcode',
  '.screenpipe-memory-mcp',
  '.worktrees',
  '.codegraph',
  '.understand-anything',
  '.test-tmp',
  '.tmp',
  'tmp',
  '.cache'
]);

const EXCLUDED_FILE_PATTERNS = [
  /\.test\.[a-z0-9]+$/i,
  /\.spec\.[a-z0-9]+$/i,
  /\.mdx?$/i,
  /\.txt$/i,
  /\.json$/i,
  /\.ya?ml$/i,
  /\.plist$/i,
  /\.lock$/i,
  /\.toml$/i,
  /^vite\.config\.[a-z]+$/i,
  /^vitest\.config\.[a-z]+$/i,
  /^tsconfig(\..*)?\.json$/i,
  /^\.env/i
];

const EXCLUDED_SCRIPT_FILES = new Set([
  'hermes-e2e.js',
  'hermes-phase4-smoke.js',
  'hermes-v1-evals.js',
  'hermes-v1-fixture-clock.js',
  'hermes-v1-fixture-clock.d.ts',
  'hermes-v1-fixture-records.js',
  'hermes-v1-fixture-records.d.ts',
  'hermes-tool-includes.js',
  'hermes-tool-includes.d.ts',
  'e2e-live-run.js',
  'e2e-live-run-lib.js',
  'e2e-live-run-lib.d.ts',
  'test-tmp.js'
]);

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript React',
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'JavaScript React',
  '.d.ts': 'TypeScript (Type Defs)',
  '.css': 'CSS',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell'
};

const DEFAULT_SOURCE_ROOTS = ['src', 'dashboard/src', 'scripts'];

/**
 * Counts lines in a given text content according to language comment syntax.
 */
export function countLines(content: string, ext: string): LineStats {
  let rawLines = content.split(/\r?\n/);
  // Handle POSIX trailing newline without adding an artificial empty line
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines = rawLines.slice(0, -1);
  }

  if (rawLines.length === 0) {
    return { total: 0, code: 0, comment: 0, blank: 0 };
  }

  let code = 0;
  let comment = 0;
  let blank = 0;

  const isShell = ext === '.sh' || ext === '.bash' || ext === '.zsh';

  let inBlockComment = false;
  let inTemplateLiteral = false;

  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
    const line = rawLines[lineIndex];
    const trimmed = line.trim();

    if (trimmed === '') {
      if (inBlockComment) {
        comment++;
      } else {
        blank++;
      }
      continue;
    }

    if (isShell) {
      if (trimmed.startsWith('#')) {
        if (lineIndex === 0 && trimmed.startsWith('#!')) {
          code++;
        } else {
          comment++;
        }
      } else {
        code++;
      }
      continue;
    }

    // C-style comments (JS, TS, CSS, etc.)
    let hasCode = false;
    let hasComment = false;
    let i = 0;

    while (i < line.length) {
      if (inBlockComment) {
        if (line[i] === '*' && line[i + 1] === '/') {
          hasComment = true;
          inBlockComment = false;
          i += 2;
        } else {
          hasComment = true;
          i++;
        }
      } else if (inTemplateLiteral) {
        if (line[i] === '\\') {
          hasCode = true;
          i += 2;
        } else if (line[i] === '`') {
          hasCode = true;
          inTemplateLiteral = false;
          i++;
        } else {
          hasCode = true;
          i++;
        }
      } else {
        if (line[i] === '/' && line[i + 1] === '/') {
          hasComment = true;
          break; // Rest of line is comment
        } else if (line[i] === '/' && line[i + 1] === '*') {
          hasComment = true;
          inBlockComment = true;
          i += 2;
        } else if (line[i] === '"' || line[i] === "'") {
          hasCode = true;
          const quote = line[i];
          i++;
          while (i < line.length && line[i] !== quote) {
            if (line[i] === '\\') {
              i++;
            }
            i++;
          }
          if (i < line.length) {
            i++;
          }
        } else if (line[i] === '`') {
          hasCode = true;
          inTemplateLiteral = true;
          i++;
        } else if (/\s/.test(line[i])) {
          i++;
        } else {
          hasCode = true;
          i++;
        }
      }
    }

    if (hasCode) {
      code++;
    } else if (hasComment || inBlockComment) {
      comment++;
    } else {
      blank++;
    }
  }

  return {
    total: rawLines.length,
    code,
    comment,
    blank
  };
}

/**
 * Determines whether a file path should be excluded from source code stats.
 */
export function isExcludedFile(relativePath: string): boolean {
  const parts = relativePath.split(/[/\\]/);
  const fileName = parts[parts.length - 1];

  for (const part of parts.slice(0, -1)) {
    if (EXCLUDED_DIR_NAMES.has(part)) {
      return true;
    }
  }

  for (const pattern of EXCLUDED_FILE_PATTERNS) {
    if (pattern.test(fileName)) {
      return true;
    }
  }

  if (parts[0] === 'scripts' && EXCLUDED_SCRIPT_FILES.has(fileName)) {
    return true;
  }

  const ext = getLanguageExtension(fileName);
  if (!LANGUAGE_MAP[ext]) {
    return true;
  }

  return false;
}

function getLanguageExtension(fileName: string): string {
  if (fileName.endsWith('.d.ts')) {
    return '.d.ts';
  }
  return extname(fileName).toLowerCase();
}

/**
 * Resolves module / subsystem name for a relative path.
 */
export function getModuleCategory(relativePath: string): { module: string; description: string } {
  if (relativePath.startsWith('src/')) {
    return { module: 'src/ (MCP Server)', description: '核心 MCP 服务与后端架构' };
  }
  if (relativePath.startsWith('dashboard/src/')) {
    return { module: 'dashboard/src/ (Dashboard)', description: '前端可视化管理看板 (React)' };
  }
  if (relativePath.startsWith('scripts/')) {
    return { module: 'scripts/ (Operations)', description: '生产运维与生命周期管理脚本' };
  }
  return { module: 'other', description: '其他源码模块' };
}

/**
 * Recursively scans directories to collect all source code files.
 */
export async function collectSourceFiles(rootDir: string, scanRoots = DEFAULT_SOURCE_ROOTS): Promise<string[]> {
  const result: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(rootDir, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (!isExcludedFile(relPath)) {
          result.push(relPath);
        }
      }
    }
  }

  for (const subRoot of scanRoots) {
    const fullSubRoot = resolve(rootDir, subRoot);
    try {
      const s = await stat(fullSubRoot);
      if (s.isDirectory()) {
        await walk(fullSubRoot);
      }
    } catch {
      // Subroot does not exist, ignore
    }
  }

  return result.sort();
}

/**
 * Analyzes the entire project source code.
 */
export async function analyzeProject(rootDir: string, options: ScanOptions = {}): Promise<ProjectStats> {
  const filePaths = await collectSourceFiles(rootDir);
  const allFiles: FileStat[] = [];

  const moduleMap = new Map<string, GroupStats>();
  const languageMap = new Map<string, GroupStats>();
  const directoryMap = new Map<string, GroupStats>();

  let totalLines = 0;
  let codeLines = 0;
  let commentLines = 0;
  let blankLines = 0;

  for (const relPath of filePaths) {
    const fullPath = resolve(rootDir, relPath);
    const content = await readFile(fullPath, 'utf8');
    const ext = getLanguageExtension(relPath);
    const language = LANGUAGE_MAP[ext] || 'Other';
    const { module } = getModuleCategory(relPath);

    const parts = relPath.split('/');
    const dirGroup = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];

    const stats = countLines(content, ext);

    const fileStat: FileStat = {
      path: relPath,
      module,
      language,
      extension: ext,
      ...stats
    };

    allFiles.push(fileStat);

    totalLines += stats.total;
    codeLines += stats.code;
    commentLines += stats.comment;
    blankLines += stats.blank;

    // Aggregate by module
    const modEntry = moduleMap.get(module) || { name: module, files: 0, total: 0, code: 0, comment: 0, blank: 0 };
    modEntry.files++;
    modEntry.total += stats.total;
    modEntry.code += stats.code;
    modEntry.comment += stats.comment;
    modEntry.blank += stats.blank;
    moduleMap.set(module, modEntry);

    // Aggregate by language
    const langEntry = languageMap.get(language) || { name: language, files: 0, total: 0, code: 0, comment: 0, blank: 0 };
    langEntry.files++;
    langEntry.total += stats.total;
    langEntry.code += stats.code;
    langEntry.comment += stats.comment;
    langEntry.blank += stats.blank;
    languageMap.set(language, langEntry);

    // Aggregate by directory
    const dirEntry = directoryMap.get(dirGroup) || { name: dirGroup, files: 0, total: 0, code: 0, comment: 0, blank: 0 };
    dirEntry.files++;
    dirEntry.total += stats.total;
    dirEntry.code += stats.code;
    dirEntry.comment += stats.comment;
    dirEntry.blank += stats.blank;
    directoryMap.set(dirGroup, dirEntry);
  }

  // Sort top files by code/SLOC descending
  const topFiles = [...allFiles].sort((a, b) => b.code - a.code).slice(0, options.topCount ?? 10);

  const byModule = Array.from(moduleMap.values()).sort((a, b) => b.code - a.code);
  const byLanguage = Array.from(languageMap.values()).sort((a, b) => b.code - a.code);
  const byDirectory = Array.from(directoryMap.values()).sort((a, b) => b.code - a.code);

  return {
    summary: {
      files: allFiles.length,
      total: totalLines,
      code: codeLines,
      comment: commentLines,
      blank: blankLines
    },
    byModule,
    byLanguage,
    byDirectory,
    topFiles,
    allFiles: options.includeAllFiles ? allFiles : [],
    excludedRules: [
      '测试代码：tests/**, **/*.test.*, **/*.spec.*, scripts/ 中的 E2E/Smoke/Eval 测试工具与 fixture',
      '文档规范：docs/**, *.md, *.mdx, PRD*, 架构与规划文档',
      '配置文件：package.json, tsconfig.json, vite.config.ts, vitest.config.ts, *.yaml, *.plist, .env*',
      '构建产物：dist/**, node_modules/**, .dist/**, coverage/**, .test-tmp/**',
      '实验研究：experiments/**'
    ]
  };
}

function formatPercent(value: number, total: number): string {
  if (total === 0) return '0.0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Formats the stats into the canonical Chinese Markdown report template.
 */
export function formatMarkdownReport(stats: ProjectStats): string {
  const { summary, byModule, byLanguage, byDirectory, topFiles, excludedRules } = stats;

  const lines: string[] = [];

  lines.push('# 📊 项目源码行数统计报告');
  lines.push('');
  lines.push('> 🎯 **统计范围**：仅包含生产与运维源码，严格排除测试代码、文档资料、配置文件和构建产物。');
  lines.push('');
  lines.push('## 1. 总体概览');
  lines.push('');
  lines.push('| 指标 | 行数 / 数量 | 占比 | 说明 |');
  lines.push('| :--- | :--- | :--- | :--- |');
  lines.push(`| **总代码行数 (Total Lines)** | \`${formatNumber(summary.total)}\` | 100.0% | 源码总行数 |`);
  lines.push(`| └── **有效代码行 (SLOC)** | \`${formatNumber(summary.code)}\` | **${formatPercent(summary.code, summary.total)}** | 纯逻辑与类型定义代码 |`);
  lines.push(`| └── **代码注释行 (Comments)** | \`${formatNumber(summary.comment)}\` | ${formatPercent(summary.comment, summary.total)} | 单行/多行/JSDoc 注释 |`);
  lines.push(`| └── **代码空行 (Blank Lines)** | \`${formatNumber(summary.blank)}\` | ${formatPercent(summary.blank, summary.total)} | 代码格式空行 |`);
  lines.push(`| **源码文件总数 (Source Files)** | \`${formatNumber(summary.files)}\` 个 | - | 不含测试/文档/配置 |`);
  lines.push('');

  lines.push('## 2. 按模块/子系统分布');
  lines.push('');
  lines.push('| 模块 / 目录 | 说明 | 文件数 | 总行数 | 有效代码 (SLOC) | 注释行 | 空行 | SLOC 占比 |');
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const mod of byModule) {
    const { description } = getModuleCategory(mod.name.startsWith('src') ? 'src/' : mod.name.startsWith('dashboard') ? 'dashboard/src/' : 'scripts/');
    lines.push(`| \`${mod.name}\` | ${description} | ${mod.files} | ${formatNumber(mod.total)} | **${formatNumber(mod.code)}** | ${formatNumber(mod.comment)} | ${formatNumber(mod.blank)} | ${formatPercent(mod.code, summary.code)} |`);
  }
  lines.push('');

  lines.push('## 3. 按编程语言与文件类型分布');
  lines.push('');
  lines.push('| 语言 / 类型 | 扩展名 | 文件数 | 总行数 | 有效代码 (SLOC) | 注释行 | 空行 | SLOC 占比 |');
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const lang of byLanguage) {
    const exts = Object.entries(LANGUAGE_MAP)
      .filter(([_, l]) => l === lang.name)
      .map(([e]) => `\`${e}\``)
      .join(', ');
    lines.push(`| **${lang.name}** | ${exts} | ${lang.files} | ${formatNumber(lang.total)} | **${formatNumber(lang.code)}** | ${formatNumber(lang.comment)} | ${formatNumber(lang.blank)} | ${formatPercent(lang.code, summary.code)} |`);
  }
  lines.push('');

  lines.push('## 4. 按核心子目录分布 (Top Directories)');
  lines.push('');
  lines.push('| 子目录 | 文件数 | 总行数 | 有效代码 (SLOC) | 注释行 | 空行 | SLOC 占比 |');
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const dir of byDirectory) {
    lines.push(`| \`${dir.name}/\` | ${dir.files} | ${formatNumber(dir.total)} | **${formatNumber(dir.code)}** | ${formatNumber(dir.comment)} | ${formatNumber(dir.blank)} | ${formatPercent(dir.code, summary.code)} |`);
  }
  lines.push('');

  lines.push(`## 5. 核心源码文件排行 (Top ${topFiles.length} Largest Files)`);
  lines.push('');
  lines.push('| 排名 | 文件路径 | 模块 | 语言 | 总行数 | 有效代码 (SLOC) | 注释行 | 空行 |');
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
  topFiles.forEach((file, idx) => {
    lines.push(`| ${idx + 1} | \`${file.path}\` | \`${file.module}\` | ${file.language} | ${formatNumber(file.total)} | **${formatNumber(file.code)}** | ${formatNumber(file.comment)} | ${formatNumber(file.blank)} |`);
  });
  lines.push('');

  lines.push('## 6. 过滤与排除规则说明');
  lines.push('');
  for (const rule of excludedRules) {
    lines.push(`- 🚫 **${rule}**`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Formats stats into a clean terminal report.
 */
export function formatTerminalReport(stats: ProjectStats): string {
  const { summary, byModule, byLanguage, topFiles } = stats;

  const lines: string[] = [];
  lines.push('================================================================================');
  lines.push('                      CANARY ALPHA MCP - SOURCE CODE STATS                      ');
  lines.push('================================================================================');
  lines.push(`Total Files:       ${formatNumber(summary.files)}`);
  lines.push(`Total Lines:       ${formatNumber(summary.total)}`);
  lines.push(`Code Lines (SLOC): ${formatNumber(summary.code)} (${formatPercent(summary.code, summary.total)})`);
  lines.push(`Comment Lines:     ${formatNumber(summary.comment)} (${formatPercent(summary.comment, summary.total)})`);
  lines.push(`Blank Lines:       ${formatNumber(summary.blank)} (${formatPercent(summary.blank, summary.total)})`);
  lines.push('--------------------------------------------------------------------------------');
  lines.push('BY MODULE:');
  for (const m of byModule) {
    lines.push(`  - ${m.name.padEnd(30)} ${formatNumber(m.files).padStart(4)} files | SLOC: ${formatNumber(m.code).padStart(6)} (${formatPercent(m.code, summary.code).padStart(5)}) | Total: ${formatNumber(m.total).padStart(6)}`);
  }
  lines.push('--------------------------------------------------------------------------------');
  lines.push('BY LANGUAGE:');
  for (const l of byLanguage) {
    lines.push(`  - ${l.name.padEnd(25)} ${formatNumber(l.files).padStart(4)} files | SLOC: ${formatNumber(l.code).padStart(6)} (${formatPercent(l.code, summary.code).padStart(5)}) | Total: ${formatNumber(l.total).padStart(6)}`);
  }
  lines.push('--------------------------------------------------------------------------------');
  lines.push(`TOP ${topFiles.length} FILES (BY SLOC):`);
  topFiles.forEach((f, i) => {
    lines.push(`  ${String(i + 1).padStart(2)}. ${f.path.padEnd(45)} SLOC: ${formatNumber(f.code).padStart(5)} | Total: ${formatNumber(f.total).padStart(5)}`);
  });
  lines.push('================================================================================');

  return lines.join('\n');
}

// CLI Execution entry point
const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
  pathToFileURL(process.argv[1]).href === import.meta.url
);

if (isMain) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node --import tsx scripts/source-stats.ts [options]
       npm run source:stats [-- options]

Options:
  --json            Output raw stats in JSON format
  --markdown, -m    Output formatted Markdown report in Chinese (default)
  --terminal, -t    Output formatted text table in terminal
  --top <number>    Number of top files to display (default: 10)
  --all-files       Include detailed stats for every file in JSON output
  --help, -h        Show this help message
`);
    process.exit(0);
  }

  const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
  const rootDir = resolve(scriptDir, '..');

  const topIndex = args.indexOf('--top');
  const topCount = topIndex !== -1 && args[topIndex + 1] ? parseInt(args[topIndex + 1], 10) : 10;
  const includeAllFiles = args.includes('--all-files');

  analyzeProject(rootDir, { topCount, includeAllFiles })
    .then((stats) => {
      if (args.includes('--json')) {
        console.log(JSON.stringify(stats, null, 2));
      } else if (args.includes('--terminal') || args.includes('-t')) {
        console.log(formatTerminalReport(stats));
      } else {
        console.log(formatMarkdownReport(stats));
      }
    })
    .catch((err) => {
      console.error('Error counting lines of code:', err);
      process.exit(1);
    });
}
