/**
 * Property-based + example tests for the extraction registry chain.
 *
 * Task 3.3 (work-activity-analysis): wires `TerminalRefinementRule` in
 * front of `GenericHeuristicRule` and exposes the chain via
 * `createExtractionRegistry()`. The properties below correspond to the
 * three R1-level invariants in the design document
 * (`work-activity-analysis/design.md`, §"Correctness Properties"):
 *
 *   - **W1 — Determinism (R1.1).** `extract(input)` called twice on the
 *     same `ExtractionInput` returns byte-equal `ExtractionResult`s.
 *   - **W2 — Coverage (R1.5 / R1.6).** Every input — even null AX
 *     trees, malformed JSON, schema mismatches — produces exactly one
 *     `ExtractionResult` with a non-empty `contextLabel`.
 *   - **W3 — Refinement_Override (R1.4).** When `appName` is in
 *     `TERMINAL_APP_NAMES`, `extract(input).extractionRuleKind` is
 *     `'terminal'`; otherwise it is `'generic'`.
 *
 * The PBT generators are deliberately small (depth ≤ 3, branching ≤ 4)
 * — the goal is to fuzz the rule-chain behaviour, not exhaustively
 * cover the AX schema. Examples-based tests cover hand-picked terminal
 * fixtures and the chain order.
 *
 * **Validates: Requirements 1.3, 1.4, 1.5**
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { GenericHeuristicRule } from '../../../src/services/work-activity/extraction/generic.js';
import {
  DefaultExtractionRegistry,
  createExtractionRegistry
} from '../../../src/services/work-activity/extraction/registry.js';
import {
  TERMINAL_APP_NAMES,
  TerminalRefinementRule
} from '../../../src/services/work-activity/extraction/terminal.js';
import type {
  ExtractionInput,
  ExtractionResult,
  ExtractionRule
} from '../../../src/services/work-activity/extraction/types.js';

// ---------------------------------------------------------------------------
// Helpers — small AX node shape, hand-built fixtures, JSON serialisation
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

function buildInput(overrides: Partial<ExtractionInput> = {}): ExtractionInput {
  return {
    frameId: 1,
    frameTimestamp: '2026-05-25T10:00:00.000Z',
    appName: undefined,
    windowTitle: 'TestWindow',
    accessibilityTreeJson: null,
    sourceTypes: ['accessibility'],
    ...overrides
  };
}

function jsonOf(tree: NodeShape): string {
  return JSON.stringify(tree);
}

// ---------------------------------------------------------------------------
// Examples — chain order
// ---------------------------------------------------------------------------

describe('createExtractionRegistry — chain order (examples)', () => {
  it('routes Terminal frames to the terminal rule', () => {
    const registry = createExtractionRegistry();
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [{ role: 'AXTextArea', value: 'zsh prompt body' }]
    };
    const result = registry.extract(
      buildInput({
        appName: 'iTerm2',
        windowTitle: '~/code (zsh)',
        accessibilityTreeJson: jsonOf(tree)
      })
    );
    expect(result.extractionRuleKind).toBe('terminal');
    expect(result.extractedText).toBe('zsh prompt body');
    // contextLabel uses the raw window title, un-normalised.
    expect(result.contextLabel).toBe('~/code (zsh)');
  });

  it('routes non-terminal frames to the generic rule', () => {
    const registry = createExtractionRegistry();
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [{ role: 'AXWebArea', value: 'browser body' }]
    };
    const result = registry.extract(
      buildInput({
        appName: 'Safari',
        windowTitle: 'Example Page',
        accessibilityTreeJson: jsonOf(tree)
      })
    );
    expect(result.extractionRuleKind).toBe('generic');
    expect(result.extractedText).toBe('browser body');
  });

  it('routes frames without appName to the generic rule', () => {
    const registry = createExtractionRegistry();
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [{ role: 'AXTextArea', value: 'no-app body' }]
    };
    const result = registry.extract(
      buildInput({
        appName: undefined,
        accessibilityTreeJson: jsonOf(tree)
      })
    );
    expect(result.extractionRuleKind).toBe('generic');
    expect(result.extractedText).toBe('no-app body');
  });

  it('returns Empty_Extraction with terminal kind when terminal AX tree has no AXTextArea', () => {
    const registry = createExtractionRegistry();
    // AXScrollArea is a generic anchor but the terminal rule looks for
    // AXTextArea specifically — so the rule matches (appName is in the
    // set) and produces an Empty_Extraction tagged 'terminal' rather
    // than falling through to the generic rule.
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [{ role: 'AXScrollArea', value: 'scroll body' }]
    };
    const result = registry.extract(
      buildInput({
        appName: 'Terminal',
        windowTitle: 'Terminal',
        accessibilityTreeJson: jsonOf(tree)
      })
    );
    expect(result.extractionRuleKind).toBe('terminal');
    expect(result.extractedText).toBe('');
    expect(result.extractedTextHash).toBeNull();
    expect(result.contextLabel).toBe('Terminal');
  });

  it('terminal rule output can differ from generic rule output for the same frame', () => {
    // The generic rule would prefer a focused AXScrollArea; the terminal
    // rule ignores focus and takes the first AXTextArea body. This is
    // the subtle case the W3 (Refinement_Override) property protects.
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        { role: 'AXTextArea', value: 'terminal buffer body' },
        {
          role: 'AXScrollArea',
          children: [
            { role: 'AXStaticText', focused: true, value: 'focused popup body' }
          ]
        }
      ]
    };
    const json = jsonOf(tree);
    const input = buildInput({
      appName: 'iTerm',
      windowTitle: 'session',
      accessibilityTreeJson: json
    });

    const fromTerminal = new TerminalRefinementRule().extract(input);
    const fromGeneric = new GenericHeuristicRule().extract(input);
    expect(fromTerminal.extractedText).toBe('terminal buffer body');
    expect(fromGeneric.extractedText).toBe('focused popup body');

    // Registry chain should pick the terminal output (W3).
    const result = createExtractionRegistry().extract(input);
    expect(result.extractionRuleKind).toBe('terminal');
    expect(result.extractedText).toBe(fromTerminal.extractedText);
  });

  it('uses the first AXTextArea when multiple are present', () => {
    const registry = createExtractionRegistry();
    const tree: NodeShape = {
      role: 'AXApplication',
      children: [
        { role: 'AXTextArea', value: 'first buffer' },
        { role: 'AXTextArea', value: 'second buffer' }
      ]
    };
    const result = registry.extract(
      buildInput({
        appName: 'iTerm2',
        windowTitle: 'split panes',
        accessibilityTreeJson: jsonOf(tree)
      })
    );
    expect(result.extractionRuleKind).toBe('terminal');
    expect(result.extractedText).toBe('first buffer');
  });
});

// ---------------------------------------------------------------------------
// Examples — terminal rule failure modes (Empty_Extraction collapse)
//
// Each row asserts that the listed `accessibilityTreeJson` payload
// collapses to an `Empty_Extraction` tagged with `extractionRuleKind:
// 'terminal'`. The set covers the failure modes both `terminal.ts`'s
// local `isAccessibilityNode` / `childrenOf` helpers and the AXTextArea
// search must handle defensively. The PBT generators above hit the
// same paths probabilistically; this table ensures CI flags a
// regression even when the fuzzer happens not to draw the case.
// ---------------------------------------------------------------------------

describe('createExtractionRegistry — terminal rule failure modes (examples)', () => {
  const blankBufferJson = JSON.stringify({
    role: 'AXApplication',
    children: [{ role: 'AXTextArea', value: '   ' }]
  });
  const noTextAreaJson = JSON.stringify({
    role: 'AXApplication',
    children: [{ role: 'AXScrollArea', value: 'scroll body' }]
  });

  // [name, accessibilityTreeJson] tuples. Using `it.each` so the row
  // name shows up in test output and a regression points at the exact
  // payload that broke.
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    ['null AX JSON', null],
    ['malformed JSON', '{ not valid json'],
    ['array root (schema mismatch)', '[]'],
    ['JSON null root', 'null'],
    ['primitive root (number)', '42'],
    ['primitive root (string)', '"oops"'],
    ['no AXTextArea anywhere', noTextAreaJson],
    ['AXTextArea present but blank text', blankBufferJson]
  ];

  it.each(cases)(
    'terminal frame with %s collapses to Empty_Extraction (kind="terminal")',
    (_name, accessibilityTreeJson) => {
      const result = createExtractionRegistry().extract(
        buildInput({
          appName: 'Terminal',
          windowTitle: 'session',
          accessibilityTreeJson
        })
      );
      expect(result.extractionRuleKind).toBe('terminal');
      expect(result.extractedText).toBe('');
      expect(result.extractedTextHash).toBeNull();
      expect(result.contextLabel.length).toBeGreaterThan(0);
    }
  );
});

// ---------------------------------------------------------------------------
// Examples — DefaultExtractionRegistry guard rails
// ---------------------------------------------------------------------------

describe('DefaultExtractionRegistry — guard rails (examples)', () => {
  it('throws when constructed without a guaranteed-match tail rule', () => {
    const registry = new DefaultExtractionRegistry([new TerminalRefinementRule()]);
    expect(() =>
      registry.extract(buildInput({ appName: 'Safari' }))
    ).toThrow(/no rule matched/);
  });

  it('walks rules in order and stops at the first match', () => {
    // Two rules whose matches() both return true — the first wins.
    const calls: string[] = [];
    const ruleA: ExtractionRule = {
      kind: 'terminal',
      matches: () => {
        calls.push('A.matches');
        return true;
      },
      extract: (input) => {
        calls.push('A.extract');
        return makeFakeResult(input, 'terminal', 'A');
      }
    };
    const ruleB: ExtractionRule = {
      kind: 'generic',
      matches: () => {
        calls.push('B.matches');
        return true;
      },
      extract: (input) => {
        calls.push('B.extract');
        return makeFakeResult(input, 'generic', 'B');
      }
    };
    const registry = new DefaultExtractionRegistry([ruleA, ruleB]);
    const result = registry.extract(buildInput({ appName: 'X' }));
    expect(result.extractedText).toBe('A');
    expect(calls).toEqual(['A.matches', 'A.extract']);
  });

  it('isolates the rule chain from caller mutations after construction', () => {
    // Callers can pass a `ExtractionRule[]` (TypeScript variance permits
    // this even though the parameter is `ReadonlyArray`). Mutating it
    // post-construction must NOT affect later extract() calls — that
    // would silently break Determinism (W1) and Refinement_Override
    // (W3) without any visible warning.
    const rules: ExtractionRule[] = [
      new TerminalRefinementRule(),
      new GenericHeuristicRule()
    ];
    const registry = new DefaultExtractionRegistry(rules);

    // Mutation 1: clearing the original array.
    rules.length = 0;
    // Mutation 2: pushing a hostile rule that would otherwise win.
    rules.push({
      kind: 'generic',
      matches: () => true,
      extract: (input) => makeFakeResult(input, 'generic', 'HIJACKED')
    } satisfies ExtractionRule);

    const result = registry.extract(
      buildInput({
        appName: 'Safari',
        accessibilityTreeJson: jsonOf({
          role: 'AXApplication',
          children: [{ role: 'AXWebArea', value: 'real body' }]
        })
      })
    );
    // Real generic rule still runs — registry's internal copy was not
    // affected by the post-construction mutation.
    expect(result.extractionRuleKind).toBe('generic');
    expect(result.extractedText).toBe('real body');
  });
});

function makeFakeResult(
  input: ExtractionInput,
  kind: 'generic' | 'terminal',
  text: string
): ExtractionResult {
  return {
    frameId: input.frameId,
    frameTimestamp: input.frameTimestamp,
    appName: input.appName,
    contextLabel: 'fake',
    contextKey: 'fake::fake',
    extractedText: text,
    extractedTextHash: null,
    extractionRuleKind: kind,
    sourceTypes: input.sourceTypes
  };
}

// ---------------------------------------------------------------------------
// Property-based generators
// ---------------------------------------------------------------------------

/**
 * A small AX-node arbitrary suitable for fuzzing the registry chain.
 *
 * The generator is deliberately constrained:
 *   - Roles drawn from a curated mix of "anchor" roles (AXTextArea,
 *     AXWebArea, AXScrollArea, AXTextField), chrome roles
 *     (AXMenuBar, AXButton, …), and a generic AXGroup container.
 *   - Text fields drawn from short ASCII-ish strings so the SHA256
 *     hash field exercises the non-null branch frequently.
 *   - Bounded tree depth (≤ 3) and bounded branching (≤ 4) — keeps
 *     each `numRuns` cheap and avoids hitting JSON.stringify limits.
 *   - `focused: true` appears occasionally so the generic rule's
 *     focused-element ancestor walk is exercised too.
 */
