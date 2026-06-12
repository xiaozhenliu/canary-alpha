/**
 * `InspectService` — read-only deep-dive for a single session or
 * frame, backing the `inspect` MCP tool (work-activity-analysis task
 * 8.5).
 *
 * The service has two distinct code paths, dispatched on the
 * `target.kind` discriminator (design §8.4):
 *
 *   - **`target.kind === 'session'`** — load the row from the
 *     `sessions` table, batch-fetch the per-frame `extracted_content`
 *     records named in `evidence_frame_ids`, then ask
 *     {@link SummaryWorker.ensureSummary} to materialise (or return
 *     the cached) `summary` block. The result mirrors the shape used
 *     by `recall(granularity='session', includeSummary=true)` so a
 *     UI can re-use the same renderer.
 *
 *   - **`target.kind === 'frame'`** — read the five-column projection
 *     of ScreenPipe's upstream `frames` table via the supplied
 *     {@link ScreenpipeFramesReader}, plus the (optional) derived
 *     `extracted_content` row. The narrative for this path is a
 *     deterministic template (no provider call) because a single
 *     frame is too small a unit of work to be worth an LLM round
 *     trip.
 *
 * Failure handling (design §"Failure modes & degraded paths"):
 *
 *   - Session not found → returns `kind: 'session'` with an empty
 *     evidence array and a friendly narrative; we do NOT throw.
 *   - Frame not found in ScreenPipe + no derived row →
 *     `kind: 'frame'` with `frame: null`, an empty `extractedContent`,
 *     and a narrative that points the user at the cascade-delete /
 *     trim retention as the likely cause.
 *   - Either store throwing → the tool wrapper (see `inspect.ts`)
 *     catches it and returns the documented "派生数据当前不可访问"
 *     degraded shape. The service itself never `try/catch`-es around
 *     SQL — a thrown SQLite exception genuinely indicates a bug.
 *
 * **Validates: Requirements 7.12, 7.13, 7.14, 7.15**
 */

import type {
  ExtractedContentStore
} from '../extraction/extracted-content-store.js';
import type { ExtractionResult } from '../extraction/types.js';
import type { SessionStore, SessionRow } from '../sessions/session-store.js';
import type { SummaryWorker, EnsureSummaryResult } from '../summary/worker.js';
import type {
  ScreenpipeFrameRow,
  ScreenpipeFramesReader
} from '../../capture/providers/screenpipe/frames-reader.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated input. Mirrors the MCP tool `inputSchema` in
 * {@link ../../../mcp/tools/inspect.ts}; the discriminator is the
 * presence of `sessionId` vs `frameId` (the wrapper schema accepts
 * either form). The service trusts the wrapper to have already
 * validated mutual exclusivity.
 */
export type InspectTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'frame'; frameId: number | string };

/**
 * Per-frame evidence shape returned by the session path. Mirrors
 * {@link EvidenceItem} from `find/find-service.ts` *minus* the
 * search-only fields (`matchSource`, `score`); design §8.4 specifies
 * the schema for `inspect.session.evidence` differs from `find.data`
 * because there is no match concept on inspect.
 */
export interface InspectEvidenceItem {
  frameId: number;
  sessionId: string;
  appName?: string;
  contextLabel: string;
  extractedText: string;
  timestamp: string;
  sourceTypes: string[];
}

/**
 * Session-path summary block (the same triple the SummaryWorker
 * returns). Optional because a session whose row is missing or whose
 * worker call yielded `failed` will still return a meaningful `kind:
 * 'session'` payload with no `summary`.
 */
export interface InspectSessionSummary {
  text: string;
  status: EnsureSummaryResult['status'];
  providerKind: EnsureSummaryResult['providerKind'];
}

/**
 * Session row projection delivered to the tool layer. Field shapes
 * match the `sessionItemSchema` declared in
 * {@link ../../../mcp/tools/recall.ts} (design §8.3) so the tool
 * wrapper can re-use that schema.
 */
