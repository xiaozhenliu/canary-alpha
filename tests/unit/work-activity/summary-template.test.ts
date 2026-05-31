/**
 * Unit + property-based tests for `TemplateSummaryProvider`
 * (work-activity-analysis task 7.2).
 *
 * The provider has only one method (`generate`) and one job (render
 * a deterministic Chinese narrative from a `SummaryProviderInput`).
 * Two correctness properties from design §14 pin the implementation
 * down:
 *
 *   - **W17 Template_Determinism (R6.6)** — two back-to-back
 *     `generate(I)` calls MUST return the same `text` byte-for-byte.
 *     `latencyMs` may differ; the property is stated against `text`
 *     only.
 *   - **W19 No_Outbound_When_Default (R6.4 / R6.6)** — when the
 *     configured provider is `template`, `generate` MUST NOT issue
 *     any HTTP request. The test asserts no `fetch` / `http(s).request`
 *     call is made.
 *
 * A handful of example tests cover the rendering boundaries the
 * design touches on (zero / fractional / large minutes, empty
 * evidence list, embedded quotes / Chinese characters in the
 * `contextLabel`) and the structural invariants (`kind: 'ok'`,
 * `latencyMs >= 0`, provider `kind === 'template'`).
 *
 * **Validates: Requirements 6.2, 6.6**
 */

import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TemplateSummaryProvider } from '../../../src/services/work-activity/summary/template.js';
import type {
  SummaryProviderInput,
  SummaryProviderResult
} from '../../../src/services/work-activity/summary/types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Builds a `SummaryProviderInput` with sensible defaults. Each test
 * overrides only the fields it cares about, mirroring the helper
 * pattern in `embedding-service.test.ts`.
 */
function buildInput(
  overrides: Partial<SummaryProviderInput> = {}
): SummaryProviderInput {
  return {
    kind: 'session',
    sessionId: overrides.sessionId ?? 'session-uuid-1',
    appName: overrides.appName ?? 'Code',
    contextLabel: overrides.contextLabel ?? 'main.ts',
    startedAt: overrides.startedAt ?? '2026-05-25T10:00:00.000Z',
    endedAt: overrides.endedAt ?? '2026-05-25T10:05:00.000Z',
    activeSeconds: overrides.activeSeconds ?? 300,
    evidenceFragments: overrides.evidenceFragments ?? [
      {
        frameId: 1,
        timestamp: '2026-05-25T10:00:00.000Z',
        extractedText: 'hello world'
      }
    ]
  };
}

/**
 * Strategy for arbitrary `SummaryProviderInput` payloads. The
 * generators stay inside the input space the production pipeline
 * actually feeds the provider:
 *
 *   - `appName` / `contextLabel`: any unicode string (covers the
 *     Chinese characters and embedded `"` quotes that show up in
 *     real window titles).
 *   - `startedAt` / `endedAt`: arbitrary strings — the template
 *     interpolates them verbatim, so we exercise that the template
 *     does not parse them.
 *   - `activeSeconds`: non-negative finite number (the column is
 *     non-nullable and the aggregator never writes negative
 *     durations); covers integer and fractional values to nail down
 *     `Math.round` behaviour.
 *   - `evidenceFragments`: a `ReadonlyArray` of size 0..16 with
 *     minimal frame stubs. Size 16 is enough to differentiate the
 *     "共 N 帧证据" rendering from the trivial "共 0 帧证据" case
 *     without blowing up the number of property runs.
 */
const inputArb: fc.Arbitrary<SummaryProviderInput> = fc.record({
  kind: fc.constant('session' as const),
  sessionId: fc.uuid(),
  appName: fc.string({ maxLength: 64 }),
  contextLabel: fc.string({ maxLength: 64 }),
  startedAt: fc.string({ maxLength: 32 }),
  endedAt: fc.string({ maxLength: 32 }),
  activeSeconds: fc.double({
    min: 0,
    max: 86_400,
    noNaN: true,
    noDefaultInfinity: true
  }),
  evidenceFragments: fc.array(
    fc.record({
      frameId: fc.integer({ min: 0, max: 1_000_000 }),
      timestamp: fc.string({ maxLength: 32 }),
      extractedText: fc.string({ maxLength: 128 })
    }),
    { maxLength: 16 }
  )
});

// ---------------------------------------------------------------------------
// Example-based tests — rendering boundaries
// ---------------------------------------------------------------------------

