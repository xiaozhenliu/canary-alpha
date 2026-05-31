/**
 * `SummaryProviderRegistry` — selects the active summary provider
 * based on the user's configuration, and exposes a deterministic
 * fallback for callers that need to bypass remote egress
 * (work-activity-analysis task 7.4, design §6.4).
 *
 * The registry is a tiny dispatcher with two responsibilities:
 *
 *   - {@link SummaryProviderRegistry.active} returns the provider the
 *     user **configured**. When `analysis.summary.provider === 'template'`
 *     (the default) this is the `TemplateSummaryProvider`. When
 *     `analysis.summary.provider === 'remote-llm'` AND
 *     `llm.base_url` / `llm.api_key` are populated, this is the
 *     `RemoteLlmSummaryProvider`. Crucially, the active provider is
 *     determined at construction time and does NOT change in response
 *     to runtime conditions like `privacy.paused`. This is what
 *     `internal-status.providers.summary.kind` reads — the property
 *     **W23** (`providers.summary.kind 反映用户配置而非运行时降级`)
 *     turns this into a hard contract.
 *
 *   - {@link SummaryProviderRegistry.fallback} always returns the
 *     deterministic `TemplateSummaryProvider`. The `SummaryWorker`
 *     calls this when:
 *
 *       1. `privacy.paused === true` — design §6.5 / R10.2 require
 *          the worker to redirect to `template` so no outbound
 *          traffic to `llm.base_url` happens during a pause
 *          (property **W27** `No_Outbound_When_Paused`).
 *       2. The configured provider returned an error envelope —
 *          design §6.5 / R6.7 cascade to template so the session
 *          gets a `'degraded'` summary rather than nothing.
 *
 * Half-configured `remote-llm` (provider selected but `base_url` or
 * `api_key` missing) is **not** treated as a configuration error
 * here. The factory falls back to the template silently — the
 * `RemoteLlmSummaryProvider` defends the same case at the call site
 * by returning `NOT_CONFIGURED` (W19), but constructing it without
 * credentials would let an outbound call slip through if the registry
 * ever exposed it. Treating "missing config" as "use template" keeps
 * the egress invariant mechanical at the registry layer.
 *
 * The registry holds no mutable state — the `active` choice is fixed
 * at construction. A configuration reload (currently not implemented)
 * would rebuild the registry rather than mutate it in place.
 *
 * **Validates: Requirements 6.4, 6.5, 6.7**
 */

import type { AppConfig } from '../../../types/app-config.js';
import { RemoteLlmSummaryProvider } from './remote-llm.js';
import { TemplateSummaryProvider } from './template.js';
import type { SummaryProvider } from './types.js';

/**
 * Dispatches between the deterministic `template` provider and the
 * optional `remote-llm` provider based on `analysis.summary.provider`.
 *
 * The class is a thin wrapper that keeps the routing decisions in
 * one place. It does not own provider lifecycle — a process restart
 * is the only thing that re-evaluates the configured provider.
 */
export class SummaryProviderRegistry {
  /**
   * Active provider as selected by the user's configuration. This
   * field is populated by the constructor and never mutated, so
   * `active().kind` is a stable reflection of `config.analysis.summary.provider`
   * (modulo the half-configured `remote-llm` fall-through documented
   * above).
   */
  private readonly activeChoice: SummaryProvider;

  /**
   * The deterministic template provider used as the fallback in
   * pause / degraded paths. Stored separately from `activeChoice`
   * so {@link fallback} can return it even when `activeChoice ===
   * template` — there is no special-casing at the worker layer.
   */
  private readonly templateProvider: TemplateSummaryProvider;

  constructor(
    template: TemplateSummaryProvider,
    remote?: RemoteLlmSummaryProvider
  ) {
    this.templateProvider = template;
    this.activeChoice = remote ?? template;
  }

  /**
   * Returns the user-configured provider. Callers that need
   * provider identity for observability (e.g.
   * `internal-status.providers.summary.kind`) MUST use this method —
   * not {@link fallback} — because the configured provider must
   * surface verbatim regardless of any runtime degradation
   * (property **W23**).
   */
  active(): SummaryProvider {
    return this.activeChoice;
  }

  /**
   * Returns the deterministic template provider. The `SummaryWorker`
   * (design §6.5) uses this in two places:
   *
   *   - When `privacy.paused === true` — redirecting to template
   *     keeps the egress invariant `W27 No_Outbound_When_Paused`
   *     mechanical: paused → template → no fetch to `llm.base_url`.
   *   - After the configured provider returns an error envelope —
   *     R6.7 cascades to template so the session row gets a
   *     `'degraded'` summary and the user still sees something
   *     useful in `recall(includeSummary=true)`.
   */
  fallback(): SummaryProvider {
    return this.templateProvider;
  }
}

/**
 * Factory for the production `SummaryProviderRegistry` instance.
 *
 * The construction logic mirrors design §6.4 verbatim. The factory
 * checks three things in order:
 *
 *   1. `analysis.summary.provider === 'remote-llm'` — the user opted
 *      in to outbound LLM calls.
 *   2. `llm.base_url` is a non-empty string — there is somewhere to
 *      send the request.
 *   3. `llm.api_key` is a non-empty string — the request will pass
 *      authentication.
 *
 * All three must hold for the registry to attach a
 * `RemoteLlmSummaryProvider`. Otherwise the registry contains only
 * the template — the configured provider effectively reverts to
 * `template` from the worker's point of view, even when the user
 * wrote `provider: remote-llm` in the config. The
 * `RemoteLlmSummaryProvider` itself also enforces the
 * `NOT_CONFIGURED` guard at the call site (see its file-level docs
 * for W19 — `No_Outbound_When_Default`), so half-configuration is
 * defended at two layers.
 *
 * `analysis.summary.remoteLlmTimeoutMs` flows through to the
 * provider's `timeoutMs` so a long-hung remote endpoint cannot block
 * the calling tool indefinitely. The provider clamps this internally
 * to `30_000` when not provided.
 */
export function createSummaryProviderRegistry(
  config: AppConfig
): SummaryProviderRegistry {
  const template = new TemplateSummaryProvider();

  const wantRemote = config.analysis.summary.provider === 'remote-llm';
  const baseUrl = config.llm?.base_url ?? '';
  const apiKey = config.llm?.api_key ?? '';

  if (wantRemote && baseUrl.length > 0 && apiKey.length > 0) {
    const remote = new RemoteLlmSummaryProvider({
      baseUrl,
      apiKey,
      // `model` is `string` (with a Zod default of `'deepseek-chat'`),
      // so it is always populated; no fallback needed here.
      model: config.llm.model,
      timeoutMs: config.analysis.summary.remoteLlmTimeoutMs
    });
    return new SummaryProviderRegistry(template, remote);
  }

  return new SummaryProviderRegistry(template);
}