export interface InspectSessionItem {
  sessionId: string;
  appName: string;
  contextLabel: string;
  startedAt: string;
  endedAt: string;
  activeSeconds: number;
  evidenceFrameIds: number[];
  sourceTypes: string[];
  summary?: InspectSessionSummary;
}

/**
 * Result of `inspect({sessionId})`. `session === null` indicates the
 * sessionId did not exist (cascade-deleted, or never created); the
 * narrative explains the case.
 */
export interface InspectSessionResult {
  kind: 'session';
  session: InspectSessionItem | null;
  evidence: InspectEvidenceItem[];
  narrativeText: string;
}

/**
 * Result of `inspect({frameId})`. `frame === null` when ScreenPipe's
 * `db.sqlite` is unreadable or the frame ID does not exist there;
 * `extractedContent === null` when the derived `extracted_content`
 * row is also absent (e.g. cascade-deleted). At least one of the two
 * fields is normally populated — the narrative makes the difference
 * explicit.
 */
export interface InspectFrameResult {
  kind: 'frame';
  frame: {
    frameId: number | string;
    timestamp: string;
    appName?: string;
    windowName?: string;
    accessibilityTreeJson: string | null;
  } | null;
  extractedContent: {
    frameId: number;
    appName?: string;
    contextLabel: string;
    extractedText: string;
    timestamp: string;
    sourceTypes: string[];
  } | null;
  narrativeText: string;
}

/**
 * Discriminated union returned by {@link InspectService.inspect}.
 * The discriminator (`kind`) matches the input's `target.kind` so
 * callers can branch on the same field they sent in.
 */
export type InspectResult = InspectSessionResult | InspectFrameResult;

/**
 * Service interface. The single method always resolves — failures
 * surface as the empty / null variants described above. Callers (the
 * tool wrapper) MAY still wrap the call in a try/catch to defend
 * against unexpected SQL exceptions, but the service contract is
 * "always resolves with a structured result".
 */
export interface InspectService {
  inspect(target: InspectTarget): Promise<InspectResult>;
}

/**
 * Constructor dependencies for {@link DefaultInspectService}.
 *
 *   - `sessionStore` — session-path row reader.
 *   - `extractedContentStore` — bulk reader for evidence rows; also
 *     used by the frame-path to surface the derived snippet.
 *   - `summaryWorker` — materialises the session's `summary` block
 *     (idempotent; design §6.5).
 *   - `screenpipeFramesReader` — read-only port over ScreenPipe's
 *     `frames` table; abstracted so tests can swap in an in-memory
 *     stub without spawning a real `db.sqlite`.
 *   - `now` — wall-clock provider, kept for symmetry with the rest
 *     of the work-activity services. The inspect path does not
 *     currently need a clock; the field is reserved for a future
 *     "summary cache TTL" knob and accepted as optional.
 */
export interface InspectServiceDependencies {
  sessionStore: SessionStore;
  extractedContentStore: ExtractedContentStore;
  summaryWorker: SummaryWorker;
  screenpipeFramesReader: ScreenpipeFramesReader;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Default `InspectService` implementation. The class is a thin
 * orchestrator over the four collaborators — no caching, no
 * background work, no shared state. Each `inspect` call reads from
 * the canonical stores so the result is always fresh.
 */
export class DefaultInspectService implements InspectService {
  constructor(private readonly deps: InspectServiceDependencies) {}

  async inspect(target: InspectTarget): Promise<InspectResult> {
    if (target.kind === 'session') {
      return this.inspectSession(target.sessionId);
    }
    return this.inspectFrame(target.frameId);
  }

  // -----------------------------------------------------------------------
  // Session path
  // -----------------------------------------------------------------------

