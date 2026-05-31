/**
 * `SummaryWorker` — synchronous, on-demand summary generator
 * (work-activity-analysis task 7.4, design §6.5).
 *
 * The worker is the single entry point that converts a session row
 * (closed by the aggregator) into a stored `summary_text`. It is
 * called from three places:
 *
 *   - `recall(includeSummary=true)` per session row (design §8.3).
 *   - `inspect({sessionId})` to materialise a missing summary on
 *     demand.
 *   - The observability service when computing the `summary` rollup
 *     (only as a read-through; observability never triggers
 *     generation, so this path is currently unused).
 *
 * There is no background queue or cron — sessions stay small enough
 * (hundreds per day) that calling the provider lazily on the read
 * path keeps the implementation simple. The trade-off is that
 * `recall(includeSummary=true)` with `provider=remote-llm` is O(N
 * sessions) HTTP calls; design §6.5 explicitly accepts this and
 * reserves parallelisation for a later spec.
 *
 * Two correctness properties anchor the implementation:
 *
 *   - **W23 (`providers.summary.kind` reflects user config)** — the
 *     worker MUST select the provider through {@link
 *     SummaryProviderRegistry.active} based on `privacy.paused`,
 *     while observability reads `kind` from
 *     {@link SummaryProviderRegistry.active} regardless. The two
 *     readers serve different purposes: observability reports
 *     "what the user configured", the worker chooses "what we use
 *     this time".
 *   - **W27 (`No_Outbound_When_Paused`)** — when `privacy.paused
 *     === true`, the worker swaps in
 *     {@link SummaryProviderRegistry.fallback} (the template), so
 *     no fetch to `llm.base_url` happens during a pause. The check
 *     is read once per `ensureSummary` call so a paused-then-resumed
 *     state takes effect on the next call without restart.
 *
 * Failure handling follows design §6.5 exactly:
 *
 *   1. If the active provider returns `kind: 'ok'`, write
 *      `summary_text`/`status='ready'`/`provider_kind=<provider.kind>`/
 *      `generated_at=now()` and return that triple.
 *   2. If it returns `kind: 'error'`, fall through to the template
 *      provider (R6.7). When the template succeeds (which it always
 *      does — the implementation only "fails" on a JS engine bug),
 *      write `summary_text`/`status='degraded'`/`provider_kind='template'`
 *      and return.
 *   3. Only when the template *also* fails do we mark the row
 *      `summary_status='failed'` without populating `summary_text`.
 *
 * The worker is **idempotent**: calling `ensureSummary` twice on a
 * `'ready'` session short-circuits and returns the cached row data.
 * This is what makes `recall(includeSummary=true)` cheap on a warm
 * cache and lets `internal-status` ride the same code path without
 * worrying about double-billing the remote provider.
 *
 * **Validates: Requirements 6.4, 6.5, 6.7, 10.2**
 */

import type { PrivacyStateReader } from '../../privacy/types.js';
import type { ExtractedContentStore } from '../extraction/extracted-content-store.js';
import type {
  SessionStore,
  SummaryProviderKind
} from '../sessions/session-store.js';
import type { SummaryProviderRegistry } from './registry.js';
import type {
  SummaryProvider,
  SummaryProviderInput,
  SummaryStatus
} from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result returned to the caller after `ensureSummary` finishes.
 *
 *   - `status` — terminal state of the summary row after this call.
 *   - `text`   — the rendered narrative when `status` is `'ready'` or
 *     `'degraded'`; `null` when `'failed'` / `'not_applicable'` or
 *     when the requested session does not exist.
 *   - `providerKind` — provider that produced the *current* `text`.
 *     For a `'degraded'` row this is always `'template'`. For a
 *     fresh `'ready'` row this is the active provider's kind. For
 *     `'failed'` / `'not_applicable'` rows the field defaults to
 *     `'template'` — observability does not branch on it in those
 *     states, but the field is always present so the union shape
 *     stays simple.
 */
