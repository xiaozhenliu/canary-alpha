/**
 * `TemplateSummaryProvider` — the default, deterministic, fully local
 * `SummaryProvider` (work-activity-analysis task 7.2, design §6.2).
 *
 * The provider stitches a single Chinese sentence from the input
 * payload — application name, derived context label, an "约 N 分钟"
 * minute count rounded from `activeSeconds`, the count of evidence
 * frames, and the session window endpoints. No network I/O, no
 * filesystem reads, no clock reads other than the provider-self-
 * reported `latencyMs` measurement.
 *
 * Two correctness properties pin this implementation down (see
 * design §14):
 *
 *   - **Template_Determinism (W17)** — for any `SummaryProviderInput`
 *     I, two consecutive `generate(I)` calls MUST return the same
 *     `text` byte-for-byte. `latencyMs` may differ; the property is
 *     stated against `text` only.
 *   - **No_Outbound_When_Default (W19)** — when the configured
 *     provider is `template`, calling `generate` MUST NOT touch the
 *     network. Concretely the implementation does not import or
 *     reference `fetch` / `node:http(s)` at all.
 *
 * The provider promises to never reject its returned `Promise`.
 * Per design §6.5 the `SummaryProvider` interface contract requires
 * recoverable errors to be surfaced via `{ kind: 'error', error }`,
 * not exceptions. The template path is dependency-free arithmetic
 * and string concatenation, so an exception here would represent a
 * programmer error in the JS engine itself; if one ever escapes the
 * `try` block the provider returns a `PARSE_FAILED` error so the
 * worker can mark the session `summary_status = 'failed'` (design
 * §6.5 / §11.2).
 *
 * **Validates: Requirements 6.2, 6.6**
 */

import type {
  SummaryProvider,
  SummaryProviderInput,
  SummaryProviderResult
} from './types.js';

/**
 * Deterministic, network-free summary provider.
 *
 * The class has no constructor parameters because everything it
 * needs flows through {@link SummaryProviderInput}. Keeping it
 * argument-free also means a single shared instance can serve every
 * caller — there is no per-request state to worry about.
 */
export class TemplateSummaryProvider implements SummaryProvider {
  /**
   * Provider identity literal. The `SummaryWorker` writes this
   * verbatim into `sessions.summary_provider_kind` whenever the
   * template is the source of truth (whether by user configuration
   * or by remote-llm degradation), so observability and
   * `recall(includeSummary=true)` can branch on it.
   */
  readonly kind = 'template' as const;

  /**
   * Render the deterministic narrative. See design §6.2 for the
   * exact template string.
   *
   * `latencyMs` is measured from `Date.now()` at entry to `Date.now()`
   * at exit. The `text` field is **not** influenced by the clock
   * read, which preserves Template_Determinism (W17). Property tests
   * therefore assert against `result.text`, not the whole result
   * object.
   */
  async generate(input: SummaryProviderInput): Promise<SummaryProviderResult> {
    const start = Date.now();
    try {
      // `Math.round` per design §6.2:
      //   - `activeSeconds = 0`   → 0 minutes
      //   - `activeSeconds = 30`  → 1 minute (banker's-rounding-free; JS
      //     `Math.round` is half-away-from-zero for positive values)
      //   - `activeSeconds = 29`  → 0 minutes
      // The template surfaces the rounded value verbatim with a leading
      // "约" so the user sees an approximation rather than a precise
      // figure derived from per-frame heuristics.
      const minutes = Math.round(input.activeSeconds / 60);
      const text =
        `在 ${input.appName} 中工作约 ${minutes} 分钟，围绕 "${input.contextLabel}"，` +
        `共 ${input.evidenceFragments.length} 帧证据（${input.startedAt}起，${input.endedAt}止）。`;
      return { kind: 'ok', text, latencyMs: Date.now() - start };
    } catch (err) {
      // Defensive branch: see the file-level comment. The template is
      // arithmetic + string concat, so this catch is unreachable in
      // practice — but the SummaryProvider contract forbids throwing,
      // and a thrown error from here would crash `SummaryWorker.ensureSummary`.
      // Surface it as a structured error so the worker can stamp
      // `summary_status = 'failed'` (design §11.2) and move on.
      const message = err instanceof Error ? err.message : String(err);
      return {
        kind: 'error',
        error: { code: 'PARSE_FAILED', message }
      };
    }
  }
}
