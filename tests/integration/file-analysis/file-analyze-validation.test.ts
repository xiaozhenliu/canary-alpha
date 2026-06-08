import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DefaultFileAnalyzeService } from '../../../src/services/file-analysis/file-analyze-service.js';
import { testTempRoot } from '../../helpers/test-tmp.js';

describe('file analyze validation', () => {
  it('returns an explicit error for a missing file path', async () => {
    const service = new DefaultFileAnalyzeService();
    const result = await service.analyze({ path: '/tmp/does-not-exist.md' });

    expect(result.error).toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect(result.summary).toContain('File not found');
  });

  it('returns an explicit error for a directory path', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-dir-'));

    try {
      const service = new DefaultFileAnalyzeService();
      const result = await service.analyze({ path: tempDir });

      expect(result.error).toMatchObject({ code: 'PATH_IS_DIRECTORY' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns an explicit error for an unsupported extension', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-pdf-'));
    const filePath = join(tempDir, 'doc.pdf');

    try {
      await writeFile(filePath, 'fake pdf content', 'utf8');
      const service = new DefaultFileAnalyzeService();
      const result = await service.analyze({ path: filePath });

      expect(result.error).toMatchObject({ code: 'UNSUPPORTED_EXTENSION' });
      expect(result.summary).toContain('Unsupported file type');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns an explicit error for binary content detected via NUL byte', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-binary-'));
    const filePath = join(tempDir, 'binary.txt');

    try {
      await writeFile(filePath, Buffer.from([0x41, 0x00, 0x42]));
      const service = new DefaultFileAnalyzeService();
      const result = await service.analyze({ path: filePath });

      expect(result.error).toMatchObject({ code: 'BINARY_CONTENT' });
      expect(result.summary).toContain('binary content');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the configured allowlist roots', async () => {
    const allowedDir = await mkdtemp(join(testTempRoot(), 'file-analyze-allowed-'));
    const outsideDir = await mkdtemp(join(testTempRoot(), 'file-analyze-outside-'));
    const outsideFile = join(outsideDir, 'secret.md');

    try {
      await writeFile(outsideFile, '# secret\n', 'utf8');
      const service = new DefaultFileAnalyzeService(undefined, {
        allowedRoots: [allowedDir]
      });
      const result = await service.analyze({ path: outsideFile });

      expect(result.error).toMatchObject({ code: 'PATH_NOT_ALLOWED' });
      expect(result.summary).toContain('outside the allowed file-analyze roots');
    } finally {
      await rm(allowedDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects symlink escapes that resolve outside the configured allowlist roots', async () => {
    const allowedDir = await mkdtemp(join(testTempRoot(), 'file-analyze-symlink-allowed-'));
    const outsideDir = await mkdtemp(join(testTempRoot(), 'file-analyze-symlink-outside-'));
    const outsideFile = join(outsideDir, 'secret.md');
    const linkedFile = join(allowedDir, 'linked-secret.md');

    try {
      await writeFile(outsideFile, '# secret\n', 'utf8');
      await symlink(outsideFile, linkedFile);
      const service = new DefaultFileAnalyzeService(undefined, {
        allowedRoots: [allowedDir]
      });
      const result = await service.analyze({ path: linkedFile });

      expect(result.error).toMatchObject({ code: 'PATH_NOT_ALLOWED' });
      expect(result.summary).toContain('outside the allowed file-analyze roots');
    } finally {
      await rm(allowedDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects files larger than the configured size cap', async () => {
    const tempDir = await mkdtemp(join(testTempRoot(), 'file-analyze-too-large-'));
    const filePath = join(tempDir, 'large.md');

    try {
      await writeFile(filePath, 'a'.repeat(2048), 'utf8');
      const service = new DefaultFileAnalyzeService(undefined, {
        allowedRoots: [tempDir],
        maxFileBytes: 1024
      });
      const result = await service.analyze({ path: filePath });

      expect(result.error).toMatchObject({ code: 'FILE_TOO_LARGE' });
      expect(result.summary).toContain('File too large');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
