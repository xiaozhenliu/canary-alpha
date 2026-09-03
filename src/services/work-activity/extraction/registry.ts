/**
 * Default `ExtractionRegistry` implementation and factory.
 *
 * The registry is the single entry point the indexing loop calls per
 * frame: `registry.extract(input)` returns exactly one `ExtractionResult`
 * (Coverage property, R1 / W2). Internally the registry walks a list of
 * rules in priority order — refinement rules first, then the
 * `Generic_Heuristic` as the guaranteed tail-of-chain fallback.
 *
 * The chain order is what guarantees the **Refinement_Override** property
 * (R1.4 / W3): when a frame's `appName` is in `TERMINAL_APP_NAMES`, the
 * `TerminalRefinementRule` matches first and its result wins; the
 * generic rule is never consulted. The same shape is used to add new
 * refinement rules in the future — append before the generic rule, do
 * not change the registry interface (R1.3).
 *
 * The factory `createExtractionRegistry()` is called from
 * `bootstrap/create-app.ts` so the production wiring sees a single
 * canonical chain. Tests construct rules directly when they need to
 * substitute a stub.
 */

import { GenericHeuristicRule, UniversalStructuredExtractor } from './generic.js';
import { TerminalRefinementRule } from './terminal.js';
import type {
  ExtractionInput,
  ExtractionResult,
  ExtractionRegistry,
  ExtractionRule
} from './types.js';

/**
 * The default registry. Walks `rules` in order, returning the first
 * rule whose `matches` returns `true`. The constructor takes the list
 * verbatim — callers are responsible for putting refinement rules
 * before the generic fallback (the {@link createExtractionRegistry}
 * factory does this for production).
 *
 * Construction is intentionally cheap (no I/O, no allocation beyond
 * the rule list) so the registry can be created once at startup and
 * reused for the entire indexer lifetime.
 */
export class DefaultExtractionRegistry implements ExtractionRegistry {
  private readonly rules: ReadonlyArray<ExtractionRule>;

  constructor(rules: ReadonlyArray<ExtractionRule>) {
    // Defensive copy + freeze: the constructor parameter is typed
    // `ReadonlyArray<ExtractionRule>` but TypeScript variance lets a
    // caller pass a mutable `ExtractionRule[]` and keep mutating it
    // afterwards. Without copying, two `extract()` calls on the same
    // registry could see different rule chains, breaking the
    // Determinism (W1) and Refinement_Override (W3) properties.
    this.rules = Object.freeze([...rules]);
  }

  extract(input: ExtractionInput): ExtractionResult {
    for (const rule of this.rules) {
      if (rule.matches(input)) {
        return rule.extract(input);
      }
    }
    // The factory always installs `UniversalStructuredExtractor` last and that
    // rule's `matches` is the constant `true`, so this branch is
    // unreachable in production. We throw rather than return a bare
    // object so a future contributor cannot accidentally break the
    // Coverage invariant by constructing a registry without a generic
    // tail rule and then silently emitting partial records.
    throw new Error(
      'ExtractionRegistry: no rule matched. The chain MUST end with a guaranteed-match rule (e.g. UniversalStructuredExtractor or GenericHeuristicRule).'
    );
  }
}

/**
 * Production-wiring factory. Builds the canonical chain
 * `[TerminalRefinementRule, UniversalStructuredExtractor]` (refinement first,
 * universal structured extractor last).
 *
 * Adding a new refinement rule in the future means inserting it before
 * `UniversalStructuredExtractor` in this list — the consumer-facing
 * `ExtractionRegistry` interface does not change, and downstream
 * components (`Session_Aggregator`, `Embedding_Service`,
 * `ExtractedContentStore`) keep working.
 */
export function createExtractionRegistry(): ExtractionRegistry {
  return new DefaultExtractionRegistry([
    new TerminalRefinementRule(),
    new UniversalStructuredExtractor()
  ]);
}
