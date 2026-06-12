import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveCheckpointPath } from '../../src/bootstrap/create-app.js';

describe('resolveCheckpointPath', () => {
  it('namespaces the checkpoint file by provider', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
    expect(resolveCheckpointPath('screenpipe', dir))
      .toBe(join(dir, 'retrieval-checkpoint.screenpipe.json'));
  });

  it('adopts a legacy checkpoint for the screenpipe provider exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
    writeFileSync(join(dir, 'retrieval-checkpoint.json'), '{"timestamp":"2026-06-12T00:00:00Z"}');
    const resolved = resolveCheckpointPath('screenpipe', dir);
    expect(existsSync(resolved)).toBe(true);
    expect(existsSync(join(dir, 'retrieval-checkpoint.json'))).toBe(false);
  });

  it('does not adopt the legacy checkpoint for other providers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-'));
    writeFileSync(join(dir, 'retrieval-checkpoint.json'), '{}');
    resolveCheckpointPath('axtool', dir);
    expect(existsSync(join(dir, 'retrieval-checkpoint.json'))).toBe(true);
  });
});
