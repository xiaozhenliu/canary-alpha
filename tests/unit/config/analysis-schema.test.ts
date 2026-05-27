import { describe, expect, it } from 'vitest';

import {
  appConfigSchema,
  analysisSchema,
  llmSchema,
  pathsConfigSchema,
  DEFAULT_ANALYSIS_IDLE_THRESHOLD_SECONDS,
  DEFAULT_ANALYSIS_REMOTE_LLM_TIMEOUT_MS,
  DEFAULT_ANALYSIS_EMBEDDINGS_TOP_K,
  DEFAULT_ANALYSIS_EMBEDDINGS_MIN_SCORE,
  DEFAULT_LLM_MODEL
} from '../../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Task 1.1 — analysis: / llm: schema defaults & backward compatibility
//
// 验证：
// - empty config 走默认值能跑通（既有 config.yaml 不写 analysis: / llm: 段仍能跑）
// - 各默认值与设计 §10 / R13.1 / R13.2 / R13.5 一致
// - paths.derivedDatabase 是可选字段（默认在 load-config 中由 resolveDerivedDatabasePath 兜底）
// ---------------------------------------------------------------------------

describe('appConfigSchema 向后兼容（task 1.1 / R13.1 / R13.2）', () => {
  it('parses an empty config and fills analysis / llm / paths defaults', () => {
    const config = appConfigSchema.parse({});

    expect(config.analysis.sessions.idleThresholdSeconds).toBe(
      DEFAULT_ANALYSIS_IDLE_THRESHOLD_SECONDS
    );
    expect(config.analysis.summary.provider).toBe('template');
    expect(config.analysis.summary.remoteLlmTimeoutMs).toBe(
      DEFAULT_ANALYSIS_REMOTE_LLM_TIMEOUT_MS
    );
    expect(config.analysis.embeddings.topK).toBe(DEFAULT_ANALYSIS_EMBEDDINGS_TOP_K);
    expect(config.analysis.embeddings.minScore).toBe(DEFAULT_ANALYSIS_EMBEDDINGS_MIN_SCORE);

    expect(config.llm.base_url).toBeUndefined();
    expect(config.llm.api_key).toBeUndefined();
    expect(config.llm.model).toBe(DEFAULT_LLM_MODEL);

    expect(config.paths.derivedDatabase).toBeUndefined();
  });

  it('keeps existing top-level sections backward compatible (capture / privacy / etc still parse)', () => {
    const config = appConfigSchema.parse({});

    expect(config.privacy.excludeApps).toContain('1Password');
    expect(config.privacy.excludeApps).toContain('Keychain Access');
    expect(config.capture.livenessThresholdSeconds).toBe(120);
    expect(config.routines.enabled).toBe(false);
  });
});

describe('analysisSchema individual sub-sections (task 1.1)', () => {
  it('analysisSessionsSchema defaults idleThresholdSeconds to 120', () => {
    const parsed = analysisSchema.parse({});
    expect(parsed.sessions.idleThresholdSeconds).toBe(120);
  });

  it('analysisSummarySchema defaults provider to template and timeout to 30s', () => {
    const parsed = analysisSchema.parse({});
    expect(parsed.summary.provider).toBe('template');
    expect(parsed.summary.remoteLlmTimeoutMs).toBe(30_000);
  });

  it('analysisSummarySchema accepts remote-llm provider', () => {
    const parsed = analysisSchema.parse({ summary: { provider: 'remote-llm' } });
    expect(parsed.summary.provider).toBe('remote-llm');
  });

  it('analysisSummarySchema rejects unknown provider values', () => {
    expect(() => analysisSchema.parse({ summary: { provider: 'local-llm' } })).toThrow();
  });

  it('analysisEmbeddingsSchema defaults topK=20 / minScore=0.0', () => {
    const parsed = analysisSchema.parse({});
    expect(parsed.embeddings.topK).toBe(20);
    expect(parsed.embeddings.minScore).toBe(0.0);
  });

  it('analysisSchema rejects non-positive idleThresholdSeconds', () => {
    expect(() => analysisSchema.parse({ sessions: { idleThresholdSeconds: 0 } })).toThrow();
    expect(() => analysisSchema.parse({ sessions: { idleThresholdSeconds: -1 } })).toThrow();
  });

  it('analysisSchema accepts unbounded finite minScore (dot-product not normalized)', () => {
    // dot-product 没有 [-1, 1] 上下界（embeddings 不一定归一化），schema 只要求有限实数。
    expect(analysisSchema.parse({ embeddings: { minScore: 1.5 } }).embeddings.minScore).toBe(1.5);
    expect(analysisSchema.parse({ embeddings: { minScore: -2 } }).embeddings.minScore).toBe(-2);
  });

  it('analysisSchema rejects non-finite minScore', () => {
    expect(() => analysisSchema.parse({ embeddings: { minScore: Number.NaN } })).toThrow();
    expect(() => analysisSchema.parse({ embeddings: { minScore: Number.POSITIVE_INFINITY } })).toThrow();
    expect(() => analysisSchema.parse({ embeddings: { minScore: Number.NEGATIVE_INFINITY } })).toThrow();
  });

  it('llmSchema defaults model to deepseek-chat and keeps base_url / api_key optional', () => {
    const parsed = llmSchema.parse({});
    expect(parsed.model).toBe('deepseek-chat');
    expect(parsed.base_url).toBeUndefined();
    expect(parsed.api_key).toBeUndefined();
  });

  it('llmSchema preserves user-supplied base_url / api_key / model', () => {
    const parsed = llmSchema.parse({
      base_url: 'http://localhost:11434/v1',
      api_key: 'sk-test',
      model: 'llama3'
    });
    expect(parsed.base_url).toBe('http://localhost:11434/v1');
    expect(parsed.api_key).toBe('sk-test');
    expect(parsed.model).toBe('llama3');
  });

  it('pathsConfigSchema makes derivedDatabase optional', () => {
    const empty = pathsConfigSchema.parse({});
    expect(empty.derivedDatabase).toBeUndefined();

    const withPath = pathsConfigSchema.parse({ derivedDatabase: '/tmp/derived.sqlite' });
    expect(withPath.derivedDatabase).toBe('/tmp/derived.sqlite');
  });
});

describe('appConfigSchema honors user-supplied analysis / llm fields (R13.1 / R13.2)', () => {
  it('preserves user analysis overrides without dropping unrelated defaults', () => {
    const config = appConfigSchema.parse({
      analysis: {
        sessions: { idleThresholdSeconds: 300 },
        summary: { provider: 'remote-llm', remoteLlmTimeoutMs: 60_000 }
      },
      llm: {
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-real',
        model: 'gpt-4o'
      },
      paths: { derivedDatabase: '~/custom/derived.sqlite' }
    });

    expect(config.analysis.sessions.idleThresholdSeconds).toBe(300);
    expect(config.analysis.summary.provider).toBe('remote-llm');
    expect(config.analysis.summary.remoteLlmTimeoutMs).toBe(60_000);
    expect(config.analysis.embeddings.topK).toBe(20); // 默认值未被覆盖
    expect(config.llm.base_url).toBe('https://api.openai.com/v1');
    expect(config.llm.api_key).toBe('sk-real');
    expect(config.llm.model).toBe('gpt-4o');
    expect(config.paths.derivedDatabase).toBe('~/custom/derived.sqlite');
  });
});