const ROLE_POOL = [
  'AXApplication',
  'AXWindow',
  'AXMainWindow',
  'AXGroup',
  'AXTextArea',
  'AXWebArea',
  'AXScrollArea',
  'AXTextField',
  'AXStaticText',
  'AXButton',
  'AXMenuBar',
  'AXToolbar'
];

const textFieldArb = fc.option(
  fc.string({ minLength: 0, maxLength: 24 }),
  { nil: undefined }
);

function nodeArb(): fc.Arbitrary<NodeShape> {
  const { node } = fc.letrec<{ node: NodeShape; leaf: NodeShape }>((tie) => ({
    leaf: fc.record(
      {
        role: fc.constantFrom(...ROLE_POOL),
        value: textFieldArb,
        text: textFieldArb,
        description: textFieldArb,
        title: textFieldArb,
        focused: fc.option(fc.boolean(), { nil: undefined })
      },
      { requiredKeys: ['role'] }
    ),
    node: fc.oneof(
      { maxDepth: 3, depthSize: 'small' },
      tie('leaf'),
      fc.record(
        {
          role: fc.constantFrom(...ROLE_POOL),
          value: textFieldArb,
          title: textFieldArb,
          focused: fc.option(fc.boolean(), { nil: undefined }),
          children: fc.array(tie('node'), { minLength: 0, maxLength: 4 })
        },
        { requiredKeys: ['role'] }
      )
    )
  }));
  return node;
}

