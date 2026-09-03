/**
 * Universal Structured AXTree Extractor & Line-Level Delta Deduplicator.
 *
 * Implements the Universal Structured Extraction specification
 * (`docs/specs/universal-axtree-structured-extraction.md`, USE-R01~USE-R06).
 *
 * Replaces the fragile narrow-anchor and aggressive blacklist approach with
 * a 4-domain semantic taxonomy:
 *   1. [Window] - Base window metadata, window title, document identifier.
 *   2. [Nav]    - Navigation headers, chat partner names, channels, breadcrumbs, tabs.
 *   3. [Action] - Active menus, menu items, action popups, modal confirmation sheets/dialogs.
 *   4. [Body]   - Primary body text, chat streams, code editor buffer, user input.
 *
 * Includes session-scoped line-level deduplication (CCS-R02 / USE-R05) via
 * `LineDeltaDeduplicator` and contextLabel dynamic navigation enrichment (USE-R04).
 */

import { createHash } from 'node:crypto';

import { buildContextKey, deriveContextLabel } from '../sessions/context-key.js';
import type {
  ExtractionInput,
  ExtractionResult,
  ExtractionRule
} from './types.js';

// ---------------------------------------------------------------------------
// Accessibility Node Interface
// ---------------------------------------------------------------------------