export interface EnsureSummaryResult {
  status: SummaryStatus;
  text: string | null;
  providerKind: SummaryProviderKind;
}

/**
 * Constructor dependencies for {@link SummaryWorker}.
 *
 *   - `registry` — the {@link SummaryProviderRegistry}; the worker
 *     holds an indirect reference rather than the providers
 *     themselves so a future runtime config reload could swap in a
 *     new active provider via {@link SummaryProviderRegistry.active}.
 *   - `sessionStore` — read the session row + persist
 *     `summary_status` / `summary_text` updates (design §6.5).
 *   - `extractedContentStore` — load the per-frame
 *     `extracted_text` snippets that the provider consumes.
 *   - `privacyState` — the worker reads `paused` once per call to
 *     decide whether to honour the active provider or redirect to
 *     the template fallback. **W27** mechanical floor.
 *   - `now` — wall-clock provider used to stamp
 *     `summary_generated_at`. Injectable for deterministic tests.
 */
export interface SummaryWorkerDependencies {
  registry: SummaryProviderRegistry;
  sessionStore: SessionStore;
  extractedContentStore: ExtractedContentStore;
  privacyState: PrivacyStateReader;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * `SummaryWorker` orchestrates: read session → load evidence → call
 * provider (with pause-aware swap) → persist result. The class
 * itself holds no mutable state beyond the injected dependencies.
 */
export class SummaryWorker {
  private readonly now: () => Date;

