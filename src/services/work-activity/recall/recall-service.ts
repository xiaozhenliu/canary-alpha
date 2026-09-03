/**
 * `RecallService` — time-window aggregation for the `recall` MCP tool
 * (work-activity-analysis task 8.4, design §8.3).
 *
 * The service answers a `RecallRequest` with one of two shapes:
 *
 *   - `granularity = 'session'` (default) — a list of session items
 *     bucketed individually. When `includeSummary = true`, each item
 *     also carries a `summary` block produced by
 *     {@link SummaryWorker.ensureSummary}.
 *
 *   - `granularity = 'hour' | 'day'` — a list of fixed-width time
 *     blocks aggregating session active-time and per-app breakdown.
 *     A session crossing a bucket boundary contributes to both
 *     buckets in proportion to where its frames fall (see
 *     {@link bucketSessionActiveSeconds} below).
 *
 * Two cross-cutting invariants are mechanically enforced here:
 *
 *   - **R7.15 / W20 — `narrativeText` always present.** Both the
 *     top-level result and each `hour | day` block carry a
 *     non-`null` string in `narrativeText`. Empty result sets fall
 *     back to a fixed sentence; the tool layer copies the field
 *     verbatim into the structured content.
 *
 *   - **R7.16 / W22 — Stateless.** The service does no provider
 *     calls of its own (only delegated to `summaryWorker`), and the
 *     template summary provider returns byte-identical text on
 *     repeat calls. So calling `recall` twice with the same request
 *     against unchanged backing data yields equal `RecallResult`s
 *     down to the field. (The aggregator's `flushIdleOpenSessions`
 *     call is itself idempotent — design §4.)
 *
 * **Validates: Requirements 7.9, 7.10, 7.11, 7.15, 7.16**
 */

import type { ExtractedContentStore } from '../extraction/extracted-content-store.js';
import type { ExtractionResult } from '../extraction/types.js';
import type { SessionAggregator } from '../sessions/aggregator.js';
import type {
  SessionRow,
  SessionStore,
  SummaryProviderKind
} from '../sessions/session-store.js';
import type { SummaryWorker } from '../summary/worker.js';
import type { SummaryStatus } from '../summary/types.js';
import type { PrivacyStateReader } from '../../privacy/types.js';
import { collectActiveCascadeFailureIntervals } from '../suppression.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminator for the requested aggregation shape (R7.9).
 *
 *   - `'session'` (default) — return individual session items.
 *   - `'hour'` / `'day'` — return fixed-width time blocks aggregating
 *     active-time and per-app breakdown across sessions.
 */
export type RecallGranularity = 'session' | 'hour' | 'day';

/**
 * Input shape for `RecallService.recall`. Mirrors the MCP tool
 * `inputSchema` in `src/mcp/tools/recall.ts`. Validation (length,
 * default values, ISO-8601 format) is the tool layer's responsibility
 * — the service trusts what it gets.
 */
export interface RecallRequest {
  from: string;
  to: string;
  granularity?: RecallGranularity;
  appName?: string;
  includeSummary?: boolean;
}

/**
 * One session item returned in `granularity = 'session'` mode (R7.10).
 *
 * `evidenceFrameIds` is a `string[]` per the task contract; the
 * underlying SQL column stores numeric IDs and the service stringifies
 * them on the way out so MCP callers consuming the tool over JSON-RPC
 * can rely on a stable scalar type.
 *
 * `summary` is populated only when `includeSummary = true` AND
 * `SummaryWorker.ensureSummary` returned a usable result. `text`
 * defaults to the empty string when the worker reports a failed /
 * not_applicable lifecycle without text — the schema requires `text`
 * be a string, and emitting an empty string keeps Stateless (W22)
 * idempotent.
 */
export interface RecallSessionItem {
  sessionId: string;
  appName: string;
  contextLabel: string;
  startedAt: string;
  endedAt: string;
  activeSeconds: number;
  evidenceFrameIds: string[];
  sourceTypes: string[];
  summary?: {
    text: string;
    status: SummaryStatus;
    providerKind: SummaryProviderKind;
  };
}

