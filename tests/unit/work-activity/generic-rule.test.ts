/**
 * Unit tests for `GenericHeuristicRule` (work-activity-analysis task 3.2).
 *
 * The Generic_Heuristic is the tail-of-chain extraction rule that turns
 * a raw `accessibility_tree_json` into an `ExtractionResult`. These tests
 * cover the four behaviour buckets the task asks for:
 *
 *   1. **Normal AX tree extraction** — given a focused text area inside a
 *      window, the rule returns the focused subtree's text and a non-empty
 *      `contextLabel` derived from the window title.
 *   2. **Null AX tree → Empty_Extraction** — when `accessibilityTreeJson`
 *      is `null` (or otherwise malformed), the rule returns an
 *      `Empty_Extraction` with `extractedText: ''`, `extractedTextHash:
 *      null`, and a non-empty `contextLabel` (R1.6 fallback chain:
 *      windowTitle → appName → 'unknown').
 *   3. **Chrome node filtering** — `UI_CHROME_ROLE_BLACKLIST` subtrees
 *      (menus, toolbars, scroll bars, decorative buttons, …) are dropped
 *      when flattening the anchor's subtree, while `AXButton` nodes that
 *      carry visible text are kept.
 *   4. **Focus fallback ordering** — the rule first looks for a focused
 *      descendant's nearest `FOCUS_FALLBACK_ROLES` ancestor; failing that
 *      it walks `AXMainWindow` → `AXWindow` → whole-tree, taking the
 *      first match in each scope.
 *
 * The test file uses small hand-built AX tree fixtures rather than
 * fast-check generators — these are exercising specific branches of the
 * rule, not universally quantified properties. PBT for the extraction
 * registry as a whole (Determinism / Coverage / Refinement_Override)
 * lives in task 3.3's `extraction-registry.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  FOCUS_FALLBACK_ROLES,
  GenericHeuristicRule,
  UI_CHROME_ROLE_BLACKLIST,
  flattenSubtreeText
} from '../../../src/services/work-activity/extraction/generic.js';
import type { ExtractionInput } from '../../../src/services/work-activity/extraction/types.js';

const rule = new GenericHeuristicRule();

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface NodeShape {
  role?: string;
  value?: string;
  text?: string;
  description?: string;
  title?: string;
  focused?: boolean;
  children?: NodeShape[];
}

function input(
  treeOrJson: NodeShape | string | null,
  overrides: Partial<ExtractionInput> = {}
): ExtractionInput {
  const accessibilityTreeJson =
    treeOrJson === null
      ? null
      : typeof treeOrJson === 'string'
        ? treeOrJson
        : JSON.stringify(treeOrJson);
  return {
    frameId: 1,
    frameTimestamp: '2026-05-25T10:00:00.000Z',
    appName: 'TestApp',
    windowTitle: 'TestWindow.txt',
    accessibilityTreeJson,
    sourceTypes: ['accessibility'],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// `matches` — always true (Coverage property; the registry chains this
// rule as the guaranteed fallback).
// ---------------------------------------------------------------------------

describe('GenericHeuristicRule.matches', () => {
  it('returns true regardless of input', () => {
    expect(rule.matches(input(null))).toBe(true);
    expect(rule.matches(input(null, { appName: undefined }))).toBe(true);
    expect(rule.matches(input({ role: 'AXApplication' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty_Extraction paths (R1.6)
// ---------------------------------------------------------------------------

describe('GenericHeuristicRule.extract — Empty_Extraction', () => {
  it('returns Empty_Extraction when AX tree is null', () => {
    const result = rule.extract(input(null));
    expect(result.extractedText).toBe('');
    expect(result.extractedTextHash).toBeNull();
    expect(result.extractionRuleKind).toBe('generic');
    // Falls back to windowTitle because it is non-empty.
    expect(result.contextLabel).toBe('TestWindow.txt');
  });

  it('falls back to appName when windowTitle is empty', () => {
    const result = rule.extract(input(null, { windowTitle: '' }));
    expect(result.contextLabel).toBe('TestApp');
    expect(result.extractedText).toBe('');
  });

  it('falls back to "unknown" when both windowTitle and appName are missing', () => {
    const result = rule.extract(
      input(null, { windowTitle: undefined, appName: undefined })
    );
    expect(result.contextLabel).toBe('unknown');
    expect(result.extractedText).toBe('');
    expect(result.extractedTextHash).toBeNull();
  });

  it('returns Empty_Extraction when JSON is malformed (does not throw)', () => {
    const result = rule.extract(input('{ this is not valid json'));
    expect(result.extractedText).toBe('');
    expect(result.extractedTextHash).toBeNull();
    expect(result.contextLabel).toBe('TestWindow.txt');
  });

  it('returns Empty_Extraction when AX tree is a JSON array (schema mismatch)', () => {
    const result = rule.extract(input('[]'));
    expect(result.extractedText).toBe('');
    expect(result.extractedTextHash).toBeNull();
  });

  it('returns Empty_Extraction when no anchor role is present anywhere', () => {
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        { role: 'AXGroup', children: [{ role: 'AXStaticText', value: 'orphan' }] }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('');
  });

  it('returns Empty_Extraction when anchor subtree contains no usable text', () => {
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXWindow',
          children: [
            // AXTextArea anchor, but its subtree is just a chrome-only AXScrollBar
            {
              role: 'AXTextArea',
              children: [{ role: 'AXScrollBar', value: 'should be skipped' }]
            }
          ]
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('');
    expect(result.extractedTextHash).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Happy path — focused anchor with text body
// ---------------------------------------------------------------------------

describe('GenericHeuristicRule.extract — focused anchor', () => {
  it('extracts text from the focused AXTextArea ancestor', () => {
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXWindow',
          title: 'window',
          children: [
            {
              role: 'AXTextArea',
              children: [
                {
                  role: 'AXStaticText',
                  focused: true,
                  value: 'hello world'
                }
              ]
            }
          ]
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('hello world');
    expect(result.extractedTextHash).not.toBeNull();
    expect(result.extractionRuleKind).toBe('generic');
    expect(result.contextLabel).toBe('TestWindow.txt');
  });

  it('returns the focused node itself when it already has a fallback role', () => {
    // Only the AXTextArea is focused; no descendant text. The anchor is the
    // AXTextArea, and its `value` is read directly.
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXTextArea',
          focused: true,
          value: 'directly on the anchor'
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('directly on the anchor');
  });

  it('picks the innermost FOCUS_FALLBACK_ROLES ancestor of a focused leaf', () => {
    // A nested AXTextArea inside a higher AXWebArea — the innermost wins
    // even though both are valid anchors.
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXWebArea',
          value: 'OUTER WEB AREA TEXT',
          children: [
            {
              role: 'AXTextArea',
              children: [
                {
                  role: 'AXStaticText',
                  focused: true,
                  value: 'inner editor body'
                }
              ]
            }
          ]
        }
      ]
    };
    const result = rule.extract(input(tree));
    // The flatten starts at the AXTextArea anchor — the AXWebArea text
    // above it is not included.
    expect(result.extractedText).toContain('inner editor body');
    expect(result.extractedText).not.toContain('OUTER WEB AREA TEXT');
  });

  it('treats role:"AXFocusedUIElement" as a focus marker', () => {
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXTextArea',
          children: [
            { role: 'AXFocusedUIElement', value: 'focused via role marker' }
          ]
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('focused via role marker');
  });
});

// ---------------------------------------------------------------------------
// Chrome filtering (R1 — UI_CHROME_ROLE_BLACKLIST)
// ---------------------------------------------------------------------------

describe('GenericHeuristicRule.extract — chrome filtering', () => {
  it('drops every UI_CHROME_ROLE_BLACKLIST role from the anchor subtree', () => {
    // Build an AXWebArea containing one keep-text node plus one node for
    // each chrome role except AXButton (which has a special exemption).
    const chromeChildren: NodeShape[] = [
      ...[...UI_CHROME_ROLE_BLACKLIST]
        .filter((role) => role !== 'AXButton')
        .map((role) => ({ role, value: `noise-from-${role}` })),
      { role: 'AXStaticText', value: 'kept content' }
    ];
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [{ role: 'AXWebArea', children: chromeChildren }]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('kept content');
    for (const role of UI_CHROME_ROLE_BLACKLIST) {
      if (role === 'AXButton') continue;
      expect(result.extractedText).not.toContain(`noise-from-${role}`);
    }
  });

  it('drops AXButton when it has no visible text (decorative button)', () => {
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXWebArea',
          children: [
            { role: 'AXButton' /* no value / text / title */ },
            { role: 'AXStaticText', value: 'kept content' }
          ]
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('kept content');
  });

  it('keeps AXButton when it carries visible text', () => {
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXWebArea',
          children: [
            { role: 'AXButton', title: 'Send' },
            { role: 'AXStaticText', value: 'message body' }
          ]
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toContain('Send');
    expect(result.extractedText).toContain('message body');
  });

  it('drops AXButton that only carries an accessibility description (decorative)', () => {
    // Real macOS apps frequently expose icon-only buttons via a
    // `description` field for screen readers (e.g. close / minimise /
    // zoom). These must NOT be counted as visible text or they leak into
    // body content.
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXWebArea',
          children: [
            { role: 'AXButton', description: 'Close window' },
            { role: 'AXStaticText', value: 'kept content' }
          ]
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('kept content');
    expect(result.extractedText).not.toContain('Close window');
  });

  it('AXButton with both title and description extracts the title only', () => {
    // Even when the button is kept (visible label present), the
    // synthesised `description` must not leak into the body text. This
    // is the more subtle leak path — the button passes the kept check
    // because it has a `title`, but `pickNodeText`'s default priority
    // would otherwise return the description first.
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXWebArea',
          children: [
            { role: 'AXButton', title: 'Send', description: 'Submit current message' },
            { role: 'AXStaticText', value: 'message body' }
          ]
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toContain('Send');
    expect(result.extractedText).toContain('message body');
    expect(result.extractedText).not.toContain('Submit current message');
  });

  it('drops the entire subtree of a blacklisted node, not just the node itself', () => {
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXWebArea',
          children: [
            // Toolbar with a child that pretends to be normal body text —
            // skipping the toolbar must skip this descendant too.
            {
              role: 'AXToolbar',
              children: [{ role: 'AXStaticText', value: 'menu-text-noise' }]
            },
            { role: 'AXStaticText', value: 'real body' }
          ]
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('real body');
    expect(result.extractedText).not.toContain('menu-text-noise');
  });
});

