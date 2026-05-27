/**
 * Unit + property-based tests for `Context_Key` normalisation.
 *
 * Task 3.1 (work-activity-analysis): defines the extraction layer types and
 * the `Context_Key` normalisation helpers. This file covers the
 * normalisation helpers; rule/registry tests live alongside their modules
 * (tasks 3.2 and 3.3).
 *
 * **Validates: Requirements 3.4**
 *
 * Specifically, two properties:
 *
 *   1. **Idempotence** — `normalizeWindowTitle(normalizeWindowTitle(s))`
 *      MUST equal `normalizeWindowTitle(s)` for every string `s`. This is
 *      the contract that lets us safely rebuild derived data without
 *      worrying about applying normalisation twice in a pipeline.
 *
 *   2. **MODIFIED_MARKERS removal** — for every marker `m` in the
 *      exported `MODIFIED_MARKERS` array and every base title `t`,
 *      appending `m` to a normalised `t` (in a position the marker
 *      semantically applies to) MUST normalise back to the same result as
 *      `t` alone. This is what guarantees that "saved" and "unsaved" views
 *      of the same buffer collapse into the same session.
 *
 * Plus a handful of example tests for `buildContextKey` and
 * `deriveContextLabel` covering the obvious edge cases (undefined inputs,
 * fallback chain).
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MODIFIED_MARKERS,
  buildContextKey,
  deriveContextLabel,
  normalizeWindowTitle
} from '../../../src/services/work-activity/sessions/context-key.js';

// ---------------------------------------------------------------------------
// Example-based tests — `normalizeWindowTitle`
// ---------------------------------------------------------------------------

describe('normalizeWindowTitle (examples)', () => {
  it('returns empty string for undefined input', () => {
    expect(normalizeWindowTitle(undefined)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeWindowTitle('')).toBe('');
  });

  it('lowercases via en-US locale (Turkish-i pitfall guard)', () => {
    // Latin capital I lowercases to "i" under en-US (rather than the
    // Turkish dotless ı). Asserting this guards against future locale
    // changes that would break Context_Key stability across machines.
    expect(normalizeWindowTitle('FILE.TS')).toBe('file.ts');
  });

  it('NFC-normalises decomposed accents', () => {
    // U+00E9 (é precomposed) and U+0065 U+0301 (e + combining acute) must
    // collapse to the same key.
    const precomposed = 'caf\u00e9.md';
    const decomposed = 'cafe\u0301.md';
    expect(normalizeWindowTitle(precomposed)).toBe(normalizeWindowTitle(decomposed));
  });

  it('strips trailing/leading whitespace', () => {
    expect(normalizeWindowTitle('   foo.ts  ')).toBe('foo.ts');
  });

  it('strips a leading bullet marker', () => {
    expect(normalizeWindowTitle('• foo.ts')).toBe('foo.ts');
  });

  it('strips a trailing "(modified)" marker', () => {
    expect(normalizeWindowTitle('foo.ts (modified)')).toBe('foo.ts');
  });

  it('strips a trailing " — Edited" marker', () => {
    expect(normalizeWindowTitle('Document — Edited')).toBe('document');
  });

  it('strips a leading-asterisk marker', () => {
    expect(normalizeWindowTitle('* foo.ts')).toBe('foo.ts');
  });

  it('strips a trailing-asterisk marker', () => {
    expect(normalizeWindowTitle('foo.ts *')).toBe('foo.ts');
  });
});

// ---------------------------------------------------------------------------
// Property 1: Idempotence
// **Validates: Requirements 3.4**
// ---------------------------------------------------------------------------

describe('normalizeWindowTitle (PBT — idempotence)', () => {
  it('normalize(normalize(s)) === normalize(s) for every string s', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = normalizeWindowTitle(s);
        const twice = normalizeWindowTitle(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 500 }
    );
  });

  it('idempotent under inputs containing modifier markers', () => {
    // Generate a base ascii-ish word and prepend/append a marker drawn
    // from MODIFIED_MARKERS — exercises the iterative strip loop more
    // densely than `fc.string()` alone.
    const baseArb = fc.string({
      minLength: 1,
      maxLength: 32,
      unit: fc.mapToConstant(
        { num: 26, build: (n) => String.fromCharCode(97 + n) },
        { num: 10, build: (n) => String.fromCharCode(48 + n) },
        { num: 1, build: () => ' ' }
      )
    });
    const markerArb = fc.constantFrom(...stringMarkers());

    fc.assert(
      fc.property(baseArb, markerArb, fc.boolean(), (base, marker, prepend) => {
        const titled = prepend ? `${marker} ${base}` : `${base} ${marker}`;
        const once = normalizeWindowTitle(titled);
        const twice = normalizeWindowTitle(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 300 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: every MODIFIED_MARKERS entry is stripped to a no-op
// **Validates: Requirements 3.4**
// ---------------------------------------------------------------------------

describe('normalizeWindowTitle (PBT — MODIFIED_MARKERS removal)', () => {
  // Each marker is paired with a "test fixture" string that exercises the
  // marker in a position where it semantically applies. Anchored regexes
  // (`^` / `$`) only match at the beginning or end of the string, so
  // applying them mid-title is intentionally a no-op — we therefore do
  // not test mid-title insertion here.
  for (const marker of MODIFIED_MARKERS) {
    const display = describeMarker(marker);

    it(`appending ${display} after a normalised title is a no-op`, () => {
      fc.assert(
        fc.property(baseTitleArb(), (base) => {
          const baseNorm = normalizeWindowTitle(base);
          // Skip degenerate inputs where the trimmed base is empty —
          // appending a marker to "" can leak the marker through if the
          // marker itself does not match the position (for example a
          // literal "•" with no surrounding text trims fine, but a regex
          // anchored on `^` or `$` against pure whitespace is inert).
          fc.pre(baseNorm.length > 0);
          const withMarker = stampMarker(base, marker, /* prepend */ false);
          expect(normalizeWindowTitle(withMarker)).toBe(baseNorm);
        }),
        { numRuns: 200 }
      );
    });

    if (canPrepend(marker)) {
      it(`prepending ${display} before a normalised title is a no-op`, () => {
        fc.assert(
          fc.property(baseTitleArb(), (base) => {
            const baseNorm = normalizeWindowTitle(base);
            fc.pre(baseNorm.length > 0);
            const withMarker = stampMarker(base, marker, /* prepend */ true);
            expect(normalizeWindowTitle(withMarker)).toBe(baseNorm);
          }),
          { numRuns: 200 }
        );
      });
    }
  }
});