/**
 * One time block returned in `granularity = 'hour' | 'day'` mode
 * (R7.11). Block `narrativeText` is filled by deterministic template
 * concatenation — see design §6.1 / §8.3 for why the LLM provider is
 * NOT called per block (it would explode the per-week call count).
 *
 * `start` and `end` are ISO-8601 strings: `start` is the bucket-floor
 * timestamp and `end = start + 1 hour | 1 day`. Buckets are emitted
 * in ascending `start` order so consumers see a chronological
 * timeline.
 *
 * `byApp` keys are the session's `app_name` column verbatim, EXCEPT
 * an empty string is rewritten to `'unknown'` so the rendered
 * narrative does not produce a stray `": 1 分"` entry.
 */
export interface RecallTimeBlock {
  start: string;
  end: string;
  sessionCount: number;
  totalActiveSeconds: number;
  byApp: Record<string, number>;
  narrativeText: string;
}

/**
 * Discriminated result type — one of the two shapes is returned
 * depending on the requested granularity. The tool layer flattens
 * both into a single structured content object.
 */
export type RecallResult =
  | {
      granularity: 'session';
      sessions: RecallSessionItem[];
      narrativeText: string;
    }
  | {
      granularity: 'hour' | 'day';
      blocks: RecallTimeBlock[];
      narrativeText: string;
    };

/**
 * Service interface — kept narrow so the tool handler unit tests can
 * substitute a stub. `recall` always resolves with a `RecallResult`;
 * the only thrown errors are programmer faults (e.g. missing
 * dependencies) which surface to the MCP tool layer as a defensive
 * `isError: true` envelope.
 */
export interface RecallService {
  recall(request: RecallRequest): Promise<RecallResult>;
}

/**
 * Constructor dependencies for {@link DefaultRecallService}.
 *
 *   - `sessionStore` — read the `sessions` table. The service does
 *     not write through this dep; only `summaryWorker` does (via
 *     `updateSummary`).
 *   - `extractedContentStore` — pull per-frame timestamps so we can
 *     bucket active seconds correctly across hour / day boundaries.
 *   - `sessionAggregator` — `flushIdleOpenSessions(now)` runs at the
 *     entry of every `recall(...)` call so the aggregated result
 *     reflects the latest closure state (design §4 + R3.6 + the
 *     "called from three places" comment in the aggregator).
 *   - `summaryWorker` — invoked once per session in
 *     `granularity='session'` mode when `includeSummary=true`. The
 *     service does NOT call the worker for hour / day blocks
 *     (design §6.1 reserves remote-llm spend for per-session use).
 *   - `now` — wall-clock provider used by the aggregator's flush
 *     pass. Injectable for deterministic tests.
 *   - `idleThresholdSeconds` — clamp on the per-frame slice in
 *     {@link bucketSessionActiveSeconds}. Mirrors
 *     `config.analysis.sessions.idleThresholdSeconds` so the recall
 *     bucketing uses the same idle window the aggregator uses.
 */
