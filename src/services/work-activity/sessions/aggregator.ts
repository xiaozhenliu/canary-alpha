/**
 * Session_Aggregator (work-activity-analysis task 4.2).
 *
 * Folds the per-frame `ExtractionResult` stream produced by the
 * extraction layer into continuous `Open_Session` rows on the derived
 * `sessions` table. The implementation follows design §4 verbatim:
 *
 *   - `handleExtraction(extraction)` is called once per frame after
 *     {@link ../extraction/extracted-content-store.ts} has persisted the
 *     `extracted_content` row. It either extends the current Open_Session
 *     for `(appName, contextKey)` or closes any stale one and creates a
 *     new session.
 *
 *   - `flushIdleOpenSessions(now)` is called from three places to keep
 *     the `sessions` table in sync with wall-clock idleness:
 *       1. {@link ../../retrieval/indexing-service.ts} at the entry of
 *          every `runOnce()` (R3.6),
 *       2. the `internal-status` observability path so
 *          `openSessionCount` does not include stale rows, and
 *       3. the `recall` MCP tool before query aggregation.
 *
 * The aggregator is deliberately stateless beyond its dependencies — all
 * persistence flows through {@link SessionStore}. Two consecutive
 * replays of the same frame sequence produce identical session content
 * (W10 Idempotence), and `flushIdleOpenSessions` is itself idempotent
 * (W11) because the second call has no rows whose `ended_at < cutoff`
 * remaining `is_open = 1`.
 *
 * **Validates: Requirements 3.3, 3.5, 3.6, 3.7**
 */

import type { ExtractionResult } from '../extraction/types.js';
import type { SessionRow, SessionStore } from './session-store.js';
import { normalizeToUtc } from '../../../lib/time.js';

/**
 * Constructor dependencies for {@link DefaultSessionAggregator}. The
 * separation of `now` and `generateSessionId` from the store lets tests
 * deterministically drive both axes without monkey-patching globals.
 */
export interface SessionAggregatorDependencies {
  store: SessionStore;
  /**
   * Maximum gap (in seconds, inclusive) between two consecutive frames
   * that still allows the second frame to extend the current
   * Open_Session. Sourced from `config.analysis.sessions.idleThresholdSeconds`
   * (R3.7); default 120s.
   */
  idleThresholdSeconds: number;
  /**
   * Wall-clock provider, used by {@link DefaultSessionAggregator.flushIdleOpenSessions}
   * and {@link DefaultSessionAggregator.handleExtraction} when closing a
   * stale Open_Session. Tests inject a fixed clock; production wires
   * `() => new Date()`.
   */
  now: () => Date;
  /**
   * Produces a fresh `session_id` whenever a new Open_Session is
   * created. Production wires `() => crypto.randomUUID()`; tests inject
   * a deterministic counter so PBT can compare session sets across
   * replays without caring about ID identity.
   */
  generateSessionId: () => string;
}

/**
 * Result of a single {@link DefaultSessionAggregator.handleExtraction}
 * call. `created` is `true` when the call started a new session row,
 * `false` when it extended the existing Open_Session.
 *
 * The aggregator does not surface the close-then-create case any
 * differently from a plain create — both report `created: true`. The
 * only side effect callers need to observe is "which session does this
 * frame belong to", which `sessionId` answers.
 */
export interface HandleExtractionResult {
  sessionId: string;
  created: boolean;
}

/**
 * Result of a single {@link DefaultSessionAggregator.flushIdleOpenSessions}
 * call. `closed` is the number of rows whose `is_open` flipped from 1
 * to 0; idempotent re-invocation reports `0`.
 */
export interface FlushIdleResult {
  closed: number;
}

/**
 * Public interface of the aggregator. Surfaced as an interface so
 * `IndexingService`, the observability service, and the `recall` tool
 * can depend on it without pulling in the concrete class.
 */
export interface SessionAggregator {
  handleExtraction(extraction: ExtractionResult): Promise<HandleExtractionResult>;
  flushIdleOpenSessions(now?: Date): Promise<FlushIdleResult>;
}

/**
 * The default {@link SessionAggregator} implementation.
 *
 * Boundary semantics live entirely in {@link DefaultSessionAggregator.canExtend}:
 *
 *   - **Boundary_Closure (W7 / R3.5)** — the comparison `open.app_name !==
 *     (e.appName ?? '')` rejects an app switch. Combined with the
 *     `(app_name, context_key, is_open=1)` query in
 *     {@link SessionStore.findOpenSessionFor}, this gives the spec's
 *     "appName 切换 → 立刻关闭" guarantee even though `findOpenSessionFor`
 *     pre-filters on `(appName, contextKey)`: the app-name check makes
 *     the rule explicit at the aggregator layer (and makes the test's
 *     PBT W7 pass without depending on store internals).
 *
 *   - **Idle_Closure (W8 / R3.3 / R3.6)** — `gap > idleThreshold`
 *     closes the open session and starts a new one.
 *
 *   - **Context_Continuity (W9 / R3.3)** — same `(appName, contextKey)`
 *     within `idleThreshold` extends the same session.
 *
 * The increment to `active_seconds` follows design §4: it is the gap
 * between the new frame's timestamp and the open session's previous
 * `ended_at`, **clamped** to `[0, idleThreshold]`. The clamp at zero
 * absorbs occasional out-of-order frames in the same session
 * (`extraction.frameTimestamp < open.ended_at`), and the clamp at the
 * idle threshold guards against degenerate inputs where the
 * aggregator's own `canExtend` would have rejected the frame.
 */
