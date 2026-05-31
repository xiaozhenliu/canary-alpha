/**
 * Generic_Heuristic — the tail-of-chain extraction rule.
 *
 * The rule consumes a raw `accessibility_tree_json` (the macOS AX subtree
 * captured by ScreenPipe) and tries to identify the substantive body text
 * the user is actually reading or editing. The strategy follows the design
 * document, §2 "Components and Interfaces — Extraction_Registry":
 *
 *   1. **Locate the focus anchor.** Walk the AX tree in DFS order looking
 *      for a focused descendant (`focused: true` or
 *      `role === 'AXFocusedUIElement'`). If one is found, walk back up its
 *      ancestor chain to the nearest node whose role is in
 *      `FOCUS_FALLBACK_ROLES` (`AXTextArea` / `AXWebArea` / `AXScrollArea`
 *      / `AXTextField`). That node — or the focused node itself if it
 *      already has one of those roles — is the **anchor**.
 *
 *   2. **Fall back across windows.** When no focused node yields an
 *      anchor, search for a `AXMainWindow` first; if missing, an
 *      `AXWindow`; if missing, the entire tree. Within whichever scope is
 *      found, take the first node whose role matches
 *      `FOCUS_FALLBACK_ROLES`.
 *
 *   3. **Flatten the anchor's subtree.** DFS the anchor, skipping subtrees
 *      whose root role is in `UI_CHROME_ROLE_BLACKLIST` (`AXMenuBar`,
 *      `AXToolbar`, `AXScrollBar`, etc.). `AXButton` is the only blacklist
 *      member with a special case: keep it when it carries a visible
 *      label (`value` / `text` / `title`), drop it when it does not
 *      (decorative-only buttons). Concatenate the first non-empty
 *      text-bearing field of every kept node — `value` first, then
 *      `text`, `description`, `title` for ordinary nodes, or `value`,
 *      `text`, `title` for `AXButton` (description excluded so a
 *      synthesised "Submit current message" cannot leak past a "Send"
 *      label) — joined by newlines.
 *
 *   4. **Fall back to Empty_Extraction.** If any step above fails (null
 *      AX JSON, malformed JSON, no anchor found, anchor subtree contains
 *      no usable text), return an `Empty_Extraction`: `extractedText: ''`,
 *      `extractedTextHash: null`. The `contextLabel` still resolves via
 *      {@link deriveContextLabel} so it is non-empty (R1.6).
 *
 * The rule is **deterministic** (R1 Determinism) — it never reads the
 * clock or any global state — and always produces a result (R1 Coverage).
 * Errors during JSON parsing or schema mismatch are caught and downgraded
 * to `Empty_Extraction` so a malformed AX payload cannot break the
 * indexing loop (design §"Error Handling — 1. 抽取层").
 */

import { createHash } from 'node:crypto';

import { buildContextKey, deriveContextLabel } from '../sessions/context-key.js';
import type {
  ExtractionInput,
  ExtractionResult,
  ExtractionRule
} from './types.js';

// ---------------------------------------------------------------------------
// AX tree shape
// ---------------------------------------------------------------------------

/**
 * The minimal accessibility-tree node shape the rule consumes.
 *
 * macOS AX serialisations vary across capture sources, so the shape is
 * deliberately permissive: every property is optional, `children` is an
 * array of recursively shaped nodes, and the rule reads text from any of
 * `value` / `text` / `description` / `title` (in that order — see
 * {@link pickNodeText}; `AXButton` nodes drop `description`). Unknown
 * fields are ignored — this keeps the rule resilient to small upstream
 * schema changes without requiring derived data to be rebuilt.
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
// Constants
// ---------------------------------------------------------------------------

/**
 * Roles whose subtree is unconditionally skipped when flattening anchor
 * text. These are window chrome / decoration / control bars that never
 * carry user-meaningful body content — including their text would dilute
 * downstream keyword and semantic search.
 *
 * `AXButton` is a special case: many real buttons (e.g. "Apply", "Send")
 * carry text the user wants searchable, while purely decorative buttons
 * (no `value` / `text` / `title`) are noise. The flatten loop applies
 * the special case in {@link shouldSkipNode}, which delegates to
 * {@link pickNodeText} — and `pickNodeText` excludes `description` for
 * buttons so a synthesised screen-reader description (e.g. `Close
 * window`) cannot keep a decorative button alive.
 */
export const UI_CHROME_ROLE_BLACKLIST: ReadonlySet<string> = new Set([
  'AXMenuBar',
  'AXMenuBarItem',
  'AXMenu',
  'AXMenuItem',
  'AXToolbar',
  'AXSplitter',
  'AXScrollBar',
  'AXButton',
  'AXImage',
  'AXStatusBar',
  'AXSheet'
]);

