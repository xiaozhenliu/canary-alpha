import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_HERMES_SERVER_NAME,
  LEGACY_HERMES_SERVER_NAME,
  migrateLegacyHermesServerRegistration
} from '../../scripts/onboarding-config.js';

const temporaryDirectories = [];

async function createHome() {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-migration-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe('migrateLegacyHermesServerRegistration', () => {
  it('renames the legacy Hermes MCP server key', async () => {
    const homeDirectory = await createHome();
    const hermesDirectory = join(homeDirectory, '.hermes');
    await mkdir(hermesDirectory, { recursive: true });
    await writeFile(join(hermesDirectory, 'config.yaml'), [
      'mcp_servers:',
      `  ${LEGACY_HERMES_SERVER_NAME}:`,
      '    url: http://127.0.0.1:18765/mcp',
      '    enabled: true'
    ].join('\n'), 'utf8');

    const result = await migrateLegacyHermesServerRegistration({ homeDirectory });
    const migrated = await readFile(join(hermesDirectory, 'config.yaml'), 'utf8');

    expect(result.status).toBe('renamed');
    expect(migrated).toContain(`${DEFAULT_HERMES_SERVER_NAME}:`);
    expect(migrated).not.toContain(`${LEGACY_HERMES_SERVER_NAME}:`);
    expect(migrated).toContain('http://127.0.0.1:18765/mcp');
  });
});