export interface DefaultRecallServiceDependencies {
  sessionStore: SessionStore;
  extractedContentStore: ExtractedContentStore;
  sessionAggregator: SessionAggregator;
  summaryWorker: SummaryWorker;
  now: () => Date;
  idleThresholdSeconds: number;
  /**
   * Optional privacy-state reader. When provided, sessions whose
   * `[started_at, ended_at]` interval intersects an unresolved
   * `cascade-failure` suppression window are filtered out so the
   * user does not see content that was supposed to be deleted (R9.1
   * tombstone). Pause / delete-range suppression rows do not gate
   * recall — only cascade-failure tombstones do.
   */
  privacyState?: PrivacyStateReader;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultRecallService implements RecallService {
  constructor(private readonly deps: DefaultRecallServiceDependencies) {}

  async recall(request: RecallRequest): Promise<RecallResult> {
    const granularity: RecallGranularity = request.granularity ?? 'session';
    const includeSummary = request.includeSummary ?? true;

    // Flush idle-open sessions before reading. This is the third
    // call site documented in design §4 (after `IndexingService.runOnce`
    // and `internal-status`), and it is what makes "the most recent
    // session shows up as closed in `recall`" work even when the
    // indexing poller has not run since the last frame arrived.
    await this.deps.sessionAggregator.flushIdleOpenSessions(
      this.deps.now()
    );

    const allSessions = await this.deps.sessionStore.listSessions({
      from: request.from,
      to: request.to,
      appName: request.appName
    });
    const sessions = await this.filterSessionsBySuppression(allSessions);

    if (granularity === 'session') {
      return this.recallBySession(request, sessions, includeSummary);
    }
    return this.recallByTimeBlock(request, sessions, granularity);
  }

  /**
   * Drop sessions whose `[started_at, ended_at]` interval overlaps
   * an unresolved `cascade-failure` suppression range. The session's
   * frames may have already been deleted from the upstream
   * ScreenPipe DB (delete-range succeeded) but the derived
   * `sessions` row could survive a partial cascade — we hide it
   * here so the user does not see ghost data, and let the
   * reconciliation entry point clean it up later.
   */
  private async filterSessionsBySuppression(
    sessions: SessionRow[]
  ): Promise<SessionRow[]> {
    if (this.deps.privacyState === undefined || sessions.length === 0) return sessions;
    let intervals: Array<{ from: number; to: number }>;
    try {
      const state = await this.deps.privacyState.read();
      intervals = collectActiveCascadeFailureIntervals(state.suppressedRanges);
    } catch {
      return sessions;
    }
    if (intervals.length === 0) return sessions;
    return sessions.filter((session) => {
      const sessionFrom = Date.parse(session.started_at);
      const sessionTo = Date.parse(session.ended_at);
      const lo = Number.isFinite(sessionFrom) ? sessionFrom : Number.NEGATIVE_INFINITY;
      const hi = Number.isFinite(sessionTo) ? sessionTo : Number.POSITIVE_INFINITY;
      return !intervals.some((interval) => hi >= interval.from && lo <= interval.to);
    });
  }

  // -----------------------------------------------------------------------
  // granularity = 'session'
  // -----------------------------------------------------------------------

  private async recallBySession(
    request: RecallRequest,
    sessions: SessionRow[],
    includeSummary: boolean
  ): Promise<RecallResult> {
    const items: RecallSessionItem[] = [];
    for (const row of sessions) {
      const item: RecallSessionItem = {
        sessionId: row.session_id,
        appName: row.app_name,
        contextLabel: row.context_label,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        // `active_seconds` accumulates fractional frame deltas (e.g. 12.416),
        // but the tool's outputSchema declares `activeSeconds` as an integer.
        // Round to whole seconds at the boundary so the structured payload
        // validates — otherwise the MCP SDK rejects every non-empty recall
        // result with an "Output validation error". (Whole-second granularity
        // is all the recall surface promises.)
        activeSeconds: Math.round(row.active_seconds),
        // The schema declares `evidenceFrameIds: string[]`. SQL stores
        // numeric IDs; stringify here so MCP consumers see a stable
        // scalar type regardless of language.
        evidenceFrameIds: row.evidence_frame_ids.map(String),
        sourceTypes: [...row.source_types]
      };
      if (includeSummary) {
        const summary = await this.deps.summaryWorker.ensureSummary(
          row.session_id
        );
        item.summary = {
          // The schema requires `text` be a string. When the worker
          // returns `null` (failed / not_applicable / missing row),
          // emit an empty string — Stateless (W22) is preserved
          // because the underlying lifecycle is also deterministic
          // for repeat calls.
          text: summary.text ?? '',
          status: summary.status,
          providerKind: summary.providerKind
        };
      }
      items.push(item);
    }
    return {
      granularity: 'session',
      sessions: items,
      narrativeText: buildSessionNarrative(request, items)
    };
  }

  // -----------------------------------------------------------------------
  // granularity = 'hour' | 'day'
  // -----------------------------------------------------------------------

  private async recallByTimeBlock(
    request: RecallRequest,
    sessions: SessionRow[],
    granularity: 'hour' | 'day'
  ): Promise<RecallResult> {
    const buckets = new Map<string, BucketAggregate>();

    // Batch-fetch all frames for all sessions in one call (Phase 2.1)
    const allFrameIds = sessions.flatMap(s => s.evidence_frame_ids);
    const allFrames = await this.deps.extractedContentStore.getByFrameIds(allFrameIds);
    const framesByIdMap = new Map(allFrames.map(f => [f.frameId, f]));

    for (const session of sessions) {
      const frames = session.evidence_frame_ids
        .map(id => framesByIdMap.get(id))
        .filter((f): f is ExtractionResult => f !== undefined);

      const orderedFrames = frames
        .slice()
        .sort(
          (a, b) =>
            (Date.parse(a.frameTimestamp) || 0) -
            (Date.parse(b.frameTimestamp) || 0)
        );

      const fetchedIds = new Set(frames.map((f) => f.frameId));
      const missingCount = session.evidence_frame_ids.reduce(
        (acc, id) => acc + (fetchedIds.has(id) ? 0 : 1),
        0
      );
      const perBucket = bucketSessionActiveSeconds(
        orderedFrames,
        granularity,
        this.deps.idleThresholdSeconds
      );
      if (missingCount > 0) {
        const fallbackBucket = floorToBucketSafe(
          session.started_at,
          granularity
        );
        if (fallbackBucket !== null) {
          perBucket.set(
            fallbackBucket,
            (perBucket.get(fallbackBucket) ?? 0) + missingCount
          );
        }
      }

      // sessionCount counts each session once per bucket it touches —
      // i.e. a session that spans two hours contributes 1 to each of
      // those two hours, not 2 to either.
      for (const [bucketKey, secs] of perBucket) {
        let agg = buckets.get(bucketKey);
        if (agg === undefined) {
          agg = {
            start: bucketKey,
            end: addBucket(bucketKey, granularity),
            sessionCount: 0,
            totalActiveSeconds: 0,
            byApp: {}
          };
          buckets.set(bucketKey, agg);
        }
        agg.sessionCount += 1;
        agg.totalActiveSeconds += secs;
        const app = displayAppName(session.app_name);
        agg.byApp[app] = (agg.byApp[app] ?? 0) + secs;
      }
    }

    const blocks: RecallTimeBlock[] = Array.from(buckets.values())
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((agg) => ({
        ...agg,
        // Same integer-seconds contract as session granularity: the bucket
        // totals accumulate fractional `secs`, so round both the aggregate
        // and each per-app value before they reach the int-typed outputSchema.
        totalActiveSeconds: Math.round(agg.totalActiveSeconds),
        byApp: Object.fromEntries(
          Object.entries(agg.byApp).map(([app, secs]) => [app, Math.round(secs)])
        ),
        narrativeText: buildBlockNarrative(agg)
      }));

    return {
      granularity,
      blocks,
      narrativeText: buildTimeBlockNarrative(request, blocks)
    };
  }
}

// ---------------------------------------------------------------------------
// Bucket aggregation
// ---------------------------------------------------------------------------

/**
 * Per-bucket scratch record used while folding sessions into time
 * blocks. Once all sessions are in, each entry materialises into a
 * {@link RecallTimeBlock} via {@link buildBlockNarrative}.
 */
interface BucketAggregate {
  start: string;
  end: string;
  sessionCount: number;
  totalActiveSeconds: number;
  byApp: Record<string, number>;
}

/**
 * Splits a session's active-time across the hour / day buckets its
 * frames fall in.
 *
 * For each frame `f[i]`:
 *
 *   - The bucket key is `floorToBucket(f[i].timestamp, granularity)`.
 *   - The "slice" attributed to that bucket is the gap between
 *     `f[i]` and `f[i+1]`, clamped to `[0, idleThresholdSeconds]`.
 *     The clamp matches the aggregator's own `computeActiveSecondsDelta`
 *     logic (see `aggregator.ts`), so the recall total reconciles
 *     with `sessions.active_seconds` for the common case.
 *   - The last frame in a session contributes a fixed 1 second
 *     (no successor to measure against). This matches the design §8.3
 *     `bucketSessionActiveSeconds` pseudocode verbatim.
 *
 * The function returns a `Map<bucketKey, seconds>`. An empty input
 * yields an empty map — callers MUST treat that as "this session
 * contributes nothing to any bucket" rather than failing.
 */
function bucketSessionActiveSeconds(
  frames: ExtractionResult[],
  granularity: 'hour' | 'day',
  idleThresholdSeconds: number
): Map<string, number> {
  const result = new Map<string, number>();
  if (frames.length === 0) return result;

  for (let i = 0; i < frames.length; i++) {
    const bucketKey = floorToBucketSafe(frames[i].frameTimestamp, granularity);
    if (bucketKey === null) {
      // Unparseable timestamp: skip this frame entirely. The slice
      // it would have contributed is forfeit, but the rest of the
      // session continues to bucket cleanly. Returning a `null`
      // bucket would propagate a poison key into the aggregate map.
      continue;
    }
    let slice: number;
    if (i + 1 < frames.length) {
      const ms0 = Date.parse(frames[i].frameTimestamp);
      const ms1 = Date.parse(frames[i + 1].frameTimestamp);
      // Both timestamps must parse to a number for the gap to be
      // meaningful. Anything else collapses to a `0` slice — better
      // than emitting a fractional or negative second into a schema
      // declared as `int().nonnegative()`.
      const gap =
        Number.isFinite(ms0) && Number.isFinite(ms1) ? (ms1 - ms0) / 1000 : 0;
      // Match the aggregator's `computeActiveSecondsDelta` clamp,
      // then floor to the integer second the schema requires.
      slice = Math.floor(Math.max(0, Math.min(gap, idleThresholdSeconds)));
    } else {
      // Last frame: design §8.3 default of 1 second.
      slice = 1;
    }
    result.set(bucketKey, (result.get(bucketKey) ?? 0) + slice);
  }
  return result;
}

/**
 * Returns the ISO-8601 floor of `timestamp` to the requested
 * granularity, in UTC. Returns `null` when `timestamp` is
 * unparseable rather than throwing — `new Date(NaN).toISOString()`
 * raises `RangeError`, which would otherwise escape
 * {@link bucketSessionActiveSeconds} and degrade the entire
 * `recall(...)` call into the catch-all error path.
 *
 * We deliberately use UTC rather than the caller's local time zone
 * because:
 *
 *   - The MCP transport is JSON-RPC and the tool input is ISO-8601
 *     strings (typically UTC). The output bucket boundaries should
 *     align with those bounds rather than drift across a DST shift.
 *   - Stateless (W22) requires deterministic output regardless of
 *     where the process happens to run.
 *
 * Hour bucket: `2026-05-25T13:42:17.123Z → 2026-05-25T13:00:00.000Z`.
 * Day  bucket: `2026-05-25T13:42:17.123Z → 2026-05-25T00:00:00.000Z`.
 */
function floorToBucketSafe(
  timestamp: string,
  granularity: 'hour' | 'day'
): string | null {
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (granularity === 'hour') {
    return new Date(
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        d.getUTCHours()
      )
    ).toISOString();
  }
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  ).toISOString();
}

