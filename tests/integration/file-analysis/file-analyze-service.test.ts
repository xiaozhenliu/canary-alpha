import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DefaultFileAnalyzeService } from '../../../src/services/file-analysis/file-analyze-service.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

describe('file analyze service', () => {
  it('returns a concise summary and highlights for a supported markdown file', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-summary-'));
    const filePath = join(tempDir, 'notes.md');

    try {
      await writeFile(filePath, '# Title\n\nImportant detail\nAnother detail\n', 'utf8');
      const service = new DefaultFileAnalyzeService();

      const result = await service.analyze({ path: filePath });

      expect(result.summary).toBe('notes.md is a supported .md file with 4 line(s).');
      expect(result.highlights).toEqual(['# Title', 'Important detail', 'Another detail']);
      expect(result.evidence).toEqual([]);
      expect(result.file).toMatchObject({
        name: 'notes.md',
        extension: '.md',
        lineCount: 4
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns a direct answer and evidence snippets with line numbers in question mode', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-question-'));
    const filePath = join(tempDir, 'service.ts');

    try {
      await writeFile(
        filePath,
        [
          'export function buildSummary() {',
          '  return "summary value";',
          '}',
          'export function buildEvidence() {',
          '  return "evidence value";',
          '}'
        ].join('\n'),
        'utf8'
      );
      const service = new DefaultFileAnalyzeService();

      const result = await service.analyze({
        path: filePath,
        question: 'where is build evidence defined'
      });

      expect(result.answer).toBe('export function buildEvidence() {');
      expect(result.evidence[0]).toMatchObject({
        lineNumber: 4,
        text: 'export function buildEvidence() {'
      });
      expect(result.evidence.length).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves literal Chinese question terms during normalization', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-chinese-literal-'));
    const filePath = join(tempDir, 'plan.md');

    try {
      await writeFile(
        filePath,
        [
          '# 如何安装',
          '请先下载依赖。',
          '这里还写了怎么排查问题。'
        ].join('\n'),
        'utf8'
      );
      const service = new DefaultFileAnalyzeService();

      const literalResult = await service.analyze({
        path: filePath,
        question: '如何'
      });
      const headingResult = await service.analyze({
        path: filePath,
        question: '如何安装'
      });
      const phraseResult = await service.analyze({
        path: filePath,
        question: '怎么排查'
      });

      expect(literalResult.answer).toBe('# 如何安装');
      expect(headingResult.answer).toBe('# 如何安装');
      expect(phraseResult.answer).toBe('这里还写了怎么排查问题。');
      expect(literalResult.evidence.length).toBeGreaterThan(0);
      expect(phraseResult.evidence.length).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('matches combining-mark scripts in question mode', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-combining-'));
    const filePath = join(tempDir, 'hindi.md');

    try {
      await writeFile(
        filePath,
        [
          '# हिंदी योजना',
          'गोपनीयता नियंत्रण संग्रह रोकने का समर्थन करता है।',
          'फ़ाइल विश्लेषण स्थानीय रूप से चलता है।'
        ].join('\n'),
        'utf8'
      );
      const service = new DefaultFileAnalyzeService();

      const result = await service.analyze({
        path: filePath,
        question: 'संग्रह रोकने का कहाँ उल्लेख है?'
      });

      expect(result.answer).toBe('गोपनीयता नियंत्रण संग्रह रोकने का समर्थन करता है।');
      expect(result.evidence[0]).toMatchObject({
        lineNumber: 2,
        text: 'गोपनीयता नियंत्रण संग्रह रोकने का समर्थन करता है।'
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('matches CJK segments inside mixed alphanumeric tokens in question mode', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-mixed-cjk-'));
    const filePath = join(tempDir, 'mixed.md');

    try {
      await writeFile(
        filePath,
        [
          '# 第3阶段',
          'v2版本说明',
          'mac版安装步骤'
        ].join('\n'),
        'utf8'
      );
      const service = new DefaultFileAnalyzeService();

      const stageResult = await service.analyze({
        path: filePath,
        question: '哪里提到阶段？'
      });
      const versionResult = await service.analyze({
        path: filePath,
        question: '哪里提到版本？'
      });
      const editionResult = await service.analyze({
        path: filePath,
        question: '版'
      });

      expect(stageResult.answer).toBe('# 第3阶段');
      expect(versionResult.answer).toBe('v2版本说明');
      expect(['v2版本说明', 'mac版安装步骤']).toContain(editionResult.answer);
      expect(editionResult.evidence.length).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('matches single-character questions inside pure CJK tokens in question mode', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-pure-cjk-'));
    const filePath = join(tempDir, 'pure-cjk.md');

    try {
      await writeFile(
        filePath,
        [
          '阶段计划',
          '版本说明'
        ].join('\n'),
        'utf8'
      );
      const service = new DefaultFileAnalyzeService();

      const result = await service.analyze({
        path: filePath,
        question: '段'
      });

      expect(result.answer).toBe('阶段计划');
      expect(result.evidence[0]).toMatchObject({
        lineNumber: 1,
        text: '阶段计划'
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps ASCII query matching for mixed CJK tokens in question mode', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-mixed-ascii-'));
    const filePath = join(tempDir, 'mixed-ascii.md');

    try {
      await writeFile(
        filePath,
        [
          'mac版安装步骤',
          'screenpipe版本说明'
        ].join('\n'),
        'utf8'
      );
      const service = new DefaultFileAnalyzeService();

      const macResult = await service.analyze({
        path: filePath,
        question: 'mac'
      });
      const screenpipeResult = await service.analyze({
        path: filePath,
        question: 'screenpipe'
      });

      expect(macResult.answer).toBe('mac版安装步骤');
      expect(screenpipeResult.answer).toBe('screenpipe版本说明');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('ignores short non-cjk stopwords when ranking question-mode matches', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-short-non-cjk-'));
    const filePath = join(tempDir, 'russian-stopwords.md');

    try {
      await writeFile(
        filePath,
        [
          'в архиве',
          'план готов'
        ].join('\n'),
        'utf8'
      );
      const service = new DefaultFileAnalyzeService();

      const result = await service.analyze({
        path: filePath,
        question: 'план в'
      });

      expect(result.answer).toBe('план готов');
      expect(result.evidence[0]).toMatchObject({
        lineNumber: 2,
        text: 'план готов'
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('ignores short combining-mark stopwords when ranking question-mode matches', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-combining-stopwords-'));
    const filePath = join(tempDir, 'hindi-stopwords.md');

    try {
      await writeFile(
        filePath,
        [
          'काम में',
          'प्लान तैयार'
        ].join('\n'),
        'utf8'
      );
      const service = new DefaultFileAnalyzeService();

      const result = await service.analyze({
        path: filePath,
        question: 'प्लान में'
      });

      expect(result.answer).toBe('प्लान तैयार');
      expect(result.evidence[0]).toMatchObject({
        lineNumber: 2,
        text: 'प्लान तैयार'
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not match unrelated whitespace-delimited non-ascii words by shared fragments', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-cyrillic-'));
    const filePath = join(tempDir, 'russian.md');

    try {
      await writeFile(
        filePath,
        [
          '# Русская заметка',
          'паук в комнате',
          'другой текст'
        ].join('\n'),
        'utf8'
      );
      const service = new DefaultFileAnalyzeService();

      const result = await service.analyze({
        path: filePath,
        question: 'где пауза?'
      });

      expect(result.answer).toBe('No matching content found for the provided question.');
      expect(result.evidence).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not expand pure Japanese syllabary questions into noisy single-character matches', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-japanese-'));
    const filePath = join(tempDir, 'japanese.md');

    try {
      await writeFile(
        filePath,
        [
          '設定画面はこちらです',
          'この行はにほんごの説明です',
          'ここの手順を確認します',
          'おすすめの資料です'
        ].join('\n'),
        'utf8'
      );
      const service = new DefaultFileAnalyzeService();

      const result = await service.analyze({
        path: filePath,
        question: 'どこに設定がありますか'
      });

      expect(result.answer).toBe('設定画面はこちらです');
      expect(result.evidence[0]).toMatchObject({
        lineNumber: 1,
        text: '設定画面はこちらです'
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not expand pure Korean syllable questions into noisy single-character matches', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-korean-'));
    const filePath = join(tempDir, 'korean.md');

    try {
      await writeFile(
        filePath,
        [
          '설정 화면은 여기에 있습니다',
          '이 줄은 소개 문장입니다',
          '다른 설명도 있습니다'
        ].join('\n'),
        'utf8'
      );
      const service = new DefaultFileAnalyzeService();

      const result = await service.analyze({
        path: filePath,
        question: '설정은 어디에 있나요'
      });

      expect(result.answer).toBe('설정 화면은 여기에 있습니다');
      expect(result.evidence[0]).toMatchObject({
        lineNumber: 1,
        text: '설정 화면은 여기에 있습니다'
      });
      expect(result.evidence.every((item) => item.lineNumber === 1)).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
