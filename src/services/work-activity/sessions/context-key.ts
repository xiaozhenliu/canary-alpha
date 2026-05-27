/**
 * Context_Key normalisation utilities.
 *
 * These helpers convert raw AX `windowTitle` values into a stable session
 * grouping key (`Context_Key`) and a human-facing display label
 * (`context_label`). The rules are taken verbatim from the
 * work-activity-analysis design document, §3 "Context_Key 归一化", and the
 * Glossary entry for `Context_Key` in `requirements.md`.
 *
 * Two windows that differ only in whitespace, NFC canonical form, casing, or
 * "modified" markers (such as `•`, `* file.ts`, `(modified)`) MUST map to
 * the same `Context_Key` so the session aggregator does not split a single
 * editing session across "saved" and "unsaved" frames.
 *
 * The `MODIFIED_MARKERS` array is exported on purpose — property-based
 * tests iterate over it to verify that adding any marker to a normalised
 * title is a no-op after re-normalisation.
 */

/**
 * Editor "this buffer is dirty" markers stripped during normalisation.
 *
 * The list is intentionally an ordered mix of literal substrings and
 * regular expressions:
 *
 *   - **Literal strings** are removed by `split(...).join('')`. Use these
 *     for single-character markers (`•`, `●`, `◆`) that may appear anywhere
 *     in the title.
 *   - **Regular expressions** are removed by `replace(regex, '')` (without
 *     the `g` flag — only the first match per call). They are anchored
 *     where it matters (`^` / `$`) so that a marker substring inside legit
 *     window content (for example a literal "*" in a search query window
 *     title) is not stripped.
 *
 * Adding new markers is a backwards-compatible change: derived
 * `extracted_content` and `sessions` rows are rebuilt on rule changes
 * (R1.8 / R3.8), so we never need to migrate historical data.
 */
export const MODIFIED_MARKERS: ReadonlyArray<string | RegExp> = [
  '•',
  '●',
  '◆',
  /^\s*\*+/,
  /\*+\s*$/,
  /\(\s*modified\s*\)\s*$/i,
  /\[\s*unsaved\s*\]\s*$/i,
  /^\s*●\s*/,
  /\s*—\s*Edited$/i
];

/**
 * Normalises a raw window title for use as part of `Context_Key`.
 *
 * The pipeline is:
 *
 *   1. `undefined` / empty input → empty string.
 *   2. Unicode NFC normalisation (so visually identical titles with
 *      decomposed vs. precomposed accents collapse).
 *   3. Trim outer whitespace.
 *   4. Iteratively strip every `MODIFIED_MARKERS` entry, trimming after
 *      each removal so positional anchors (`^` / `$`) keep working.
 *   5. `toLocaleLowerCase('en-US')` — the explicit locale avoids the
 *      Turkish-i pitfall (where the dotless `i` lower-cases differently
 *      depending on the host locale) so two machines produce identical
 *      keys.
 *
 * The function is **idempotent**: `normalize(normalize(s)) === normalize(s)`
 * for every string `s`. The fast-check property test in
 * `tests/unit/work-activity/context-key.test.ts` enforces this.
 */
export function normalizeWindowTitle(rawTitle: string | undefined): string {
  if (rawTitle === undefined || rawTitle === '') return '';

  let normalized = rawTitle.normalize('NFC').trim();

  for (const marker of MODIFIED_MARKERS) {
    if (typeof marker === 'string') {
      normalized = normalized.split(marker).join('').trim();
    } else {
      normalized = normalized.replace(marker, '').trim();
    }
  }

  return normalized.toLocaleLowerCase('en-US');
}

/**
 * Builds the `Context_Key` used to bucket frames into sessions.
 *
 * The shape is `${appName ?? ''}::${normalizeWindowTitle(rawTitle)}`. Two
 * frames whose `Context_Key` is equal (and whose timestamps are within
 * `Idle_Threshold_Seconds` of each other) extend the same session;
 * everything else starts a new session.
 *
 * The empty-string fallback for `appName` is intentional — frames without
 * an `appName` should still group consistently by their normalised title
 * rather than collide with `undefined::...` (which TypeScript would render
 * as the string `"undefined"`).
 */
export function buildContextKey(
  appName: string | undefined,
  rawTitle: string | undefined
): string {
  const normalizedTitle = normalizeWindowTitle(rawTitle);
  return `${appName ?? ''}::${normalizedTitle}`;
}

/**
 * Picks a non-empty human label for a session/extraction record (R1.6).
 *
 * Priority order:
 *
 *   1. The trimmed raw window title, if non-empty.
 *   2. The application name, if provided.
 *   3. The literal `'unknown'` as a final guard so downstream consumers
 *      never have to handle an empty label.
 *
 * Note that this returns the **un-normalised** title — `context_label` is
 * displayed to users and should preserve casing, accents, and any in-title
 * modifiers. `Context_Key` (the session-grouping key) is built separately
 * by {@link buildContextKey}.
 */
export function deriveContextLabel(
  rawTitle: string | undefined,
  appName: string | undefined
): string {
  const trimmed = rawTitle?.trim() ?? '';
  if (trimmed.length > 0) return trimmed;
  if (appName !== undefined && appName.length > 0) return appName;
  return 'unknown';
}