/**
 * Returns the ISO-8601 timestamp of the next bucket boundary after
 * `bucketKey` for the requested granularity (also UTC). Used to fill
 * the `end` field of a {@link RecallTimeBlock}.
 */
function addBucket(
  bucketKey: string,
  granularity: 'hour' | 'day'
): string {
  const d = new Date(bucketKey);
  if (granularity === 'hour') {
    return new Date(d.getTime() + 60 * 60 * 1000).toISOString();
  }
  return new Date(d.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// narrativeText templates
// ---------------------------------------------------------------------------

/**
 * Builds the deterministic top-level `narrativeText` for a
 * `granularity = 'session'` response (R7.10).
 *
 * The template (locked in by task 8.4's spec) is:
 *
 *     "在 {from} 至 {to} 内有 {N} 个会话，覆盖 {apps} 应用，总活跃 {minutes} 分钟。"
 *
 * Note that design.md §8.3 sketches an alternate `includeSummary=true`
 * branch that joins the per-session `summary.text` values with
 * newlines. Task 8.4 of `tasks.md` overrides that and pins the single
 * deterministic aggregate template for both `includeSummary=true` and
 * `=false` so the top-level narrative stays bounded in length and
 * stable across runs (Stateless / W22). Per-session summaries remain
 * accessible on each `RecallSessionItem.summary.text`.
 *
 * Empty result sets collapse to `"该时段内未发现会话。"` (W20: the
 * field is always a non-null string).
 *
 * App names are deduplicated and sorted alphabetically so output is
 * deterministic across runs and reorderings of the input session set.
 */
function buildSessionNarrative(
  request: RecallRequest,
  items: RecallSessionItem[]
): string {
  if (items.length === 0) return '该时段内未发现会话。';
  const totalActive = items.reduce((acc, it) => acc + it.activeSeconds, 0);
  const minutes = Math.round(totalActive / 60);
  const apps = Array.from(
    new Set(items.map((it) => displayAppName(it.appName)))
  )
    .sort((a, b) => a.localeCompare(b))
    .join(', ');
  return (
    `在 ${request.from} 至 ${request.to} 内有 ${items.length} 个会话，` +
    `覆盖 ${apps} 应用，总活跃 ${minutes} 分钟。`
  );
}

/**
 * Builds the deterministic top-level `narrativeText` for a
 * `granularity = 'hour' | 'day'` response (R7.11). Empty result sets
 * collapse to the same `"该时段内未发现会话。"` sentinel as the
 * session-mode response.
 */
function buildTimeBlockNarrative(
  request: RecallRequest,
  blocks: RecallTimeBlock[]
): string {
  if (blocks.length === 0) return '该时段内未发现会话。';
  const totalActive = blocks.reduce(
    (acc, b) => acc + b.totalActiveSeconds,
    0
  );
  const minutes = Math.round(totalActive / 60);
  return (
    `在 ${request.from} 至 ${request.to} 内分布于 ${blocks.length} 个时段，` +
    `总活跃 ${minutes} 分钟。`
  );
}

/**
 * Builds the per-block `narrativeText` for an hour / day bucket. The
 * template is fixed per design §8.3 / task 8.4:
 *
 *     "该时段共 N 个会话（appA: X 分；appB: Y 分；...），活跃 M 分钟。"
 *
 * App breakdown order: descending by seconds, ascending by name on
 * ties — same convention used by `find-service.ts` so two work-activity
 * tools surface stable, comparable orderings.
 */
function buildBlockNarrative(agg: BucketAggregate): string {
  const minutes = Math.round(agg.totalActiveSeconds / 60);
  const breakdown = Object.entries(agg.byApp)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .map(([app, secs]) => `${app}: ${Math.round(secs / 60)} 分`)
    .join('；');
  return (
    `该时段共 ${agg.sessionCount} 个会话（${breakdown}），活跃 ${minutes} 分钟。`
  );
}

/**
 * Coerces an empty `app_name` (the column convention for "no app
 * recorded" — see `aggregator.ts`'s `appName ?? ''`) to the literal
 * `'unknown'` for display purposes. The session row keeps the empty
 * string verbatim; only the rendered narrative strings and the
 * `byApp` keys see this rewrite.
 */
function displayAppName(appName: string): string {
  return appName.length === 0 ? 'unknown' : appName;
}
