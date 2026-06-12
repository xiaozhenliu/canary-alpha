import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigFileStore } from '../../src/config/config-file-store.js';
import { ConfigCliService, CliError } from '../../src/config/config-cli-service.js';

let dir: string;
let file: string;
let svc: ConfigCliService;
const SAVED = { ...process.env };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cfg-svc-'));
  file = join(dir, 'config.yaml');
  svc = new ConfigCliService(new ConfigFileStore(file));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  process.env = { ...SAVED };
});

describe('ConfigCliService', () => {
  it('set coerces and validates, creating file', async () => {
    const r = await svc.set('storage.retentionDays', '14');
    expect(r.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toContain('14');
  });

  it('set rejects invalid value without writing', async () => {
    await expect(svc.set('trim.enabled', 'maybe')).rejects.toBeInstanceOf(CliError);
  });

  it('set rejects array path', async () => {
    await expect(svc.set('privacy.excludeApps', 'x')).rejects.toThrow(/add\/remove/);
  });

  it('get masks secrets by default and reveals with flag', async () => {
    await svc.set('llm.api_key', 'sk-secret');
    expect((await svc.get('llm.api_key', { reveal: false })).display).toBe('***');
    expect((await svc.get('llm.api_key', { reveal: true })).display).toBe('sk-secret');
  });

  it('unset removes a secret', async () => {
    await svc.set('llm.api_key', 'sk-secret');
    await svc.unset('llm.api_key');
    expect((await svc.get('llm.api_key', { reveal: true })).display).toBe('(unset)');
  });

  it('annotates env override on get', async () => {
    process.env.MCP_PORT = '9000';
    const r = await svc.get('server.port', { reveal: false });
    expect(r.overriddenByEnv).toBe('MCP_PORT');
  });

  it('does not crash on illegal env (degrade)', async () => {
    process.env.MCP_PORT = 'abc';
    const r = await svc.get('server.port', { reveal: false });
    expect(r.path).toBe('server.port');
  });

  it('add dedupes', async () => {
    await svc.addToArray('privacy.excludeApps', 'Slack');
    const r = await svc.addToArray('privacy.excludeApps', 'Slack');
    expect(r.noop).toBe(true);
  });

  it('validate flags zod errors', async () => {
    await writeFile(file, 'server:\n  port: -1\n');
    const r = await svc.validate();
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('validate flags YAML syntax error separately', async () => {
    await writeFile(file, 'a: [unclosed');
    const r = await svc.validate();
    expect(r.syntaxError).toBeTruthy();
  });

  it('unknown path throws', async () => {
    await expect(svc.get('nope.field', { reveal: false })).rejects.toBeInstanceOf(CliError);
  });

  it('set null on a nullable field deletes the key', async () => {
    await svc.set('storage.diskBudgetBytes', '1000');
    expect((await svc.get('storage.diskBudgetBytes', { reveal: false })).display).toContain('1000');
    await svc.set('storage.diskBudgetBytes', 'null');
    expect((await svc.get('storage.diskBudgetBytes', { reveal: false })).display).toBe('(unset)');
  });
  it('unset on an unset field is a noop without error', async () => {
    const r = await svc.unset('llm.api_key');
    expect(r.noop).toBe(true);
  });
  it('removeFromArray reports noop when item absent', async () => {
    const r = await svc.removeFromArray('privacy.excludeApps', 'NotPresent');
    expect(r.noop).toBe(true);
  });
  it('list shows file vs default source and masks secrets', async () => {
    await svc.set('llm.api_key', 'sk-zzz');
    const entries = await svc.list({ reveal: false });
    const secret = entries.find((e) => e.path === 'llm.api_key');
    expect(secret?.display).toBe('***');
    expect(secret?.source).toBe('file');
    const untouched = entries.find((e) => e.path === 'retrieval.pollIntervalSeconds');
    expect(untouched?.source).toBe('default');
  });
  it('sets envDegraded false under normal env', async () => {
    await svc.set('logging.level', 'debug');
    const r = await svc.get('logging.level', { reveal: false });
    expect(r.envDegraded).toBeFalsy();
  });
});
