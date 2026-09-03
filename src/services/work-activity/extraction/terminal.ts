/**
 * Terminal_Refinement_Rule — the application-specific routing rule in the
 * extraction registry.
 *
 * Terminal applications retain a dedicated rule kind for observability and
 * future terminal-specific refinements, but their payload is first processed
 * by `UniversalStructuredExtractor`. This keeps terminal frames in the same
 * full-window `[Window]` / `[Nav]` / `[Action]` / `[Body]` pipeline as every
 * other application instead of dropping toolbar, menu, or dialog content.
 */

import { UniversalStructuredExtractor } from './universal.js';
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
// Rule
// ---------------------------------------------------------------------------

/**
 * The Terminal_Refinement_Rule. `matches` selects known terminal apps while
 * `extract` delegates the full tree walk to the universal engine and only
 * changes the rule-kind discriminator to `terminal`.
 */
export class TerminalRefinementRule implements ExtractionRule {
  readonly kind = 'terminal' as const;
  private readonly universalExtractor = new UniversalStructuredExtractor();

  matches(input: ExtractionInput): boolean {
    return input.appName !== undefined && TERMINAL_APP_NAMES.has(input.appName);
  }

  extract(input: ExtractionInput): ExtractionResult {
    const universalResult = this.universalExtractor.extract(input);
    return {
      ...universalResult,
      extractionRuleKind: 'terminal',
    };
  }
}