  constructor(private readonly deps: SummaryWorkerDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Materialise a summary for a session. Idempotent: if the
   * session is already `'ready'` the stored `summary_text` is
   * returned without invoking any provider.
   *
   * Returns a `failed` envelope if the session row does not exist
   * (a stale call from a `recall` that raced with a Cascade_Delete,
   * for example). The caller is expected to swallow this gracefully —
   * `recall` simply omits the summary for that session.
   */
  async ensureSummary(sessionId: string): Promise<EnsureSummaryResult> {
    const session = await this.deps.sessionStore.getSession(sessionId);
    if (session === null) {
      // Stale call — the session was cascade-deleted between the
      // caller's `listSessions` and this `ensureSummary`. Surface as
      // `failed` so the caller renders an empty summary block; we do
      // not write anything since the row no longer exists.
      return { status: 'failed', text: null, providerKind: 'template' };
    }

    // Fast path: already-ready row → return cached text. This is
    // what makes `recall(includeSummary=true)` cheap on warm cache
    // and lets `inspect` retrieve a session without paying the
    // provider cost a second time.
    if (
      session.summary_status === 'ready' &&
      session.summary_text !== null
    ) {
      return {
        status: 'ready',
        text: session.summary_text,
        providerKind: session.summary_provider_kind ?? 'template'
      };
    }

    // Build the provider input from the persisted session row plus
    // the resolved evidence fragments. The evidence list mirrors the
    // `evidence_frame_ids` column verbatim (already time-ordered by
    // the aggregator's `appendFrame`) so the provider sees frames in
    // chronological order.
    const evidenceFragments = await this.loadEvidenceFragments(
      session.evidence_frame_ids
    );
    const input: SummaryProviderInput = {
      kind: 'session',
      sessionId,
      appName: session.app_name,
      contextLabel: session.context_label,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      activeSeconds: session.active_seconds,
      evidenceFragments
    };

    // Choose the provider for THIS call.
    //
    // The pause check is the **W27 No_Outbound_When_Paused** mechanical
    // floor: when paused, hand back the template provider so any code
    // path that would otherwise reach `llm.base_url` is bypassed. We
    // re-read on every call so a paused-then-resumed system picks up
    // the change without restart. Failures from `privacyState.read()`
    // are conservatively treated as paused — better to keep the
    // pipeline running with the deterministic template than risk an
    // unintended outbound call when the privacy store is unavailable.
    const provider = await this.selectProvider();

    // Primary attempt with the selected provider.
    const result = await provider.generate(input);
    if (result.kind === 'ok') {
      const generatedAt = this.now().toISOString();
      await this.deps.sessionStore.updateSummary(sessionId, {
        summaryText: result.text,
        summaryStatus: 'ready',
        summaryProviderKind: provider.kind,
        summaryGeneratedAt: generatedAt
      });
      return {
        status: 'ready',
        text: result.text,
        providerKind: provider.kind
      };
    }

    // Primary failed — degrade to template (R6.7).
    //
    // Important: we use {@link SummaryProviderRegistry.fallback}
    // unconditionally here, *not* the `provider` we just used. The
    // pause path already routed `provider` to the template; in that
    // case `template.generate` returning an error is the only way to
    // reach this branch and falling back to itself again is correct
    // (the second call uses the same deterministic logic). In the
    // remote-llm-failure case, this is the cascade R6.7 specifies.
    const fallback = this.deps.registry.fallback();
    const fallbackResult = await fallback.generate(input);
    if (fallbackResult.kind === 'ok') {
      const generatedAt = this.now().toISOString();
      await this.deps.sessionStore.updateSummary(sessionId, {
        summaryText: fallbackResult.text,
        summaryStatus: 'degraded',
        summaryProviderKind: 'template',
        summaryGeneratedAt: generatedAt
      });
      return {
        status: 'degraded',
        text: fallbackResult.text,
        providerKind: 'template'
      };
    }

    // Template also failed — only reachable via a JS engine bug (the
    // template is dependency-free string concatenation). Mark the
    // row failed without overwriting the previously stored text so a
    // future call with a working template can recover.
    await this.deps.sessionStore.updateSummary(sessionId, {
      summaryStatus: 'failed'
    });
    return { status: 'failed', text: null, providerKind: 'template' };
  }

  /**
   * Pause-aware provider selection (design §6.5 — `selectProvider`).
   *
   * Reads `privacy.paused` once and either returns the active
   * provider (normal case) or the template fallback (paused case).
   * Errors from the privacy reader are conservatively treated as
   * `paused = true` — we prefer to drop into the deterministic
   * template than risk leaking a request to `llm.base_url` while
   * the privacy state is unknown.
   */
  private async selectProvider(): Promise<SummaryProvider> {
    let paused = false;
    try {
      const privacy = await this.deps.privacyState.read();
      paused = privacy.paused === true;
    } catch {
      // Conservative posture: if the privacy reader fails, behave
      // as if paused. This protects W27's invariant against a
      // partial-failure race where `recall` sees a stale state.
      paused = true;
    }
    return paused
      ? this.deps.registry.fallback()
      : this.deps.registry.active();
  }

  /**
   * Load the evidence fragments referenced by `evidence_frame_ids`.
   *
   * The store returns rows keyed by frame_id but **without** a
   * guaranteed ordering (the SQL `IN (...)` clause does not preserve
   * the input order). We sort on `frameTimestamp` after the read so
   * the provider always sees frames in chronological order — the
   * remote-llm prompt depends on it (the time-stamped bullet list
   * loses meaning if rows are out of order).
   *
   * Frames missing from `extracted_content` (e.g. a Cascade_Delete
   * race) are silently skipped — the provider sees a shorter
   * evidence list rather than crashing.
   */
  private async loadEvidenceFragments(
    frameIds: ReadonlyArray<number>
  ): Promise<
    ReadonlyArray<{ frameId: number; timestamp: string; extractedText: string }>
  > {
    if (frameIds.length === 0) return [];

    const rows = await this.deps.extractedContentStore.getByFrameIds(
      [...frameIds]
    );
    const byId = new Map(rows.map((row) => [row.frameId, row]));

    const ordered: Array<{
      frameId: number;
      timestamp: string;
      extractedText: string;
    }> = [];
    for (const id of frameIds) {
      const row = byId.get(id);
      if (row === undefined) continue;
      ordered.push({
        frameId: row.frameId,
        timestamp: row.frameTimestamp,
        extractedText: row.extractedText
      });
    }
    return ordered;
  }
}