describe('TemplateSummaryProvider.generate (examples)', () => {
  const provider = new TemplateSummaryProvider();

  it('exposes the `template` kind literal', () => {
    expect(provider.kind).toBe('template');
  });

  it('renders the design §6.2 template with the canonical fixture', async () => {
    const input = buildInput({
      appName: 'Code',
      contextLabel: 'main.ts',
      activeSeconds: 300,
      evidenceFragments: [
        { frameId: 1, timestamp: '2026-05-25T10:00:00.000Z', extractedText: 'a' },
        { frameId: 2, timestamp: '2026-05-25T10:00:30.000Z', extractedText: 'b' }
      ],
      startedAt: '2026-05-25T10:00:00.000Z',
      endedAt: '2026-05-25T10:05:00.000Z'
    });
    const result = await provider.generate(input);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return; // type narrow for the strict test
    expect(result.text).toBe(
      '在 Code 中工作约 5 分钟，围绕 "main.ts"，' +
        '共 2 帧证据（2026-05-25T10:00:00.000Z起，2026-05-25T10:05:00.000Z止）。'
    );
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('renders 0 minutes when activeSeconds is 0', async () => {
    const result = await provider.generate(buildInput({ activeSeconds: 0 }));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.text).toContain('约 0 分钟');
  });

  it('rounds 30 seconds up to 1 minute (Math.round half-away-from-zero)', async () => {
    const result = await provider.generate(buildInput({ activeSeconds: 30 }));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.text).toContain('约 1 分钟');
  });

  it('rounds 29 seconds down to 0 minutes', async () => {
    const result = await provider.generate(buildInput({ activeSeconds: 29 }));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.text).toContain('约 0 分钟');
  });

  it('renders "共 0 帧证据" when evidenceFragments is empty', async () => {
    const result = await provider.generate(
      buildInput({ evidenceFragments: [] })
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.text).toContain('共 0 帧证据');
  });

  it('passes Chinese characters through the template verbatim', async () => {
    const result = await provider.generate(
      buildInput({
        appName: '微信',
        contextLabel: '与张三的对话'
      })
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.text).toContain('在 微信 中工作');
    expect(result.text).toContain('围绕 "与张三的对话"');
  });

  it('does not break on contextLabel containing literal double quotes', async () => {
    // Real window titles do contain `"` (e.g. shells with quoted
    // arguments). The template surrounds the label with `"` already,
    // so an inner `"` will produce a slightly malformed visual
    // string. The important contract is "we don't crash and the
    // output is deterministic", which this test pins.
    const result = await provider.generate(
      buildInput({ contextLabel: 'echo "hi"' })
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.text).toContain('echo "hi"');
  });
});

// ---------------------------------------------------------------------------
// Property W17 — Template_Determinism
// **Validates: Requirements 6.6**
// ---------------------------------------------------------------------------

describe('TemplateSummaryProvider.generate (PBT — Template_Determinism / W17)', () => {
  const provider = new TemplateSummaryProvider();

  it('produces byte-identical `text` for two consecutive calls on the same input', async () => {
    await fc.assert(
      fc.asyncProperty(inputArb, async (input) => {
        const a = await provider.generate(input);
        const b = await provider.generate(input);
        expect(a.kind).toBe('ok');
        expect(b.kind).toBe('ok');
        // Narrow once and reuse — fast-check failures are reported
        // with the counterexample, so an in-test branch failure is
        // visible without further annotation.
        if (a.kind !== 'ok' || b.kind !== 'ok') return;
        expect(a.text).toBe(b.text);
      }),
      { numRuns: 200 }
    );
  });

  it('produces byte-identical `text` across two freshly constructed providers', async () => {
    // Guards against any accidental per-instance mutable state — if
    // someone refactors the class to memoise, the cache MUST stay
    // input-keyed so a brand new instance still produces the same
    // text.
    await fc.assert(
      fc.asyncProperty(inputArb, async (input) => {
        const a = await new TemplateSummaryProvider().generate(input);
        const b = await new TemplateSummaryProvider().generate(input);
        if (a.kind !== 'ok' || b.kind !== 'ok') {
          throw new Error(
            `expected both calls to return kind='ok', got ${a.kind} / ${b.kind}`
          );
        }
        expect(a.text).toBe(b.text);
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property W19 — No_Outbound_When_Default
// **Validates: Requirements 6.6**
// ---------------------------------------------------------------------------

describe('TemplateSummaryProvider.generate (PBT — No_Outbound_When_Default / W19)', () => {
  const provider = new TemplateSummaryProvider();

  // The remote-llm provider (task 7.3) uses Node 22's built-in
  // `fetch` for its egress — no `http.request` / `https.request`
  // calls. Spying on those low-level modules in ESM is also not
  // supported by Vitest. Replacing `globalThis.fetch` with a
  // counting stub is therefore both necessary and sufficient: it is
  // the single egress channel the broader summary subsystem can
  // plausibly hit, and the template implementation MUST stay clear
  // of it.
  let originalFetch: typeof globalThis.fetch | undefined;
  let fetchStub: ReturnType<typeof vi.fn> | undefined;

  beforeEach(() => {
    if (typeof globalThis.fetch === 'function') {
      originalFetch = globalThis.fetch;
      // The stub rejects so a future refactor that *does* introduce
      // an outbound call surfaces immediately rather than silently
      // passing the property because it ignored the spy. The PBT
      // assertion below uses the stub's call count as the canonical
      // signal.
      fetchStub = vi.fn(async () => {
        throw new Error(
          'TemplateSummaryProvider must not perform any outbound HTTP fetch'
        );
      });
      globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;
    }
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    fetchStub = undefined;
    originalFetch = undefined;
  });

  it('does not invoke globalThis.fetch for any input', async () => {
    await fc.assert(
      fc.asyncProperty(inputArb, async (input) => {
        const result: SummaryProviderResult = await provider.generate(input);
        expect(result.kind).toBe('ok');
      }),
      { numRuns: 200 }
    );
    expect(fetchStub?.mock.calls.length ?? 0).toBe(0);
  });
});
