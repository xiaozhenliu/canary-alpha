import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  APP_DIRECTORY_NAME,
  LEGACY_APP_DIRECTORY_NAME,
  migrateLegacyAppHomeIfNeeded,
  resolveLegacyAppDirectory,
  resolveTargetAppDirectory
} from '../../scripts/app-home-migration.js';

const temporaryDirectories = [];

async function createHome() {
  const directory = await mkdtemp(join(tmpdir(), 'computer-history-app-home-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe('app home migration', () => {
  it('migrates a legacy app home directory with a recoverable backup', async () => {
    const homeDirectory = await createHome();
    const legacyDirectory = resolveLegacyAppDirectory(homeDirectory);
    const targetDirectory = resolveTargetAppDirectory(homeDirectory);
    const now = new Date('2026-09-02T12:34:56.000Z');

    await mkdir(legacyDirectory, { recursive: true });
    await mkdir(join(legacyDirectory, 'logs'), { recursive: true });
    await writeFile(join(legacyDirectory, 'config.yaml'), [
      'server:',
      '  port: 18765',
      'vectorStore:',
      `  path: ${join(legacyDirectory, 'chroma')}`,
      'archive:',
      '  path: /Volumes/.canary-alpha-mcp-archive',
      'archiveHome:',
      '  path: ~/.canary-alpha-mcp-archive',
      'legacyHome:',
      '  path: ~/.canary-alpha-mcp/chroma'
    ].join('\n'), 'utf8');

    const result = await migrateLegacyAppHomeIfNeeded({ homeDirectory, now });

    expect(result.status).toBe('migrated');
    expect(existsSync(targetDirectory)).toBe(true);
    expect(existsSync(legacyDirectory)).toBe(false);
    expect(result.backupDirectory).toBe(`${legacyDirectory}.backup-20260902-123456`);
    const migratedConfig = await readFile(join(targetDirectory, 'config.yaml'), 'utf8');
    expect(migratedConfig).toContain('port: 18765');
    expect(migratedConfig).toContain(`path: ${join(targetDirectory, 'chroma')}`);
    expect(migratedConfig).toContain('~/.computer-history-mcp/chroma');
    expect(migratedConfig).toContain('/Volumes/.canary-alpha-mcp-archive');
    expect(migratedConfig).toContain('~/.canary-alpha-mcp-archive');
    expect(existsSync(result.backupDirectory)).toBe(true);
    expect(existsSync(join(targetDirectory, '.onboarding-complete'))).toBe(false);
  });

  it('does not rewrite longer same-prefix path tokens', async () => {
    const { replaceLegacyAppHomePathSegment } = await import('../../scripts/app-home-migration.js');
    expect(replaceLegacyAppHomePathSegment(
      'path: ~/.canary-alpha-mcp-archive\nother: ~/.canary-alpha-mcp/data',
      '~/.canary-alpha-mcp',
      '~/.computer-history-mcp'
    )).toBe('path: ~/.canary-alpha-mcp-archive\nother: ~/.computer-history-mcp/data');
  });

  it('fails closed from ensureAppHomeReady when both homes exist', async () => {
    const { ensureAppHomeReady } = await import('../../scripts/app-home-migration.js');
    const homeDirectory = await createHome();
    await mkdir(resolveLegacyAppDirectory(homeDirectory), { recursive: true });
    await mkdir(resolveTargetAppDirectory(homeDirectory), { recursive: true });

    await expect(ensureAppHomeReady({ homeDirectory, failOnConflict: true })).rejects.toThrow(
      /both .* exist/i
    );
  });

  it('blocks migration when both legacy and target app homes exist', async () => {
    const homeDirectory = await createHome();
    await mkdir(resolveLegacyAppDirectory(homeDirectory), { recursive: true });
    await mkdir(resolveTargetAppDirectory(homeDirectory), { recursive: true });

    const result = await migrateLegacyAppHomeIfNeeded({ homeDirectory });

    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('both-present');
    expect(existsSync(resolveLegacyAppDirectory(homeDirectory))).toBe(true);
    expect(existsSync(resolveTargetAppDirectory(homeDirectory))).toBe(true);
  });

  it('dereferences a symlinked legacy app home into a recoverable backup', async () => {
    const homeDirectory = await createHome();
    const realLegacy = join(homeDirectory, 'real-legacy-home');
    const legacyDirectory = resolveLegacyAppDirectory(homeDirectory);
    const targetDirectory = resolveTargetAppDirectory(homeDirectory);
    const now = new Date('2026-09-02T12:34:56.000Z');

    await mkdir(realLegacy, { recursive: true });
    await writeFile(join(realLegacy, 'config.yaml'), 'server:\n  port: 18765\n', 'utf8');
    await symlink(realLegacy, legacyDirectory);

    const result = await migrateLegacyAppHomeIfNeeded({ homeDirectory, now });

    expect(result.status).toBe('migrated');
    expect(existsSync(legacyDirectory)).toBe(false);
    expect(existsSync(targetDirectory)).toBe(true);
    expect(await readFile(join(targetDirectory, 'config.yaml'), 'utf8')).toContain('port: 18765');
    expect(await readFile(join(result.backupDirectory, 'config.yaml'), 'utf8')).toContain('port: 18765');
    // Mutating the migrated home must not rewrite the backup contents.
    await writeFile(join(targetDirectory, 'config.yaml'), 'server:\n  port: 1\n', 'utf8');
    expect(await readFile(join(result.backupDirectory, 'config.yaml'), 'utf8')).toContain('port: 18765');
  });
});