/**
 * Roles that can serve as an extraction anchor. Order is significant for
 * the focused-element ancestor walk: when multiple FOCUS_FALLBACK_ROLES
 * appear in the ancestor chain, the **innermost** ancestor wins (the loop
 * walks the ancestor stack from leaf to root). The list itself is small
 * enough that membership lookup goes through {@link FOCUS_FALLBACK_ROLE_SET}.
 */
export const FOCUS_FALLBACK_ROLES: ReadonlyArray<string> = [
  'AXTextArea',
  'AXWebArea',
  'AXScrollArea',
  'AXTextField'
];

const FOCUS_FALLBACK_ROLE_SET: ReadonlySet<string> = new Set(FOCUS_FALLBACK_ROLES);

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

/**
 * The Generic_Heuristic extraction rule. `matches` is always `true` — the
 * registry chains refinement rules in front so this rule acts as the
 * guaranteed fallback (Coverage property, R1.5).
 */
export class GenericHeuristicRule implements ExtractionRule {
  readonly kind = 'generic' as const;

  matches(_input: ExtractionInput): boolean {
    return true;
  }

  extract(input: ExtractionInput): ExtractionResult {
    const contextLabel = deriveContextLabel(input.windowTitle, input.appName);
    const contextKey = buildContextKey(input.appName, input.windowTitle);

    const result = this.tryExtract(input);
    if (result !== null && result.trim() !== '') {
      const text = result;
      return {
        frameId: input.frameId,
        frameTimestamp: input.frameTimestamp,
        appName: input.appName,
        contextLabel,
        contextKey,
        extractedText: text,
        extractedTextHash: sha256Hex(text),
        extractionRuleKind: 'generic',
        sourceTypes: input.sourceTypes
      };
    }

    // Empty_Extraction (R1.6): non-empty contextLabel, '' extractedText,
    // null hash.
    return {
      frameId: input.frameId,
      frameTimestamp: input.frameTimestamp,
      appName: input.appName,
      contextLabel,
      contextKey,
      extractedText: '',
      extractedTextHash: null,
      extractionRuleKind: 'generic',
      sourceTypes: input.sourceTypes
    };
  }

  /**
   * Returns the flattened anchor text, or `null` to indicate the rule
   * should fall back to `Empty_Extraction`. All failure modes — null
   * input, JSON parse error, schema mismatch, no anchor, blank text —
   * collapse to `null` so the caller has a single branch to handle.
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

    const anchor = findExtractionAnchor(parsed);
    if (anchor === null) return null;

    const text = flattenSubtreeText(anchor);
    if (text === '') return null;

    return text;
  }
}

// ---------------------------------------------------------------------------
// Anchor discovery
// ---------------------------------------------------------------------------

/**
 * Picks the AX node whose subtree should be flattened into `extractedText`.
 *
 * Strategy ordering (design "焦点回退顺序"):
 *
 *   1. **Focused-element ancestor walk.** If the tree contains a focused
 *      descendant (`focused: true` or `role === 'AXFocusedUIElement'`),
 *      and that node — or any of its ancestors — has a role in
 *      `FOCUS_FALLBACK_ROLES`, return the innermost such match.
 *
 *   2. **Main window.** Search for an `AXMainWindow` node and look for the
 *      first node matching {@link FOCUS_FALLBACK_ROLES}, scanning roles
 *      in priority order (AXTextArea before AXWebArea before
 *      AXScrollArea before AXTextField).
 *
 *   3. **First window.** Same priority-ordered search inside the first
 *      `AXWindow` node.
 *
 *   4. **Whole tree.** As a last resort, run the priority-ordered search
 *      against the entire tree.
 *
 * Returns `null` when none of the strategies finds an anchor.
 */
export function findExtractionAnchor(
  root: AccessibilityNode
): AccessibilityNode | null {
  const focused = findFocused(root);
  if (focused !== null) {
    // Self-match wins over any ancestor (the focused leaf is the most
    // precise anchor when it is itself a body container).
    if (focused.node.role !== undefined && FOCUS_FALLBACK_ROLE_SET.has(focused.node.role)) {
      return focused.node;
    }
    // Walk ancestors leaf → root so the innermost match wins.
    for (let i = focused.ancestors.length - 1; i >= 0; i--) {
      const ancestor = focused.ancestors[i];
      if (ancestor.role !== undefined && FOCUS_FALLBACK_ROLE_SET.has(ancestor.role)) {
        return ancestor;
      }
    }
  }

  const main = findNodeByRole(root, 'AXMainWindow');
  if (main !== null) {
    const found = findFirstByRolePriority(main, FOCUS_FALLBACK_ROLES);
    if (found !== null) return found;
  }

  const firstWindow = findNodeByRole(root, 'AXWindow');
  if (firstWindow !== null) {
    const found = findFirstByRolePriority(firstWindow, FOCUS_FALLBACK_ROLES);
    if (found !== null) return found;
  }

  return findFirstByRolePriority(root, FOCUS_FALLBACK_ROLES);
}

/**
 * DFS the tree for a focused descendant, returning the node and its
 * ancestor chain (root-most ancestor first). Returns `null` when no
 * focused marker is found anywhere.
 */
function findFocused(
  root: AccessibilityNode
): { node: AccessibilityNode; ancestors: AccessibilityNode[] } | null {
  type Frame = { node: AccessibilityNode; ancestors: AccessibilityNode[] };
  const stack: Frame[] = [{ node: root, ancestors: [] }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (isFocused(frame.node)) {
      return { node: frame.node, ancestors: frame.ancestors };
    }
    const children = childrenOf(frame.node);
    if (children.length === 0) continue;
    const nextAncestors = [...frame.ancestors, frame.node];
    // Push in reverse so DFS visits children left-to-right.
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], ancestors: nextAncestors });
    }
  }
  return null;
}

