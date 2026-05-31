import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APP_DIRECTORY_NAME,
  DERIVED_DATABASE_FILE_NAME,
  resolveDerivedDatabasePath
} from '../../../src/config/paths.js';

describe('resolveDerivedDatabasePath (task 1.1)', () => {
  const home = homedir();

  it('falls back to <app dir>/derived.sqlite when no config is provided', () => {
    expect(resolveDerivedDatabasePath()).toBe(
      join(home, APP_DIRECTORY_NAME, DERIVED_DATABASE_FILE_NAME)
    );
  });

  it('falls back to default when config.paths.derivedDatabase is absent', () => {
    expect(resolveDerivedDatabasePath({})).toBe(
      join(home, APP_DIRECTORY_NAME, DERIVED_DATABASE_FILE_NAME)
    );
    expect(resolveDerivedDatabasePath({ paths: {} })).toBe(
      join(home, APP_DIRECTORY_NAME, DERIVED_DATABASE_FILE_NAME)
    );
  });

  it('returns absolute paths verbatim', () => {
    expect(resolveDerivedDatabasePath({ paths: { derivedDatabase: '/var/data/derived.sqlite' } }))
      .toBe('/var/data/derived.sqlite');
  });

  it('expands ~/ prefix against the user home directory', () => {
    expect(
      resolveDerivedDatabasePath({ paths: { derivedDatabase: '~/scratch/derived.sqlite' } })
    ).toBe(join(home, 'scratch/derived.sqlite'));
  });

  it('treats empty string as absent and falls back to default', () => {
    expect(resolveDerivedDatabasePath({ paths: { derivedDatabase: '' } })).toBe(
      join(home, APP_DIRECTORY_NAME, DERIVED_DATABASE_FILE_NAME)
    );
  });
});