export interface AccessibilityBounds {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface AccessibilityNode {
  role?: string;
  title?: string;
  description?: string;
  value?: string;
  text?: string;
  focused?: boolean;
  onScreen?: boolean;
  on_screen?: boolean;
  bounds?: AccessibilityBounds;
  children?: AccessibilityNode[];
}

// ---------------------------------------------------------------------------
// Universal Semantic Role Taxonomy
// ---------------------------------------------------------------------------

/**
 * Roles classified into the Window / Application metadata domain (USE-R01).
 */
export const WINDOW_ROLES: ReadonlySet<string> = new Set([
  'AXWindow',
  'AXMainWindow',
  'AXDocument',
  'AXApplication',
  'AXStandardWindow'
]);

/**
 * Roles classified into the Navigation / Contextual Metadata domain.
 */
export const NAV_ROLES: ReadonlySet<string> = new Set([
  'AXToolbar',
  'AXTabGroup',
  'AXTab',
  'AXRadioButton',
  'AXHeading',
  'AXBanner',
  'AXNavigationBar',
  'AXTitleBar'
]);

/**
 * Roles classified into the Action / Popover / Modal Dialog domain.
 */
export const ACTION_ROLES: ReadonlySet<string> = new Set([
  'AXMenu',
  'AXMenuItem',
  'AXMenuBar',
  'AXMenuBarItem',
  'AXPopUpButton',
  'AXSheet',
  'AXDialog',
  'AXAlert'
]);

/**
 * Roles classified into the Content Body / Input domain.
 */
export const BODY_ROLES: ReadonlySet<string> = new Set([
  'AXTextArea',
  'AXWebArea',
  'AXScrollArea',
  'AXTextField',
  'AXTable',
  'AXList',
  'AXOutline'
]);

// ---------------------------------------------------------------------------
// Structured Extraction Output Structure
// ---------------------------------------------------------------------------

export interface UniversalStructuredElements {
  windowLines: string[];
  navLines: string[];
  navigationCandidates: NavigationContextCandidate[];
  actionLines: string[];
  bodyLines: string[];
}

/**
 * Navigation text together with the AX role that supplied it. Stronger
 * semantic roles are preferred when enriching coarse window titles.
 */
export interface NavigationContextCandidate {
  line: string;
  role: string;
}

// ---------------------------------------------------------------------------
// Universal Structured Extractor Core Algorithm
// ---------------------------------------------------------------------------

/**
 * Extracts structured elements from a full accessibility tree into the 4 semantic domains.
 */
export function extractUniversalStructuredElements(
  root: AccessibilityNode,
  windowTitle?: string
): UniversalStructuredElements {
  const elements: UniversalStructuredElements = {
    windowLines: [],
    navLines: [],
    navigationCandidates: [],
    actionLines: [],
    bodyLines: []
  };

  if (!isNodeVisible(root)) {
    return elements;
  }

  const effectiveRootTitle = (root.title || windowTitle || '').trim();
  if (effectiveRootTitle !== '' && root.role !== 'AXApplication') {
    elements.windowLines.push(`[Window] ${effectiveRootTitle}`);
  }

  // DFS traversal tracking current semantic domain and relative depth from root
  function walk(
    node: AccessibilityNode,
    parentDomain: 'nav' | 'action' | 'body' | null,
    depth: number,
    nearestWindowDepth: number | null
  ): void {
    // Visibility guard: drop nodes explicitly marked off-screen (both camelCase and snake_case)
    if (!isNodeVisible(node)) return;

    let currentDomain = parentDomain;
    const role = node.role;
    const currentWindowDepth =
      role !== undefined && WINDOW_ROLES.has(role) && role !== 'AXApplication'
        ? depth
        : nearestWindowDepth;
    const relativeDepth = currentWindowDepth === null
      ? depth
      : depth - currentWindowDepth;

    if (role !== undefined) {
      if (WINDOW_ROLES.has(role)) {
        if (role !== 'AXApplication' && node.title && node.title.trim() !== '') {
          const winLine = `[Window] ${node.title.trim()}`;
          if (!elements.windowLines.includes(winLine)) {
            elements.windowLines.push(winLine);
          }
        }
      } else if (ACTION_ROLES.has(role)) {
        currentDomain = 'action';
      } else if (NAV_ROLES.has(role)) {
        currentDomain = 'nav';
      } else if (BODY_ROLES.has(role) && currentDomain === null) {
        currentDomain = 'body';
      }
    }

    const text = pickNodeText(node);
    if (text !== '') {
      const isWindowNode = role !== undefined && (WINDOW_ROLES.has(role) || role === 'AXApplication');

      if (!isWindowNode || (text !== effectiveRootTitle && text !== node.title)) {
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
        for (const line of lines) {
          if (currentDomain === 'action') {
            elements.actionLines.push(`[Action] ${line}`);
          } else if (currentDomain === 'nav') {
            elements.navLines.push(`[Nav] ${line}`);
            if (isNavigationCandidate(line, role)) {
              elements.navigationCandidates.push({ line, role: role ?? 'AXStaticText' });
            }
          } else if (currentDomain === 'body') {
            elements.bodyLines.push(`[Body] ${line}`);
          } else {
            // Only top-level AXStaticText (depth <= 1) and AXHeading default
            // to [Nav]. Static text and layout-container values remain a
            // [Body] fallback for GPUI-style trees; unknown controls are
            // omitted so system chrome does not become body content.
            if (role === 'AXHeading' || (role === 'AXStaticText' && relativeDepth <= 1)) {
              elements.navLines.push(`[Nav] ${line}`);
              elements.navigationCandidates.push({ line, role: role ?? 'AXStaticText' });
            } else if (
              role === 'AXStaticText' ||
              role === undefined ||
              role === 'AXApplication' ||
              role === 'AXWindow' ||
              role === 'AXGroup' ||
              role === 'AXSplitGroup'
            ) {
              elements.bodyLines.push(`[Body] ${line}`);
            }
          }
        }
      }
    }

    for (const child of childrenOf(node)) {
      walk(child, currentDomain, depth + 1, currentWindowDepth);
    }
  }

  walk(root, null, 0, null);

  // Fallback for single-node / shallow trees (e.g. Zed / GPUI fallback)
  if (
    childrenOf(root).length === 0 &&
    elements.windowLines.length === 0 &&
    elements.navLines.length === 0 &&
    elements.actionLines.length === 0 &&
    elements.bodyLines.length === 0
  ) {
    const text = pickNodeText(root);
    if (text !== '' && text !== effectiveRootTitle) {
      elements.bodyLines.push(`[Body] ${text}`);
    } else if (effectiveRootTitle !== '') {
      elements.windowLines.push(`[Window] ${effectiveRootTitle}`);
    }
  }

  return elements;
}

/**
 * Extracts and formats full-window accessibility tree into a tagged multi-line string.
 */
export function extractUniversalStructuredText(
  root: AccessibilityNode,
  windowTitle?: string
): string {
  const elements = extractUniversalStructuredElements(root, windowTitle);
  const allLines = [
    ...elements.windowLines,
    ...elements.navLines,
    ...elements.actionLines,
    ...elements.bodyLines
  ];
  return allLines.join('\n').trim();
}

/**
 * Universal Structured Extractor Rule implementation of `ExtractionRule`.
 *
 * Stateless and deterministic (W1 property).
 */
export class UniversalStructuredExtractor implements ExtractionRule {
  readonly kind = 'generic' as const;

