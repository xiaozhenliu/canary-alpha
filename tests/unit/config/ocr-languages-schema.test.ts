import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appConfigSchema,
  captureConfigSchema,
  ocrLanguageSchema,
  DEFAULT_OCR_LANGUAGES
} from '../../../src/config/schema.js';
import { ConfigFileStore } from '../../../src/config/config-file-store.js';
import { ConfigCliService, CliError } from '../../../src/config/config-cli-service.js';

// ---------------------------------------------------------------------------
// capture.ocrLanguages — schema defaults, enum validation, and CLI guardrails
// (design: 2026-06-22-ocr-language-config-design.md)
// ---------------------------------------------------------------------------

describe('capture.ocrLanguages schema', () => {
  it('defaults to ["english"] when the capture section is entirely absent', () => {
    const config = appConfigSchema.parse({});
    expect(config.capture.ocrLanguages).toEqual([...DEFAULT_OCR_LANGUAGES]);
    expect(config.capture.ocrLanguages).toEqual(['english']);
  });

  it('defaults to ["english"] when capture exists but omits ocrLanguages', () => {
    const config = appConfigSchema.parse({ capture: { livenessThresholdSeconds: 90 } });
    expect(config.capture.ocrLanguages).toEqual(['english']);
    expect(config.capture.livenessThresholdSeconds).toBe(90);
  });

  it('preserves a user-supplied multi-language list in order', () => {
    const config = appConfigSchema.parse({ capture: { ocrLanguages: ['chinese', 'english'] } });
    expect(config.capture.ocrLanguages).toEqual(['chinese', 'english']);
  });

  it('rejects an unknown language value with a path that points at the field', () => {
    const parsed = captureConfigSchema.safeParse({ ocrLanguages: ['klingon'] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toContain('ocrLanguages');
    }
  });

  it('rejects an empty language list (.min(1) — never silently disable OCR languages)', () => {
    const parsed = captureConfigSchema.safeParse({ ocrLanguages: [] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toContain('ocrLanguages');
    }
  });

  it('returns a fresh array per parse so a mutated result cannot pollute the schema default', () => {
    const first = appConfigSchema.parse({}).capture.ocrLanguages;
    first.push('chinese'); // mutate the parsed value
    const second = appConfigSchema.parse({}).capture.ocrLanguages;
    expect(second).toEqual(['english']); // unaffected by the mutation above
    expect(first).not.toBe(second);
  });

  it('keeps DEFAULT_OCR_LANGUAGES values within the enum', () => {
    for (const lang of DEFAULT_OCR_LANGUAGES) {
      expect(ocrLanguageSchema.options as string[]).toContain(lang);
    }
  });
});

describe('config CLI rejects invalid capture.ocrLanguages without writing', () => {
  let dir: string;
  let file: string;
  let svc: ConfigCliService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfg-ocr-'));
    file = join(dir, 'config.yaml');
    svc = new ConfigCliService(new ConfigFileStore(file));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts a valid language via `config add`', async () => {
    const r = await svc.addToArray('capture.ocrLanguages', 'chinese');
    expect(r.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toContain('chinese');
  });

  it('rejects an invalid language and never writes it to disk', async () => {
    await expect(svc.addToArray('capture.ocrLanguages', 'klingon')).rejects.toBeInstanceOf(CliError);
    // The invalid value must not have been persisted (file either absent or without it).
    if (existsSync(file)) {
      expect(await readFile(file, 'utf8')).not.toContain('klingon');
    }
  });

  it('surfaces the offending field path in the validation error', async () => {
    await expect(svc.addToArray('capture.ocrLanguages', 'klingon')).rejects.toThrow(/capture\.ocrLanguages/);
  });
});