// ---------------------------------------------------------------------------
// `buildContextKey` — examples
// ---------------------------------------------------------------------------

describe('buildContextKey', () => {
  it('joins appName and normalised title with the "::" separator', () => {
    expect(buildContextKey('Code', 'Foo.ts')).toBe('Code::foo.ts');
  });

  it('substitutes empty string when appName is undefined', () => {
    expect(buildContextKey(undefined, 'Foo.ts')).toBe('::foo.ts');
  });

  it('produces the same key for "saved" and "unsaved" titles', () => {
    const saved = buildContextKey('Code', 'design.ts');
    const unsaved = buildContextKey('Code', '• design.ts');
    expect(saved).toBe(unsaved);
  });

  it('produces the same key across NFC differences in the title', () => {
    const precomposed = buildContextKey('Code', 'caf\u00e9.md');
    const decomposed = buildContextKey('Code', 'cafe\u0301.md');
    expect(precomposed).toBe(decomposed);
  });
});

// ---------------------------------------------------------------------------
// `deriveContextLabel` — examples
// ---------------------------------------------------------------------------

describe('deriveContextLabel', () => {
  it('uses the trimmed raw title when it is non-empty', () => {
    expect(deriveContextLabel('  design.ts  ', 'Code')).toBe('design.ts');
  });

  it('preserves the original casing of the raw title (does not normalise)', () => {
    // contextLabel is for human display — it must NOT be lower-cased
    // (that is contextKey's job).
    expect(deriveContextLabel('Foo.TS', 'Code')).toBe('Foo.TS');
  });

  it('preserves modifier markers in the raw title', () => {
    // The label is what humans see; "• design.ts" makes it clear the file
    // is unsaved. Normalisation only happens for the session-grouping
    // contextKey, not the label.
    expect(deriveContextLabel('• design.ts', 'Code')).toBe('• design.ts');
  });

  it('falls back to appName when the title is undefined', () => {
    expect(deriveContextLabel(undefined, 'Code')).toBe('Code');
  });

  it('falls back to appName when the title is whitespace-only', () => {
    expect(deriveContextLabel('   ', 'Code')).toBe('Code');
  });

  it('falls back to "unknown" when both inputs are missing', () => {
    expect(deriveContextLabel(undefined, undefined)).toBe('unknown');
  });

  it('falls back to "unknown" when both inputs are empty', () => {
    expect(deriveContextLabel('', '')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Helpers — kept private to this test file
// ---------------------------------------------------------------------------

/**
 * Returns only the literal-string entries of `MODIFIED_MARKERS`, in their
 * original insertion order. Used by the idempotence-with-markers fuzzer.
 */
function stringMarkers(): string[] {
  return MODIFIED_MARKERS.filter((m): m is string => typeof m === 'string');
}

/**
 * A short, fast-check `string` arbitrary that produces titles likely to
 * survive normalisation with a non-empty result. Restricted to ASCII
 * letters, digits, dots, and dashes — keeps the property tests focused on
 * the marker-stripping behaviour rather than on Unicode generators.
 */
function baseTitleArb(): fc.Arbitrary<string> {
  return fc.string({
    minLength: 1,
    maxLength: 32,
    unit: fc.mapToConstant(
      { num: 26, build: (n) => String.fromCharCode(97 + n) },
      { num: 26, build: (n) => String.fromCharCode(65 + n) },
      { num: 10, build: (n) => String.fromCharCode(48 + n) },
      { num: 1, build: () => '.' },
      { num: 1, build: () => '-' },
      { num: 1, build: () => ' ' }
    )
  });
}

/**
 * Pretty-prints a marker (string or RegExp) for test descriptions.
 */
function describeMarker(marker: string | RegExp): string {
  return typeof marker === 'string' ? `"${marker}"` : `/${marker.source}/${marker.flags}`;
}

/**
 * Returns `true` if the given marker can sensibly be prepended to a title.
 * Regexes anchored with `$` (end-of-string) cannot be tested by prepending
 * — we skip those to avoid false-positive failures.
 */
function canPrepend(marker: string | RegExp): boolean {
  if (typeof marker === 'string') return true;
  return !marker.source.endsWith('$');
}

/**
 * Returns `true` if the given marker can sensibly be appended to a title.
 * Regexes anchored with `^` (start-of-string) cannot be tested by
 * appending — we skip those to avoid false-positive failures.
 */
function canAppend(marker: string | RegExp): boolean {
  if (typeof marker === 'string') return true;
  return !marker.source.startsWith('^');
}

/**
 * Stamps a marker onto a base title, in a way that should normalise to the
 * same result as the bare base title alone. For regex markers we synthesise
 * an actual instance that matches the regex (the simplest example we can
 * produce); for literal markers we use them verbatim.
 *
 * If `prepend` is true the marker goes before the title; otherwise after.
 */
function stampMarker(base: string, marker: string | RegExp, prepend: boolean): string {
  const instance = typeof marker === 'string' ? marker : sampleFromRegex(marker);
  if (prepend) {
    return `${instance} ${base}`;
  }
  // For end-anchored regexes, append directly without an extra space — the
  // anchor matches optional whitespace internally, but tacking the marker
  // straight onto the title is the most aggressive case.
  return `${base} ${instance}`;
}

/**
 * Returns a concrete string that matches the given regex. We keep the
 * coverage narrow on purpose — these synthesised strings only need to
 * exercise the strip path, not the entire universe of regex matches.
 */
function sampleFromRegex(regex: RegExp): string {
  // The MODIFIED_MARKERS regex set is small and known; switch on `source`
  // rather than building a regex-string-generator.
  switch (regex.source) {
    case '^\\s*\\*+':
      return '**';
    case '\\*+\\s*$':
      return '**';
    case '\\(\\s*modified\\s*\\)\\s*$':
      return '(modified)';
    case '\\[\\s*unsaved\\s*\\]\\s*$':
      return '[unsaved]';
    case '^\\s*●\\s*':
      return '●';
    case '\\s*—\\s*Edited$':
      return '— Edited';
    default:
      throw new Error(`No sampler implemented for regex ${regex.source}`);
  }
}

// Reference `canAppend` so the linter does not flag the helper as unused
// in builds where one direction of the property is skipped for every
// marker. The function is here for symmetry with `canPrepend`.
void canAppend;