  matches(_input: ExtractionInput): boolean {
    return true;
  }

  extract(input: ExtractionInput): ExtractionResult {
    if (input.accessibilityTreeJson === null) {
      return this.emptyResult(input);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(input.accessibilityTreeJson);
    } catch {
      return this.emptyResult(input);
    }

    const root = normalizeAccessibilityTree(parsed);
    if (root === null) {
      return this.emptyResult(input);
    }

    const elements = extractUniversalStructuredElements(root, input.windowTitle);

    const enrichedWindowTitle = deriveEnrichedWindowTitle(
      input.windowTitle,
      input.appName,
      elements.navLines,
      elements.windowLines,
      elements.navigationCandidates
    );

    const contextLabel = deriveContextLabel(enrichedWindowTitle, input.appName);
    const contextKey = buildContextKey(input.appName, enrichedWindowTitle);

    const allLines = [
      ...elements.windowLines,
      ...elements.navLines,
      ...elements.actionLines,
      ...elements.bodyLines
    ];
    const extractedText = allLines.join('\n').trim();

    if (extractedText === '') {
      return this.emptyResult(input, contextLabel, contextKey);
    }

    return {
      frameId: input.frameId,
      frameTimestamp: input.frameTimestamp,
      ...(input.captureCursor !== undefined ? { captureCursor: input.captureCursor } : {}),
      appName: input.appName,
      contextLabel,
      contextKey,
      extractedText,
      extractedTextHash: sha256Hex(extractedText),
      extractionRuleKind: 'generic',
      sourceTypes: input.sourceTypes
    };
  }

  private emptyResult(
    input: ExtractionInput,
    overrideLabel?: string,
    overrideKey?: string
  ): ExtractionResult {
    const contextLabel = overrideLabel ?? deriveContextLabel(input.windowTitle, input.appName);
    const contextKey = overrideKey ?? buildContextKey(input.appName, input.windowTitle);
    return {
      frameId: input.frameId,
      frameTimestamp: input.frameTimestamp,
      ...(input.captureCursor !== undefined ? { captureCursor: input.captureCursor } : {}),
      appName: input.appName,
      contextLabel,
      contextKey,
      extractedText: '',
      extractedTextHash: null,
      extractionRuleKind: 'generic',
      sourceTypes: input.sourceTypes
    };
  }
}

// ---------------------------------------------------------------------------
// Line-Level Delta Deduplicator (USE-R05 / CCS-R02)
// ---------------------------------------------------------------------------

interface ActiveContextState {
  lastTimestampMs: number;
  seenLineHashes: Set<string>;
}

type ActiveContextMap = Map<string, ActiveContextState>;

/** A handle returned by a line-deduplication transaction. */
export type LineDeltaDeduplicationToken = symbol;

export interface LineDeltaTransactionResult {
  extraction: ExtractionResult;
  token: LineDeltaDeduplicationToken;
}

export interface LineDeltaDeduplicatorOptions {
  idleThresholdMs?: number;
}

/**
 * Buffers line-deduplication state until the caller confirms that the
 * corresponding records reached the durable indexing boundary.
 */
export class LineDeltaDeduplicationTransaction {
  private readonly initialContexts: ActiveContextMap;
  private readonly workingContexts: ActiveContextMap;
  private readonly operations: Array<{
    token: LineDeltaDeduplicationToken;
    rawResult: ExtractionResult;
  }> = [];
  private closed = false;

  constructor(private readonly owner: LineDeltaDeduplicator) {
    this.initialContexts = cloneActiveContexts(owner.snapshotActiveContexts());
    this.workingContexts = cloneActiveContexts(this.initialContexts);
  }

  process(result: ExtractionResult): LineDeltaTransactionResult {
    this.ensureOpen();
    const token = Symbol('line-delta');
    this.operations.push({ token, rawResult: result });
    return {
      extraction: applyLineDelta(result, this.workingContexts, this.owner.idleThreshold()),
      token
    };
  }