  private async inspectSession(sessionId: string): Promise<InspectSessionResult> {
    const row = await this.deps.sessionStore.getSession(sessionId);
    if (row === null) {
      return {
        kind: 'session',
        session: null,
        evidence: [],
        narrativeText: `未找到会话 ${sessionId}（可能已被清理或从未存在）。`
      };
    }

    // Load evidence first; the SummaryWorker call may also touch the
    // same store, but that is fine — both reads see the same point-
    // in-time snapshot.
    const evidenceRows = await this.deps.extractedContentStore.getByFrameIds(
      row.evidence_frame_ids
    );
    const evidence = orderEvidenceByFrameIdList(evidenceRows, row.evidence_frame_ids).map(
      (extraction) => evidenceItemFromExtraction(extraction, sessionId)
    );

    // Materialise (or read cached) summary. The worker is idempotent
    // — calling it on an already-`'ready'` session is a fast read.
    const summaryResult = await this.deps.summaryWorker.ensureSummary(sessionId);
    const summary: InspectSessionSummary | undefined =
      summaryResult.text === null
        ? undefined
        : {
            text: summaryResult.text,
            status: summaryResult.status,
            providerKind: summaryResult.providerKind
          };

    const session: InspectSessionItem = {
      sessionId: row.session_id,
      appName: row.app_name,
      contextLabel: row.context_label,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      activeSeconds: row.active_seconds,
      evidenceFrameIds: row.evidence_frame_ids,
      sourceTypes: row.source_types,
      summary
    };

    return {
      kind: 'session',
      session,
      evidence,
      narrativeText: buildSessionNarrative(row, summary)
    };
  }

  // -----------------------------------------------------------------------
  // Frame path
  // -----------------------------------------------------------------------

