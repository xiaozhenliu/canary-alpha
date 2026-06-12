import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
// Run the CLI from source via tsx, matching the project's rebuild-index/dev:stdio scripts.
// This avoids building dist inside the suite, which previously raced with other tests that
// share/exec dist/src/index.js and spiked CPU on timing-sensitive acceptance tests.
const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const ENTRY = join(process.cwd(), 'src', 'index.ts');
let home: string;

async function run(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await exec(TSX, [ENTRY, ...args],
      { env: { ...process.env, HOME: home, ...env } });
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'cfg-acc-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('config CLI (acceptance)', () => {
  it('set then get a number', async () => {
    expect((await run(['config', 'set', 'storage.retentionDays', '21'])).code).toBe(0);
    const got = await run(['config', 'get', 'storage.retentionDays']);
    expect(got.stdout).toContain('21');
  });
  it('rejects invalid value with non-zero exit', async () => {
    const r = await run(['config', 'set', 'trim.enabled', 'maybe']);
    expect(r.code).not.toBe(0);
  });
  it('supports -- terminator for negative numbers', async () => {
    const r = await run(['config', 'set', 'analysis.embeddings.minScore', '--', '-0.5']);
    expect(r.code).toBe(0);
    const got = await run(['config', 'get', 'analysis.embeddings.minScore']);
    expect(got.stdout).toContain('-0.5');
  });
  it('masks secret then unsets it', async () => {
    await run(['config', 'set', 'llm.api_key', 'sk-xyz']);
    const masked = await run(['config', 'get', 'llm.api_key']);
    expect(masked.stdout).toContain('***');
    const revealed = await run(['config', 'get', 'llm.api_key', '--reveal']);
    expect(revealed.stdout).toContain('sk-xyz');
    await run(['config', 'unset', 'llm.api_key']);
    expect((await run(['config', 'get', 'llm.api_key'])).stdout).toContain('(unset)');
  });
  it('add/remove array items', async () => {
    await run(['config', 'add', 'privacy.excludeApps', 'Slack']);
    const cfg = await readFile(join(home, '.canary-alpha-mcp', 'config.yaml'), 'utf8');
    expect(cfg).toContain('Slack');
    await run(['config', 'remove', 'privacy.excludeApps', 'Slack']);
    expect(await readFile(join(home, '.canary-alpha-mcp', 'config.yaml'), 'utf8')).not.toContain('Slack');
  });
  it('does not crash under illegal env', async () => {
    const r = await run(['config', 'get', 'server.port'], { MCP_PORT: 'abc' });
    expect(r.code).toBe(0);
  });
  it('validate returns zero on a valid file', async () => {
    await run(['config', 'set', 'logging.level', 'debug']);
    const r = await run(['config', 'validate']);
    expect(r.code).toBe(0);
  });
});