  /**
   * Commits only accepted operations. An unaccepted operation blocks later
   * operations for the same context because their preview may have relied on
   * state that was never durably indexed.
   */
  commit(acceptedTokens?: ReadonlySet<LineDeltaDeduplicationToken>): void {
    this.ensureOpen();
    const accepted = acceptedTokens
      ?? new Set(this.operations.map((operation) => operation.token));
    const committedContexts = cloneActiveContexts(this.initialContexts);
    const blockedContexts = new Set<string>();

    // Rebuild from the transaction's initial state so rejected previews never
    // leak into the durable in-memory state.
    for (const operation of this.operations) {
      const key = operation.rawResult.contextKey;
      if (!accepted.has(operation.token)) {
        if (operation.rawResult.extractedText !== '') {
          blockedContexts.add(key);
        }
        continue;
      }
      if (blockedContexts.has(key)) {
        continue;
      }
      applyLineDelta(
        operation.rawResult,
        committedContexts,
        this.owner.idleThreshold()
      );
    }

    this.owner.replaceActiveContexts(committedContexts);
    this.closed = true;
  }

  rollback(): void {
    this.ensureOpen();
    this.closed = true;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('LineDeltaDeduplicationTransaction is already closed.');
    }
  }
}

/**
 * Session-scoped line-level delta deduplicator (USE-R05 / CCS-R02).
 *
 * Maintains a set of seen line hashes per active session context, emitting only newly
 * appeared or changed lines. Outputs 0 bytes (`extractedText: ''`) when all
 * lines in the frame were already seen in the current session.
 *
 * Automatically tracks inter-frame gaps per contextKey: when the time gap
 * exceeds `idleThresholdMs` (default 300,000ms = 5 minutes), the deduplication
 * state for that contextKey resets to guarantee the new session begins with full context.
 * Also supports multi-context interleaving (e.g. A -> B -> A) without losing A's state.
 */
export class LineDeltaDeduplicator {
  private readonly activeContexts: ActiveContextMap = new Map();
  private readonly idleThresholdMs: number;

  constructor(options?: LineDeltaDeduplicatorOptions) {
    this.idleThresholdMs = options?.idleThresholdMs ?? 300_000;
  }

  reset(contextKey?: string): void {
    if (contextKey !== undefined) {
      this.activeContexts.delete(contextKey);
    } else {
      this.activeContexts.clear();
    }
  }

  beginTransaction(): LineDeltaDeduplicationTransaction {
    return new LineDeltaDeduplicationTransaction(this);
  }

  /**
   * Restores hashes from durable rows belonging to active sessions after a
   * process restart. Rows are replayed in timestamp order; empty delta rows
   * contribute no hashes but still refresh the active context timestamp.
   */
  hydrate(results: readonly ExtractionResult[]): void {
    const sorted = [...results]
      .sort((a, b) => {
        const timestampOrder = parseFrameTimestamp(a.frameTimestamp) - parseFrameTimestamp(b.frameTimestamp);
        if (timestampOrder !== 0) return timestampOrder;

        if (a.captureCursor !== undefined && b.captureCursor !== undefined) {
          if (a.captureCursor < b.captureCursor) return -1;
          if (a.captureCursor > b.captureCursor) return 1;
        }

        return a.frameId - b.frameId;
      });

    for (const result of sorted) {
      applyLineDelta(result, this.activeContexts, this.idleThresholdMs);
    }
  }

  process(result: ExtractionResult): ExtractionResult {
    const transaction = this.beginTransaction();
    const processed = transaction.process(result);
    transaction.commit();
    return processed.extraction;
  }

  /** @internal Used by LineDeltaDeduplicationTransaction. */
  snapshotActiveContexts(): ActiveContextMap {
    return this.activeContexts;
  }

  /** @internal Used by LineDeltaDeduplicationTransaction. */
  replaceActiveContexts(next: ActiveContextMap): void {
    this.activeContexts.clear();
    for (const [key, state] of next) {
      this.activeContexts.set(key, {
        lastTimestampMs: state.lastTimestampMs,
        seenLineHashes: new Set(state.seenLineHashes)
      });
    }
  }

  /** @internal Used by LineDeltaDeduplicationTransaction. */
  idleThreshold(): number {
    return this.idleThresholdMs;
  }
}

function cloneActiveContexts(source: ActiveContextMap): ActiveContextMap {
  const clone: ActiveContextMap = new Map();
  for (const [key, state] of source) {
    clone.set(key, {
      lastTimestampMs: state.lastTimestampMs,
      seenLineHashes: new Set(state.seenLineHashes)
    });
  }
  return clone;
}