  private async inspectFrame(
    frameId: number | string
  ): Promise<InspectFrameResult> {
    // Run both reads in parallel — ScreenPipe and the derived
    // database are independent SQLite connections, so we save the
    // round-trip latency.
    const [frameRow, derivedRows] = await Promise.all([
      this.deps.screenpipeFramesReader.getFrame(frameId),
      this.deps.extractedContentStore.getByFrameIds(numericFrameIds(frameId))
    ]);
    const derived = derivedRows[0] ?? null;

    const frame =
      frameRow === null
        ? null
        : {
            // Echo the original ID type back to the caller so a
            // string-typed input round-trips as a string in the
            // response. The reader has already coerced internally.
            frameId: typeof frameId === 'string' ? frameId : Number(frameId),
            timestamp: frameRow.timestamp,
            appName: frameRow.appName,
            windowName: frameRow.windowName,
            accessibilityTreeJson: frameRow.accessibilityTreeJson
          };

    const extractedContent =
      derived === null
        ? null
        : {
            frameId: derived.frameId,
            appName: derived.appName,
            contextLabel: derived.contextLabel,
            extractedText: derived.extractedText,
            timestamp: derived.frameTimestamp,
            sourceTypes: derived.sourceTypes
          };

    return {
      kind: 'frame',
      frame,
      extractedContent,
      narrativeText: buildFrameNarrative(frameId, frameRow, derived)
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reorders the rows returned by `getByFrameIds(...)` to match the
 * caller's input order. The store does not guarantee an ordering —
 * its underlying SQL `IN (...)` clause returns rows in undefined
 * order — so we sort here to keep evidence in chronological order
 * (the aggregator's `appendFrame` already inserts frame IDs in time
 * order).
 *
 * Frames missing from `extracted_content` (a cascade-delete race or
 * a dropped table) are silently dropped. The session narrative
 * notes when this happens, but the evidence array stays consistent
 * with the IDs we actually have data for.
 */
function orderEvidenceByFrameIdList(
  rows: ExtractionResult[],
  frameIds: ReadonlyArray<number>
): ExtractionResult[] {
  if (rows.length === 0) return [];
  const byId = new Map(rows.map((row) => [row.frameId, row]));
  const ordered: ExtractionResult[] = [];
  for (const id of frameIds) {
    const row = byId.get(id);
    if (row !== undefined) ordered.push(row);
  }
  return ordered;
}

function evidenceItemFromExtraction(
  e: ExtractionResult,
  sessionId: string
): InspectEvidenceItem {
  return {
    frameId: e.frameId,
    sessionId,
    appName: e.appName,
    contextLabel: e.contextLabel,
    extractedText: e.extractedText,
    timestamp: e.frameTimestamp,
    sourceTypes: e.sourceTypes
  };
}

/**
 * Coerces the loosely-typed `frameId` into the numeric array shape
 * that `ExtractedContentStore.getByFrameIds` expects. Returns an
 * empty array for inputs that cannot represent a positive integer
 * (NaN, fractional, non-numeric strings) so the caller still gets a
 * deterministic empty result rather than crashing the SQL layer.
 */
function numericFrameIds(input: number | string): number[] {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isInteger(input)) return [];
    return [input];
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return [];
  if (!/^-?\d+$/.test(trimmed)) return [];
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return [];
  return [parsed];
}

/**
 * Builds the deterministic narrative for the session path. Mirrors
 * the template the prompt suggests:
 *
 *   "会话 ${appName} | ${contextLabel}（${startedAt} → ${endedAt},
 *    ${minutes} 分钟，${frameCount} 帧）。"
 *
 * Plus an optional trailing summary sentence so callers see the
 * worker's text inline without re-rendering it. When the summary
 * worker returned `'failed'` / `'not_applicable'` (i.e. `text === null`)
 * the trailing sentence is omitted entirely.
 */
function buildSessionNarrative(
  row: SessionRow,
  summary: InspectSessionSummary | undefined
): string {
  const minutes = Math.max(1, Math.round(row.active_seconds / 60));
  const frameCount = row.evidence_frame_ids.length;
  const appName = row.app_name.length === 0 ? 'unknown' : row.app_name;
  const head = `会话 ${appName} | ${row.context_label}（${row.started_at} → ${row.ended_at}，${minutes} 分钟，${frameCount} 帧）。`;
  if (summary === undefined) return head;
  return `${head}\n${summary.text}`;
}

/**
 * Builds the deterministic narrative for the frame path. Three
 * cases:
 *
 *   - Both ScreenPipe row and derived row present → header
 *     describing the frame plus the extraction rule annotation.
 *   - ScreenPipe row absent, derived row present → "原始 AX 树不可
 *     访问；仅返回派生抽取记录" — taken verbatim from
 *     design.md §"Failure modes" so observability tests can grep
 *     for the marker.
 *   - Both absent → friendly "frame 不存在" message.
 *
 * The derived-row-only message is also used when the ScreenPipe
 * reader returns `null` despite the frame existing in derived
 * storage — the user probably hit a cascade-delete window where
 * ScreenPipe's row was retention-trimmed but the derived row had not
 * yet been GC'd. Either way, surfacing the derived row keeps the
 * tool useful.
 */
function buildFrameNarrative(
  frameId: number | string,
  frameRow: ScreenpipeFrameRow | null,
  derivedRow: ExtractionResult | null
): string {
  if (frameRow === null && derivedRow === null) {
    return `未找到 frame ${frameId}（ScreenPipe 与派生数据库均无记录）。`;
  }
  if (frameRow === null) {
    // `derivedRow !== null` here — the user can still inspect the
    // extracted text + context label, just not the raw AX tree.
    const ruleKind = derivedRow!.extractionRuleKind;
    return `原始 AX 树不可访问；仅返回派生抽取记录（抽取规则 ${ruleKind}）。`;
  }
  // Frame row present (derived may or may not be present).
  const appName = frameRow.appName ?? 'unknown';
  const windowName = frameRow.windowName ?? '';
  const ruleKind = derivedRow?.extractionRuleKind ?? 'n/a';
  return `帧 ${frameRow.id}：${appName} | ${windowName}（${frameRow.timestamp}），抽取规则 ${ruleKind}。`;
}