export class DefaultSessionAggregator implements SessionAggregator {
  constructor(private readonly deps: SessionAggregatorDependencies) {}

  async handleExtraction(
    extraction: ExtractionResult
  ): Promise<HandleExtractionResult> {
    // Defense-in-depth: ensure frameTimestamp is UTC before it reaches
    // the session store as started_at / ended_at. The primary
    // normalization happens in toExtractionInput (indexing-service.ts).
    const normalized: ExtractionResult = {
      ...extraction,
      frameTimestamp: normalizeToUtc(extraction.frameTimestamp)
    };

    const open = await this.deps.store.findOpenSessionFor(
      normalized.appName,
      normalized.contextKey
    );

    if (open !== null && this.canExtend(open, normalized)) {
      const delta = this.computeActiveSecondsDelta(open, normalized);
      await this.deps.store.appendFrame(open.session_id, normalized, {
        activeSecondsDelta: delta
      });
      return { sessionId: open.session_id, created: false };
    }

    if (open !== null) {
      await this.deps.store.closeSession(
        open.session_id,
        this.deps.now().toISOString()
      );
    }

    const sessionId = this.deps.generateSessionId();
    await this.deps.store.createSession({
      session_id: sessionId,
      ...normalized
    });
    return { sessionId, created: true };
  }

  async flushIdleOpenSessions(
    now: Date = this.deps.now()
  ): Promise<FlushIdleResult> {
    // `cutoff = now - idleThreshold`. The store closes any open session
    // whose `ended_at < cutoff` (strict `<`), so a session whose last
    // frame is *exactly* at the threshold survives — the next idle
    // frame will close it on the following pass. The strictness keeps
    // the W11 idempotence claim intact: re-invoking with the same `now`
    // finds zero rows because everything below `cutoff` was already
    // closed on the previous call.
    const cutoff = new Date(
      now.getTime() - this.deps.idleThresholdSeconds * 1000
    ).toISOString();
    const closed = await this.deps.store.closeOpenSessionsEndedBefore(
      cutoff,
      now.toISOString()
    );
    return { closed };
  }

  /**
   * Returns `true` iff the new extraction belongs in the existing open
   * session. The three checks correspond to the W7-W9 properties in
   * `correctness properties` of design §15.
   *
   * `open.app_name` is stored as `appName ?? ''`, so the comparison
   * normalises `extraction.appName` the same way before comparing.
   */
  private canExtend(open: SessionRow, extraction: ExtractionResult): boolean {
    if (open.app_name !== (extraction.appName ?? '')) return false;
    if (open.context_key !== extraction.contextKey) return false;
    const gapSeconds = this.gapSeconds(open, extraction);
    return gapSeconds >= 0 && gapSeconds <= this.deps.idleThresholdSeconds;
  }

  /**
   * Gap between the new frame's timestamp and the open session's
   * `ended_at`, in seconds. Negative when the new frame slid before
   * `ended_at` (rare but possible if the upstream batch arrived out of
   * order). Returned without rounding so {@link computeActiveSecondsDelta}
   * can clamp it.
   */
  private gapSeconds(open: SessionRow, extraction: ExtractionResult): number {
    return (
      (Date.parse(extraction.frameTimestamp) - Date.parse(open.ended_at)) /
      1000
    );
  }

  /**
   * Delta added to `active_seconds` when extending an open session.
   * Clamped to `[0, idleThreshold]`:
   *
   *   - Lower bound 0: absorbs occasional out-of-order frames so we
   *     never decrement `active_seconds`.
   *   - Upper bound `idleThreshold`: defensively caps the delta — by
   *     the time `canExtend` returns `true` the gap is already known
   *     to be ≤ `idleThreshold`, but the explicit clamp guarantees the
   *     property even if a later refactor relaxes `canExtend`.
   *
   * Non-finite inputs (unparseable timestamps) collapse to 0 so the
   * aggregator never propagates `NaN` into the SQL row.
   */
  private computeActiveSecondsDelta(
    open: SessionRow,
    extraction: ExtractionResult
  ): number {
    const gap = this.gapSeconds(open, extraction);
    if (!Number.isFinite(gap)) return 0;
    return Math.max(0, Math.min(gap, this.deps.idleThresholdSeconds));
  }
}