function applyLineDelta(
  result: ExtractionResult,
  contexts: ActiveContextMap,
  idleThresholdMs: number
): ExtractionResult {
  const timestampMs = parseFrameTimestamp(result.frameTimestamp);
  pruneExpiredContexts(contexts, timestampMs, idleThresholdMs);

  const key = result.contextKey;
  let state = contexts.get(key);
  if (
    !state ||
    timestampMs < state.lastTimestampMs ||
    timestampMs - state.lastTimestampMs > idleThresholdMs
  ) {
    state = {
      lastTimestampMs: timestampMs,
      seenLineHashes: new Set()
    };
    contexts.set(key, state);
  } else {
    state.lastTimestampMs = Math.max(state.lastTimestampMs, timestampMs);
  }

  if (result.extractedText === '') {
    return result;
  }

  const lines = result.extractedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const seenBeforeFrame = new Set(state.seenLineHashes);
  const newDeltaLines: string[] = [];

  for (const line of lines) {
    const lineHash = sha256Hex(line);
    if (!seenBeforeFrame.has(lineHash)) {
      newDeltaLines.push(line);
    }
    state.seenLineHashes.add(lineHash);
  }

  const deltaText = newDeltaLines.join('\n').trim();
  return {
    ...result,
    extractedText: deltaText,
    extractedTextHash: deltaText === '' ? null : sha256Hex(deltaText)
  };
}

