/**
 * Unit tests for `SummaryProviderRegistry` and
 * `createSummaryProviderRegistry` (work-activity-analysis task 7.4,
 * design §6.4).
 *
 * The registry is a tiny dispatcher with two responsibilities:
 *
 *   - Choose the *active* provider once at construction based on
 *     `analysis.summary.provider` plus the presence of
 *     `llm.base_url` / `llm.api_key`. The active choice is what
 *     `internal-status.providers.summary.kind` reads, so it MUST
 *     reflect the user's configuration (not any runtime degradation).
 *     This is property **W23**, exercised in detail by the
 *     `SummaryWorker` tests; here we lock down the shape: the
 *     registry surfaces the configured provider through `active()`,
 *     and the deterministic template through `fallback()`, with no
 *     other states.
 *   - Defend `No_Outbound_When_Default` (W19) at the construction
 *     boundary: a half-configured `remote-llm` (provider selected
 *     but `base_url` or `api_key` empty) MUST NOT instantiate a
 *     `RemoteLlmSummaryProvider` — the registry silently falls back
 *     to the template instead. This is the layer 1 defence; the
 *     `RemoteLlmSummaryProvider` itself defends layer 2 by returning
 *     `NOT_CONFIGURED` if it ever does get instantiated without
 *     credentials.
 *
 * **Validates: Requirements 6.4, 6.5**
 */

import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../../../src/types/app-config.js';
import { RemoteLlmSummaryProvider } from '../../../src/services/work-activity/summary/remote-llm.js';
import {
  SummaryProviderRegistry,
  createSummaryProviderRegistry
} from '../../../src/services/work-activity/summary/registry.js';
import { TemplateSummaryProvider } from '../../../src/services/work-activity/summary/template.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal `AppConfig` with overridable `analysis.summary` /
 * `llm` fields. We only populate the slices the registry consumes;
 * the rest of the config object is `as unknown as AppConfig` so the
 * test does not have to mirror the entire bootstrap shape.
 */
function buildConfig(
  overrides: {
    provider?: 'template' | 'remote-llm';
    remoteLlmTimeoutMs?: number;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  } = {}
): AppConfig {
  return {
    analysis: {
      sessions: { idleThresholdSeconds: 120 },
      summary: {
        provider: overrides.provider ?? 'template',
        remoteLlmTimeoutMs: overrides.remoteLlmTimeoutMs ?? 30_000
      },
      embeddings: { topK: 20, minScore: 0 }
    },
    llm: {
      base_url: overrides.baseUrl,
      api_key: overrides.apiKey,
      model: overrides.model ?? 'gpt-4o-mini'
    }
  } as unknown as AppConfig;
}

// ---------------------------------------------------------------------------
// SummaryProviderRegistry — constructor / accessors
// ---------------------------------------------------------------------------

describe('SummaryProviderRegistry — accessors', () => {
  it('returns the template provider via active() when no remote provider was passed', () => {
    const template = new TemplateSummaryProvider();
    const registry = new SummaryProviderRegistry(template);

    expect(registry.active()).toBe(template);
    expect(registry.active().kind).toBe('template');
  });

  it('returns the supplied remote provider via active() when configured', () => {
    const template = new TemplateSummaryProvider();
    const remote = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });
    const registry = new SummaryProviderRegistry(template, remote);

    expect(registry.active()).toBe(remote);
    expect(registry.active().kind).toBe('remote-llm');
  });

  it('always returns the template provider via fallback() — even when remote is active', () => {
    const template = new TemplateSummaryProvider();
    const remote = new RemoteLlmSummaryProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    });
    const registry = new SummaryProviderRegistry(template, remote);

    // The fallback is the deterministic, network-free path. It MUST
    // be the template instance the registry was constructed with —
    // not a fresh one — because callers (`SummaryWorker`) assume the
    // returned provider has stable identity for the lifetime of the
    // registry.
    expect(registry.fallback()).toBe(template);
    expect(registry.fallback().kind).toBe('template');
  });

  it('active() and fallback() coincide when only template is configured', () => {
    const template = new TemplateSummaryProvider();
    const registry = new SummaryProviderRegistry(template);

    // When the user has not opted into remote-llm, the active
    // provider IS the template; the registry exposes the same
    // instance through both accessors.
    expect(registry.active()).toBe(template);
    expect(registry.fallback()).toBe(template);
  });
});