// ---------------------------------------------------------------------------
// Focus fallback ordering (focused → mainWindow → firstWindow → whole tree)
// ---------------------------------------------------------------------------

describe('GenericHeuristicRule.extract — focus fallback ordering', () => {
  it('uses the focused-element ancestor when present, even with mainWindow available', () => {
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXMainWindow',
          children: [
            { role: 'AXTextArea', value: 'mainWindow body — should NOT win' }
          ]
        },
        {
          role: 'AXWindow',
          children: [
            {
              role: 'AXWebArea',
              children: [
                {
                  role: 'AXStaticText',
                  focused: true,
                  value: 'focused body'
                }
              ]
            }
          ]
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('focused body');
  });

  it('falls back to AXMainWindow when no focused descendant has a usable ancestor', () => {
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXMainWindow',
          children: [
            { role: 'AXTextArea', value: 'mainWindow body — picked' }
          ]
        },
        {
          role: 'AXWindow',
          children: [{ role: 'AXTextArea', value: 'other window body' }]
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('mainWindow body — picked');
  });

  it('falls back to AXWindow when AXMainWindow is missing', () => {
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXWindow',
          children: [
            { role: 'AXScrollArea', value: 'firstWindow body — picked' }
          ]
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('firstWindow body — picked');
  });

  it('falls back to whole-tree DFS when neither AXMainWindow nor AXWindow is present', () => {
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXGroup',
          children: [{ role: 'AXTextField', value: 'whole-tree body' }]
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('whole-tree body');
  });

  it('FOCUS_FALLBACK_ROLES priority order picks AXTextArea over AXTextField at the same depth', () => {
    // Both AXTextField and AXTextArea live in the same window. Per
    // FOCUS_FALLBACK_ROLES order (AXTextArea before AXTextField), the
    // AXTextArea wins even though it appears later in the children
    // array — priority is by role rank, not DFS arrival.
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXWindow',
          children: [
            { role: 'AXTextField', value: 'text field — not picked' },
            { role: 'AXTextArea', value: 'text area body — picked' }
          ]
        }
      ]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('text area body — picked');
    // Sanity: AXTextArea ranks before AXTextField in FOCUS_FALLBACK_ROLES.
    expect(FOCUS_FALLBACK_ROLES.indexOf('AXTextArea'))
      .toBeLessThan(FOCUS_FALLBACK_ROLES.indexOf('AXTextField'));
  });
});