function isFocused(node: AccessibilityNode): boolean {
  return node.focused === true || node.role === 'AXFocusedUIElement';
}

/**
 * Returns the first node — in `FOCUS_FALLBACK_ROLES` priority order —
 * whose role appears anywhere in `root`'s subtree.
 *
 * The outer loop walks roles in the order supplied by `roles`, so an
 * `AXTextArea` anywhere in the subtree wins against an `AXScrollArea`
 * sitting at a shallower depth. Within a single role, the first DFS hit
 * wins.
 *
 * Returns `null` when none of the roles matches.
 */
function findFirstByRolePriority(
  root: AccessibilityNode,
  roles: ReadonlyArray<string>
): AccessibilityNode | null {
  for (const role of roles) {
    const found = findNodeByRole(root, role);
    if (found !== null) return found;
  }
  return null;
}

/**
 * DFS for the first node whose role exactly equals `role`. Returns `null`
 * when nothing matches.
 */
function findNodeByRole(root: AccessibilityNode, role: string): AccessibilityNode | null {
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

// ---------------------------------------------------------------------------
// Subtree flattening
// ---------------------------------------------------------------------------

/**
 * Flattens an anchor's subtree into a single text string.
 *
 * Walks the subtree in DFS order, skipping any subtree whose root role is
 * in `UI_CHROME_ROLE_BLACKLIST` (with the `AXButton`-with-visible-text
 * exception) and concatenating the first non-empty text-bearing field of
 * every kept node. Joins with newlines and trims the result, returning
 * `''` when nothing remains.
 *
 * For `AXButton` nodes the field priority drops `description` (see
 * {@link pickNodeText}); for every other role it stays at
 * `value → text → description → title`.
 *
 * Exposed for unit testing — consumers should call the rule's `extract`
 * method instead of this helper directly.
 */
export function flattenSubtreeText(anchor: AccessibilityNode): string {
  const parts: string[] = [];
  const stack: AccessibilityNode[] = [anchor];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (shouldSkipNode(node)) continue;
    const text = pickNodeText(node);
    if (text !== '') parts.push(text);
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Returns `true` when the node (and its subtree) should be elided from
 * the flattened text.
 *
 * The blacklist applies as-is for every member except `AXButton`: a
 * button is only skipped when {@link pickNodeText} returns `''`, i.e.
 * none of `value` / `text` / `title` carries a visible label. (For
 * buttons `pickNodeText` deliberately drops `description` — many
 * decorative buttons expose `description: 'Close'` for screen readers
 * without rendering text on screen, and we do not want that synthesised
 * label leaking into body content.)
 */
function shouldSkipNode(node: AccessibilityNode): boolean {
  const role = node.role;
  if (role === undefined) return false;
  if (!UI_CHROME_ROLE_BLACKLIST.has(role)) return false;
  if (role === 'AXButton') {
    return pickNodeText(node) === '';
  }
  return true;
}

/**
 * Picks the first text-bearing field of an AX node, in priority order.
 *
 * Default priority (taken from common ScreenPipe AX serialisation
 * conventions):
 *
 *   1. `value` — content actually displayed (text fields, web area body).
 *   2. `text`  — alternative serialisation field used by some sources.
 *   3. `description` — accessibility description (typically synthesised
 *      for screen readers).
 *   4. `title` — visible label or window title.
 *
 * `AXButton` is a special case: the priority drops `description` so a
 * button kept by {@link shouldSkipNode} reports only the user-visible
 * label (`value` / `text` / `title`). Otherwise a button with both
 * `title: 'Send'` and `description: 'Submit current message'` would
 * leak the synthesised description into the body text.
 *
 * Returns `''` when none of the candidates is a non-empty string.
 */
function pickNodeText(node: AccessibilityNode): string {
  const candidates: ReadonlyArray<unknown> =
    node.role === 'AXButton'
      ? [node.value, node.text, node.title]
      : [node.value, node.text, node.description, node.title];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAccessibilityNode(value: unknown): value is AccessibilityNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns the children array of a node, filtering out non-object entries
 * defensively. The AX JSON shape allows `children` to be missing (leaf
 * node) or any other type if the upstream schema drifts; we treat both
 * cases as "no children".
 */
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