function parseFrameTimestamp(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function pruneExpiredContexts(
  contexts: ActiveContextMap,
  timestampMs: number,
  idleThresholdMs: number
): void {
  for (const [key, state] of contexts) {
    if (timestampMs - state.lastTimestampMs > idleThresholdMs) {
      contexts.delete(key);
    }
  }
}

function isNodeVisible(node: AccessibilityNode): boolean {
  if (node.onScreen === false || node.on_screen === false) return false;
  if (node.bounds?.width !== undefined && node.bounds.width <= 0) return false;
  if (node.bounds?.height !== undefined && node.bounds.height <= 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Enriches a coarse window title with [Nav] context (USE-R04).
 */
export function deriveEnrichedWindowTitle(
  rawWindowTitle: string | undefined,
  appName: string | undefined,
  navLines: string[],
  windowLines: string[],
  navigationCandidates: NavigationContextCandidate[] = []
): string | undefined {
  const normRaw = (rawWindowTitle || '').trim().toLowerCase();
  const normApp = (appName || '').trim().toLowerCase();

  const isCoarse =
    normRaw === '' ||
    normRaw === 'untitled' ||
    normRaw === normApp ||
    normRaw === 'wechat' ||
    normRaw === 'slack' ||
    normRaw === 'discord';

  if (!isCoarse) {
    return rawWindowTitle;
  }

  // 1. Prefer semantically strong AX roles, preserving tree order for ties.
  const candidates = [
    ...navigationCandidates,
    ...navLines.map((line) => ({
      line: line.replace(/^\[Nav\]\s*/, '').trim(),
      role: 'AXStaticText'
    }))
  ];
  const seen = new Set<string>();
  let best: { line: string; score: number } | undefined;
  for (const candidate of candidates) {
    const cleanCandidate = candidate.line.replace(/^\[Nav\]\s*/, '').trim();
    if (
      cleanCandidate === '' ||
      cleanCandidate.length > 80 ||
      seen.has(cleanCandidate) ||
      isNavigationNoise(cleanCandidate)
    ) {
      continue;
    }
    seen.add(cleanCandidate);
    const score = navigationRolePriority(candidate.role);
    if (best === undefined || score > best.score) {
      best = { line: cleanCandidate, score };
    }
  }

  if (best !== undefined) {
    const basePrefix = (appName || '').trim() || (rawWindowTitle || '').trim() || 'App';
    return `${basePrefix} - ${best.line}`;
  }

  // 2. Fall back to a nested [Window] line from a child window when no
  // navigation context is available.
  for (const winLine of windowLines) {
    const cleanWin = winLine.replace(/^\[Window\]\s*/, '').trim();
    if (
      cleanWin !== '' &&
      cleanWin.toLowerCase() !== normApp &&
      cleanWin.toLowerCase() !== 'untitled' &&
      !isNavigationNoise(cleanWin)
    ) {
      return cleanWin;
    }
  }

  return rawWindowTitle;
}

const NAVIGATION_NOISE = new Set([
  'back',
  'forward',
  'search',
  'close',
  'cancel',
  'done',
  'more',
  'menu',
  'settings',
  'home',
  'refresh',
  'reload',
  'share',
  'add',
  'new',
  'open',
  'save'
]);

function isNavigationNoise(line: string): boolean {
  const normalized = line.trim().toLocaleLowerCase('en-US');
  if (NAVIGATION_NOISE.has(normalized)) return true;
  return /^(back|forward|search|close|cancel|done|more|menu|settings|home|refresh|reload|share|add|new|open|save)(?:\s|$)/.test(normalized);
}

function isNavigationCandidate(line: string, role: string | undefined): boolean {
  return role !== undefined && (NAV_ROLES.has(role) || role === 'AXStaticText') && !isNavigationNoise(line);
}

function navigationRolePriority(role: string): number {
  switch (role) {
    case 'AXHeading':
      return 100;
    case 'AXNavigationBar':
      return 95;
    case 'AXBanner':
      return 90;
    case 'AXRadioButton':
    case 'AXTab':
      return 85;
    case 'AXTabGroup':
      return 75;
    case 'AXToolbar':
      return 65;
    case 'AXTitleBar':
      return 60;
    default:
      return 50;
  }
}

/**
 * Picks the first text-bearing field of an AX node, in priority order:
 * `value` -> `text` -> `title` -> `description`.
 */
export function pickNodeText(node: AccessibilityNode): string {
  const candidates: ReadonlyArray<unknown> = [
    node.value,
    node.text,
    node.title,
    node.description
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim();
    }
  }
  return '';
}

export function isAccessibilityNode(value: unknown): value is AccessibilityNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes both nested AX objects and Screenpipe's pre-sweep flat array
 * representation into the nested tree consumed by the extractor.
 */
export function normalizeAccessibilityTree(value: unknown): AccessibilityNode | null {
  if (isAccessibilityNode(value)) {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const roots: AccessibilityNode[] = [];
  const stack: Array<{ depth: number; node: AccessibilityNode }> = [];

  for (const item of value) {
    if (!isAccessibilityNode(item)) continue;

    const raw = item as unknown as Record<string, unknown>;
    const depth = normalizeFlatDepth(raw.depth);
    const node = normalizeFlatNode(raw);

    while (stack.length > depth) {
      stack.pop();
    }

    const parent = depth > 0 ? stack[depth - 1]?.node : undefined;
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children ??= [];
      parent.children.push(node);
    }

    stack[depth] = { depth, node };
    stack.length = depth + 1;
  }

  if (roots.length === 0) return null;
  if (roots.length === 1) return roots[0];
  return { role: 'AXApplication', children: roots };
}

function normalizeFlatDepth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function normalizeFlatNode(raw: Record<string, unknown>): AccessibilityNode {
  const role = typeof raw.role === 'string' ? raw.role : undefined;
  const node: AccessibilityNode = {
    ...(role !== undefined ? { role } : {})
  };

  for (const key of ['title', 'description', 'value', 'text'] as const) {
    if (typeof raw[key] === 'string') {
      node[key] = raw[key] as string;
    }
  }

  if (typeof raw.focused === 'boolean') node.focused = raw.focused;
  if (typeof raw.onScreen === 'boolean') node.onScreen = raw.onScreen;
  if (typeof raw.on_screen === 'boolean') node.on_screen = raw.on_screen;

  const rawBounds = raw.bounds;
  if (rawBounds !== null && typeof rawBounds === 'object' && !Array.isArray(rawBounds)) {
    const bounds = rawBounds as Record<string, unknown>;
    const x = firstFiniteNumber(bounds.x, bounds.left);
    const y = firstFiniteNumber(bounds.y, bounds.top);
    const width = firstFiniteNumber(bounds.width);
    const height = firstFiniteNumber(bounds.height);
    if (x !== undefined || y !== undefined || width !== undefined || height !== undefined) {
      node.bounds = {
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {})
      };
    }
  }

  // The maintenance converter stores flat window labels in `text` and
  // preserves an explicit `title` inside the properties payload. Treat the
  // former as a title when no explicit title is available.
  if (
    role !== undefined &&
    WINDOW_ROLES.has(role) &&
    node.title === undefined &&
    node.text !== undefined
  ) {
    node.title = node.text;
    delete node.text;
  }

  return node;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function childrenOf(node: AccessibilityNode): AccessibilityNode[] {
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