// ---------------------------------------------------------------------------
// Output shape — required fields and hashing
// ---------------------------------------------------------------------------

describe('GenericHeuristicRule.extract — output shape', () => {
  it('hashes extractedText with SHA256 hex (64 chars) when text is non-empty', () => {
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [{ role: 'AXTextArea', value: 'hash me' }]
    };
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('hash me');
    expect(result.extractedTextHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces deterministic results — calling extract twice returns byte-equal output', () => {
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        {
          role: 'AXWebArea',
          children: [
            { role: 'AXStaticText', value: 'line one' },
            { role: 'AXStaticText', value: 'line two' }
          ]
        }
      ]
    };
    const first = rule.extract(input(tree));
    const second = rule.extract(input(tree));
    expect(second).toEqual(first);
  });

  it('preserves frame metadata (frameId / frameTimestamp / appName / sourceTypes)', () => {
    const result = rule.extract(
      input(null, {
        frameId: 42,
        frameTimestamp: '2026-05-25T11:22:33.000Z',
        appName: 'Cursor',
        sourceTypes: ['accessibility', 'ocr']
      })
    );
    expect(result.frameId).toBe(42);
    expect(result.frameTimestamp).toBe('2026-05-25T11:22:33.000Z');
    expect(result.appName).toBe('Cursor');
    expect(result.sourceTypes).toEqual(['accessibility', 'ocr']);
  });

  it('builds contextKey from appName + normalised windowTitle', () => {
    const result = rule.extract(
      input(null, { appName: 'Code', windowTitle: '• Foo.ts' })
    );
    // normalizeWindowTitle strips the bullet and lowercases.
    expect(result.contextKey).toBe('Code::foo.ts');
  });
});

