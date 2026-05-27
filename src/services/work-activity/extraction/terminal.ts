/**
 * Terminal_Refinement_Rule — the first (and so far only) per-application
 * refinement rule in the extraction registry.
 *
 * Terminal emulators (`Terminal.app`, `iTerm2`, …) consistently expose
 * their entire visible buffer as a single `AXTextArea` subtree. The
 * generic heuristic would handle this correctly in most cases, but a
 * focused-element ancestor walk can degrade quality when a transient
 * popup steals focus (search bar, command palette). This rule short-
 * circuits that path: when the frame's `appName` is a known terminal
 * emulator, we take the **first** `AXTextArea` subtree's flattened text
 * as the body, regardless of focus state.
 *
 * The behaviour matches the work-activity-analysis design document, §2
 * "Components and Interfaces — Extraction_Registry" (`terminal.ts` 命中
 * 条件 + 取唯一 AXTextArea 子树文本).
 *
 * Design choices worth calling out:
 *
 *   - **First AXTextArea wins.** Terminal apps almost always expose a
 *     single AXTextArea (the terminal buffer). The design leaves the
 *     "multiple AXTextArea" tie-breaker open ("取第一个或合并"); we pick
 *     "first" as it is deterministic and avoids cross-window noise from
 *     a possible secondary panel (e.g. iTerm's split panes — taking the
 *     first matches the focus path most users expect).
 *   - **Reuses `flattenSubtreeText`.** The flatten helper drops UI
 *     chrome (`AXScrollBar`, `AXImage`, …) which is still appropriate
 *     inside a terminal AXTextArea (some terminals expose decorative
 *     scroll bars as siblings). The rule does NOT route through the
 *     generic anchor discovery — that is the whole point of having a
 *     refinement rule.
 *   - **`contextLabel` uses `deriveContextLabel`.** Per the design, the
 *     terminal rule keeps the un-normalised display title (after
 *     `deriveContextLabel`'s outer-whitespace trim — e.g. `~/code (zsh)`
 *     remains case- and accent-preserving) for human display;
 *     `Context_Key` still normalises it via {@link buildContextKey}.
 *   - **Error fallthrough mirrors `GenericHeuristicRule`.** Null AX
 *     JSON, malformed JSON, schema mismatch, no AXTextArea found, or
 *     blank flattened text all collapse to an `Empty_Extraction`. The
 *     extraction loop in `IndexingService.runOnce()` never breaks on
 *     malformed terminal payloads.
 */

import { createHash } from 'node:crypto';

import { buildContextKey, deriveContextLabel } from '../sessions/context-key.js';
import { flattenSubtreeText } from './generic.js';
import type {
  ExtractionInput,
  ExtractionResult,
  ExtractionRule
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Application names that activate the Terminal_Refinement_Rule.
 *
 * The list matches the macOS-reported `appName` values for the most
 * common terminal emulators. Adding new entries (Alacritty, Warp,
 * wezterm, kitty, …) is a backwards-compatible change because derived
 * `extracted_content` rows are rebuilt on rule version changes
 * (R1.8 / R3.8) — historical data does not need to migrate.
 *
 * The set is exported so unit + property-based tests can assert
 * `Refinement_Override` (W3) without duplicating the membership list.
 */
export const TERMINAL_APP_NAMES: ReadonlySet<string> = new Set([
  'Terminal',
  'iTerm',
  'iTerm2'
]);

// ---------------------------------------------------------------------------
// AX tree shape (structurally compatible with `generic.ts`)
// ---------------------------------------------------------------------------

/**
 * Permissive AX-node shape — every field optional, `children` an array of
 * recursively shaped nodes. The interface mirrors the one in
 * `generic.ts` so `flattenSubtreeText` can consume nodes produced here
 * via TypeScript's structural typing.
 */
interface AccessibilityNode {
  role?: string;
  title?: string;
  description?: string;
  value?: string;
  text?: string;
  focused?: boolean;
  children?: AccessibilityNode[];
}

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

/**
 * The Terminal_Refinement_Rule. `matches` short-circuits on `appName`
 * membership (R1.4), and `extract` takes the first `AXTextArea`
 * subtree's flattened text as the body.
 */
export class TerminalRefinementRule implements ExtractionRule {
  readonly kind = 'terminal' as const;

  matches(input: ExtractionInput): boolean {
    return input.appName !== undefined && TERMINAL_APP_NAMES.has(input.appName);
  }

  extract(input: ExtractionInput): ExtractionResult {
    const contextLabel = deriveContextLabel(input.windowTitle, input.appName);
    const contextKey = buildContextKey(input.appName, input.windowTitle);

    const text = this.tryExtract(input);
    if (text !== null && text.trim() !== '') {
      return {
        frameId: input.frameId,
        frameTimestamp: input.frameTimestamp,
        appName: input.appName,
        contextLabel,
        contextKey,
        extractedText: text,
        extractedTextHash: sha256Hex(text),
        extractionRuleKind: 'terminal',
        sourceTypes: input.sourceTypes
      };
    }

    // Empty_Extraction (R1.6): non-empty contextLabel, '' extractedText,
    // null hash. The rule kind stays 'terminal' so observability can
    // distinguish "terminal with empty buffer" from "generic fallback".
    return {
      frameId: input.frameId,
      frameTimestamp: input.frameTimestamp,
      appName: input.appName,
      contextLabel,
      contextKey,
      extractedText: '',
      extractedTextHash: null,
      extractionRuleKind: 'terminal',
      sourceTypes: input.sourceTypes
    };
  }

  /**
   * Returns the first AXTextArea subtree's flattened text, or `null` to
   * signal "fall back to Empty_Extraction". Every failure mode (null
   * input, JSON parse error, schema mismatch, no AXTextArea, blank
   * text) collapses to `null` so the caller has a single branch to
   * handle.
   */
  private tryExtract(input: ExtractionInput): string | null {
    if (input.accessibilityTreeJson === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(input.accessibilityTreeJson);
    } catch {
      return null;
    }

    if (!isAccessibilityNode(parsed)) return null;

    const textArea = findFirstNodeByRole(parsed, 'AXTextArea');
    if (textArea === null) return null;

    const text = flattenSubtreeText(textArea);
    if (text === '') return null;

    return text;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * DFS for the first node whose role exactly equals `role`. Returns
 * `null` when nothing matches. Children are visited left-to-right.
 */
function findFirstNodeByRole(
  root: AccessibilityNode,
  role: string
): AccessibilityNode | null {
  const stack: AccessibilityNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.role === role) return node;
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
  return null;
}

function isAccessibilityNode(value: unknown): value is AccessibilityNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childrenOf(node: AccessibilityNode): AccessibilityNode[] {
  if (!Array.isArray(node.children)) return [];
  const result: AccessibilityNode[] = [];
  for (const c of node.children) {
    if (isAccessibilityNode(c)) result.push(c);
  }
  return result;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