/**
 * Produces a JSON string sometimes valid (a serialised AX tree),
 * sometimes `null`, sometimes a malformed JSON string. Drives the
 * Coverage property's "every input produces a result" guarantee.
 */
const accessibilityTreeJsonArb = fc.oneof(
  { weight: 6, arbitrary: nodeArb().map((n) => JSON.stringify(n)) },
  { weight: 1, arbitrary: fc.constant<string | null>(null) },
  { weight: 1, arbitrary: fc.constant<string | null>('{ not valid json') },
  { weight: 1, arbitrary: fc.constant<string | null>('[]') }
);

const appNameArb = fc.oneof(
  // Half the time draw from the terminal set so W3 sees both branches
  // with comparable frequency.
  { weight: 3, arbitrary: fc.constantFrom(...TERMINAL_APP_NAMES) },
  {
    weight: 4,
    arbitrary: fc.constantFrom('Safari', 'Code', 'Chrome', 'Slack', 'Cursor', 'Notes')
  },
  { weight: 1, arbitrary: fc.constant<string | undefined>(undefined) }
);

const windowTitleArb = fc.oneof(
  fc.string({ minLength: 0, maxLength: 32 }),
  fc.constant<string | undefined>(undefined)
);

const inputArb: fc.Arbitrary<ExtractionInput> = fc.record({
  frameId: fc.integer({ min: 1, max: 1_000_000 }),
  frameTimestamp: fc.constant('2026-05-25T10:00:00.000Z'),
  appName: appNameArb,
  windowTitle: windowTitleArb,
  accessibilityTreeJson: accessibilityTreeJsonArb,
  sourceTypes: fc.constant<string[]>(['accessibility'])
});