// ---------------------------------------------------------------------------
// Module-level constants — explicit contracts so a typo in either set
// fails loudly rather than silently letting noise back into the body.
// ---------------------------------------------------------------------------

describe('module constants', () => {
  it('UI_CHROME_ROLE_BLACKLIST contains the design-document baseline', () => {
    expect([...UI_CHROME_ROLE_BLACKLIST]).toEqual([
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
  });

  it('FOCUS_FALLBACK_ROLES is in the documented priority order', () => {
    // The order matters — `findFirstByRolePriority` walks roles in this
    // order so AXTextArea wins against a sibling AXTextField even if the
    // text field appears earlier in DFS.
    expect(FOCUS_FALLBACK_ROLES).toEqual([
      'AXTextArea',
      'AXWebArea',
      'AXScrollArea',
      'AXTextField'
    ]);
  });
});

// ---------------------------------------------------------------------------
// Schema-mismatch defence — keep `childrenOf` resilient to upstream drift
// ---------------------------------------------------------------------------

describe('GenericHeuristicRule.extract — schema robustness', () => {
  it('skips non-object child entries and still extracts the good ones', () => {
    // ScreenPipe AX serialisations occasionally include null-ish or
    // primitive entries inside `children`. Cast through unknown to slip
    // them past TypeScript while exercising the runtime defence in
    // childrenOf.
    const tree = {
      role: 'AXWebArea',
      children: [null, 1, 'bad', { role: 'AXStaticText', value: 'kept' }]
    } as unknown as NodeShape;
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('kept');
  });

  it('treats a non-array `children` field as "no children" without throwing', () => {
    // The anchor itself still carries a usable `value`, so the result
    // should be that value — not Empty_Extraction.
    const tree = {
      role: 'AXWebArea',
      children: 'not-an-array',
      value: 'anchor text'
    } as unknown as NodeShape;
    const result = rule.extract(input(tree));
    expect(result.extractedText).toBe('anchor text');
  });
});

// ---------------------------------------------------------------------------
// `flattenSubtreeText` — exported helper, basic coverage
// ---------------------------------------------------------------------------

describe('flattenSubtreeText', () => {
  it('joins text-bearing fields in DFS order with newlines', () => {
    const subtree: NodeShape = {
      role: 'AXTextArea',
      children: [
        { role: 'AXStaticText', value: 'one' },
        { role: 'AXStaticText', value: 'two' },
        {
          role: 'AXGroup',
          children: [{ role: 'AXStaticText', value: 'three' }]
        }
      ]
    };
    expect(flattenSubtreeText(subtree)).toBe('one\ntwo\nthree');
  });

  it('prefers value over text over description over title', () => {
    const subtree: NodeShape = {
      role: 'AXTextArea',
      // All four fields populated — value wins.
      value: 'V',
      text: 'T',
      description: 'D',
      title: 'TI'
    };
    expect(flattenSubtreeText(subtree)).toBe('V');
  });

  it('returns empty string when every node is whitespace-only', () => {
    const subtree: NodeShape = {
      role: 'AXTextArea',
      children: [
        { role: 'AXStaticText', value: '   ' },
        { role: 'AXStaticText', value: '\t\n' }
      ]
    };
    expect(flattenSubtreeText(subtree)).toBe('');
  });
});
