import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigFileStore } from '../../src/config/config-file-store.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cfg-store-'));
  file = join(dir, 'config.yaml');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SAMPLE = `privacy:
  # excluded apps
  excludeApps:
    - 1Password   # password manager
    - Keychain Access
server:
  port: 8765      # default port
`;

describe('ConfigFileStore', () => {
  it('preserves comments when setting a scalar', async () => {
    await writeFile(file, SAMPLE);
    const store = new ConfigFileStore(file);
    const { doc } = await store.readDocument();
    store.setScalarAtPath(doc, ['server', 'port'], 9000);
    await store.write(doc);
    const out = await readFile(file, 'utf8');
    expect(out).toContain('# excluded apps');
    expect(out).toContain('# password manager');
    expect(out).toContain('9000');
  });

  it('preserves other array-item comments when removing one item (F1)', async () => {
    await writeFile(file, SAMPLE);
    const store = new ConfigFileStore(file);
    const { doc } = await store.readDocument();
    expect(store.removeFromSeqAtPath(doc, ['privacy', 'excludeApps'], '1Password')).toBe(true);
    await store.write(doc);
    const out = await readFile(file, 'utf8');
    expect(out).not.toContain('1Password');
    expect(out).toContain('# excluded apps');
    expect(out).toContain('Keychain Access');
  });

  it('add dedupes and reports false when present', async () => {
    await writeFile(file, SAMPLE);
    const store = new ConfigFileStore(file);
    const { doc } = await store.readDocument();
    expect(store.addToSeqAtPath(doc, ['privacy', 'excludeApps'], 'Slack')).toBe(true);
    expect(store.addToSeqAtPath(doc, ['privacy', 'excludeApps'], 'Slack')).toBe(false);
  });

  it('creates file with 0600 when absent', async () => {
    const store = new ConfigFileStore(file);
    const { doc, existed } = await store.readDocument();
    expect(existed).toBe(false);
    store.setScalarAtPath(doc, ['logging', 'level'], 'debug');
    await store.write(doc);
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('throws on YAML syntax error', async () => {
    await writeFile(file, 'a: [unclosed');
    const store = new ConfigFileStore(file);
    await expect(store.readDocument()).rejects.toThrow(/Invalid YAML syntax/);
  });

  it('getAtPath reads a scalar and returns undefined for missing path', async () => {
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(file, SAMPLE);
    const store = new ConfigFileStore(file);
    const { doc } = await store.readDocument();
    expect(store.getAtPath(doc, ['server', 'port'])).toBe(8765);
    expect(store.getAtPath(doc, ['nope', 'missing'])).toBeUndefined();
  });

  it('deleteAtPath removes a key and is a no-op on missing path', async () => {
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(file, SAMPLE);
    const store = new ConfigFileStore(file);
    const { doc } = await store.readDocument();
    store.deleteAtPath(doc, ['server', 'port']);
    expect(store.getAtPath(doc, ['server', 'port'])).toBeUndefined();
    expect(() => store.deleteAtPath(doc, ['nope'])).not.toThrow();
  });

  it('removeFromSeqAtPath returns false for missing item and missing path', async () => {
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(file, SAMPLE);
    const store = new ConfigFileStore(file);
    const { doc } = await store.readDocument();
    expect(store.removeFromSeqAtPath(doc, ['privacy', 'excludeApps'], 'NotThere')).toBe(false);
    expect(store.removeFromSeqAtPath(doc, ['nope', 'arr'], 'x')).toBe(false);
  });

  it('addToSeqAtPath creates the seq when path is absent', async () => {
    const store = new ConfigFileStore(file);
    const { doc } = await store.readDocument();
    expect(store.addToSeqAtPath(doc, ['privacy', 'excludeApps'], 'Slack')).toBe(true);
    expect(store.getAtPath(doc, ['privacy', 'excludeApps'])).toEqual(['Slack']);
  });
});