// ---------------------------------------------------------------------------
// Property W1 — Determinism
// **Validates: Requirements 1.3**
// ---------------------------------------------------------------------------

describe('createExtractionRegistry — W1 Determinism', () => {
  it('extract(input) returns byte-equal ExtractionResults across two calls', () => {
    const registry = createExtractionRegistry();
    fc.assert(
      fc.property(inputArb, (input) => {
        const a = registry.extract(input);
        const b = registry.extract(input);
        expect(b).toEqual(a);
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property W2 — Coverage
// **Validates: Requirements 1.5**
// ---------------------------------------------------------------------------

describe('createExtractionRegistry — W2 Coverage', () => {
  it('always returns exactly one ExtractionResult with a non-empty contextLabel', () => {
    const registry = createExtractionRegistry();
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = registry.extract(input);
        // Coverage means: the call returns. Empty_Extraction is allowed
        // (extractedText === '') but the result itself MUST exist with
        // every required field populated.
        expect(typeof result.extractedText).toBe('string');
        expect(result.contextLabel.length).toBeGreaterThan(0);
        expect(result.contextKey.length).toBeGreaterThan(0);
        expect(result.frameId).toBe(input.frameId);
        expect(result.frameTimestamp).toBe(input.frameTimestamp);
        expect(result.sourceTypes).toEqual(input.sourceTypes);
        // Hash invariant: null iff text empty.
        if (result.extractedText === '') {
          expect(result.extractedTextHash).toBeNull();
        } else {
          expect(result.extractedTextHash).toMatch(/^[0-9a-f]{64}$/);
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property W3 — Refinement_Override
// **Validates: Requirements 1.4**
// ---------------------------------------------------------------------------

describe('createExtractionRegistry — W3 Refinement_Override', () => {
  it('extractionRuleKind === "terminal" iff appName is in TERMINAL_APP_NAMES', () => {
    const registry = createExtractionRegistry();
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = registry.extract(input);
        const expectTerminal =
          input.appName !== undefined && TERMINAL_APP_NAMES.has(input.appName);
        if (expectTerminal) {
          expect(result.extractionRuleKind).toBe('terminal');
        } else {
          expect(result.extractionRuleKind).toBe('generic');
        }
      }),
      { numRuns: 200 }
    );
  });

  it('terminal-app frames produce text equal to the standalone TerminalRefinementRule', () => {
    // Stronger form of W3: when the registry routes to the terminal
    // rule, its output equals the rule's own output (not the generic
    // rule's). This catches a regression where the chain order is
    // reversed — the generic rule would always match first and the
    // terminal output would never reach callers.
    const registry = createExtractionRegistry();
    const standalone = new TerminalRefinementRule();
    const terminalAppArb = fc.constantFrom(...TERMINAL_APP_NAMES);
    fc.assert(
      fc.property(
        inputArb,
        terminalAppArb,
        (input, terminalApp) => {
          const terminalInput: ExtractionInput = { ...input, appName: terminalApp };
          const fromRegistry = registry.extract(terminalInput);
          const fromRule = standalone.extract(terminalInput);
          expect(fromRegistry.extractionRuleKind).toBe('terminal');
          expect(fromRegistry.extractedText).toBe(fromRule.extractedText);
          expect(fromRegistry.extractedTextHash).toBe(fromRule.extractedTextHash);
        }
      ),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// `TERMINAL_APP_NAMES` — explicit contract
// ---------------------------------------------------------------------------

describe('TERMINAL_APP_NAMES', () => {
  it('matches the design-document baseline', () => {
    expect([...TERMINAL_APP_NAMES].sort()).toEqual(['Terminal', 'iTerm', 'iTerm2'].sort());
  });
});