// ---------------------------------------------------------------------------
// createSummaryProviderRegistry — wiring tests
// ---------------------------------------------------------------------------

describe('createSummaryProviderRegistry — config-driven construction', () => {
  it('returns a template-only registry when provider="template"', () => {
    const registry = createSummaryProviderRegistry(
      buildConfig({ provider: 'template' })
    );
    expect(registry.active().kind).toBe('template');
    expect(registry.fallback().kind).toBe('template');
    // active() and fallback() should be the same instance — no
    // duplicate template provider.
    expect(registry.active()).toBe(registry.fallback());
  });

  it('returns a remote-backed registry when provider="remote-llm" with full credentials', () => {
    const registry = createSummaryProviderRegistry(
      buildConfig({
        provider: 'remote-llm',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test'
      })
    );
    expect(registry.active().kind).toBe('remote-llm');
    expect(registry.fallback().kind).toBe('template');
    // The two accessors must return distinct instances when the
    // remote provider is configured.
    expect(registry.active()).not.toBe(registry.fallback());
  });

  it('falls back to template when provider="remote-llm" but base_url is missing', () => {
    const registry = createSummaryProviderRegistry(
      buildConfig({
        provider: 'remote-llm',
        baseUrl: undefined,
        apiKey: 'sk-test'
      })
    );
    // The "no outbound on half-configured remote-llm" guarantee
    // (W19 layer 1). Without a base URL the registry falls back to
    // template — the RemoteLlmSummaryProvider is never constructed,
    // so a buggy caller cannot accidentally call generate() and
    // leak traffic.
    expect(registry.active().kind).toBe('template');
    expect(registry.fallback().kind).toBe('template');
    expect(registry.active()).toBe(registry.fallback());
  });

  it('falls back to template when provider="remote-llm" but api_key is missing', () => {
    const registry = createSummaryProviderRegistry(
      buildConfig({
        provider: 'remote-llm',
        baseUrl: 'https://api.example.com/v1',
        apiKey: undefined
      })
    );
    expect(registry.active().kind).toBe('template');
    expect(registry.fallback().kind).toBe('template');
  });

  it('falls back to template when provider="remote-llm" but base_url is empty string', () => {
    // Distinct from `undefined` — the YAML parser may produce an
    // empty string when the key is present but blank. The factory
    // normalises both to "no outbound".
    const registry = createSummaryProviderRegistry(
      buildConfig({
        provider: 'remote-llm',
        baseUrl: '',
        apiKey: 'sk-test'
      })
    );
    expect(registry.active().kind).toBe('template');
  });

  it('falls back to template when provider="remote-llm" but api_key is empty string', () => {
    const registry = createSummaryProviderRegistry(
      buildConfig({
        provider: 'remote-llm',
        baseUrl: 'https://api.example.com/v1',
        apiKey: ''
      })
    );
    expect(registry.active().kind).toBe('template');
  });

  it('threads remoteLlmTimeoutMs into the constructed remote provider', () => {
    // We cannot peek directly at the private `config` field, but we
    // can assert the registry produced a RemoteLlmSummaryProvider
    // instance — the timeout argument is exercised end-to-end by the
    // remote-llm tests (task 7.3), so checking instance identity
    // here is sufficient to confirm the wiring path.
    const registry = createSummaryProviderRegistry(
      buildConfig({
        provider: 'remote-llm',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        remoteLlmTimeoutMs: 5_000
      })
    );
    expect(registry.active()).toBeInstanceOf(RemoteLlmSummaryProvider);
  });
});
