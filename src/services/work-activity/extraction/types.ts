/**
 * Extraction layer type definitions.
 *
 * These types are shared by the extraction registry and rules implemented in
 * the same package (`generic.ts`, `terminal.ts`, `registry.ts`). The shapes
 * are taken verbatim from the work-activity-analysis design document, §2
 * "Extraction_Rule and Extraction_Registry".
 *
 * The extraction layer turns a raw ScreenPipe AX frame into a per-frame
 * `ExtractionResult` that downstream consumers (Session_Aggregator,
 * Embedding_Service, ExtractedContentStore) operate on. A result is always
 * produced — when the heuristic cannot find usable text, an
 * `Empty_Extraction` (extractedText='') is emitted with a non-empty
 * `contextLabel` (R1.6).
 */

/**
 * Discriminator describing which rule produced an `ExtractionResult`. Used
 * downstream for observability (R2 `extraction.byRuleKind`) and CI evaluation
 * (precision/recall computed per rule kind).
 *
 * The first version ships only `'generic'` (Generic_Heuristic) and
 * `'terminal'` (Terminal_Refinement_Rule); future refinement rules append
 * new literal members rather than reusing existing ones (R1.8 — derived data
 * is rebuilt on rule version changes, so adding a new kind is safe).
 */
export type ExtractionRuleKind = 'generic' | 'terminal';

/**
 * The raw input handed to an `ExtractionRule`. A single frame's relevant
 * fields are pulled from ScreenPipe `frames` (plus the `sourceTypes` array
 * synthesised by the upstream merge in `accessibility-capture-ingestion`).
 *
 * `accessibilityTreeJson` is the raw JSON string from
 * `frames.accessibility_tree_json`; rules that need a structured view parse
 * it lazily. `null` means the upstream had no AX tree available — rules
 * SHALL fall back to `Empty_Extraction` in that case (see Generic_Heuristic
 * in §2 of the design document).
 */
export interface ExtractionInput {
  frameId: number;
  frameTimestamp: string;
  /** Original capture cursor used to order same-timestamp checkpoint rows. */
  captureCursor?: string;
  appName?: string;
  /**
   * The original (un-normalised) window title, taken from the AX tree's
   * `AXTitle` or the upstream `windowName` — whichever is available. It is
   * preserved verbatim because `Context_Key` normalises it separately and
   * `contextLabel` keeps the raw form for human display.
   */
  windowTitle?: string;
  accessibilityTreeJson: string | null;
  /**
   * Always a string array (per accessibility-capture-ingestion design). Only
   * records whose `sourceTypes` contain `'accessibility'` make it this far
   * — OCR-only records are filtered upstream (R1.7).
   */
  sourceTypes: string[];
}

/**
 * The normalised, per-frame extraction record persisted to
 * `extracted_content` (see derived schema §1) and consumed by the session
 * aggregator and embedding service.
 *
 * `contextLabel` is REQUIRED non-empty (R1.6); when the raw window title is
 * empty, derive it from `appName`, falling back to the literal `'unknown'`.
 * Use {@link ../sessions/context-key.ts deriveContextLabel} to compute it.
 *
 * `contextKey` is the normalised join `${appName}::${normalizeWindowTitle(windowTitle)}`
 * computed by {@link ../sessions/context-key.ts buildContextKey}.
 *
 * `extractedTextHash` is `null` for `Empty_Extraction` (extractedText='') and
 * SHA256 hex of `extractedText` otherwise (R5.1).
 */
export interface ExtractionResult {
  frameId: number;
  frameTimestamp: string;
  /** Original capture cursor preserved for durable checkpoint recovery. */
  captureCursor?: string;
  appName?: string;
  contextLabel: string;
  contextKey: string;
  extractedText: string;
  extractedTextHash: string | null;
  extractionRuleKind: ExtractionRuleKind;
  sourceTypes: string[];
}

/**
 * A single extraction rule. `matches` is a fast guard so the registry can
 * skip rules cheaply; `extract` produces the final result. Rules are
 * deterministic — calling `extract` twice with the same input MUST return
 * byte-equal results (Determinism property, R1).
 *
 * The `Generic_Heuristic` rule's `matches` always returns `true` (it is the
 * tail-of-chain fallback); refinement rules guard on `appName` membership
 * and may inspect the AX tree shape.
 */
export interface ExtractionRule {
  readonly kind: ExtractionRuleKind;
  matches(input: ExtractionInput): boolean;
  extract(input: ExtractionInput): ExtractionResult;
}

/**
 * The registry collects rules in priority order (refinement rules first,
 * generic last) and exposes a single `extract` method. Implementations MUST
 * call rules in order and return the first match's result; the generic rule
 * acts as a guaranteed fallback so `extract` always returns a result
 * (Coverage property, R1).
 */
export interface ExtractionRegistry {
  extract(input: ExtractionInput): ExtractionResult;
}
