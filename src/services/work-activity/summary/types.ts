/**
 * Canonical type definitions for the `SummaryProvider` abstraction.
 *
 * Task 7.1 (work-activity-analysis): this file is the single source of
 * truth for the five summary-layer types — `SummaryStatus`,
 * `SummaryProviderInput`, `SummaryProviderResult`, `SummaryProviderError`,
 * and `SummaryProvider` — exactly as specified in design §6.1.
 *
 * `SummaryStatus` was historically declared in
 * {@link ../sessions/session-store.ts} (task 4.1) so the SQL row
 * mapper could narrow the `summary_status` column to a literal union.
 * That declaration is now an `import + re-export` of the canonical
 * type defined here, keeping a single source of truth across the
 * package while preserving the existing import path used by the
 * session-store unit tests.
 *
 * The file is intentionally type-only — there is no runtime code, no
 * default export, and no side effects. Concrete provider classes
 * (template, remote-llm) live in sibling files and import these
 * interfaces (tasks 7.2 / 7.3).
 *
 * **Validates: Requirements 6.1**
 */

// ---------------------------------------------------------------------------
// SummaryStatus
// ---------------------------------------------------------------------------

/**
 * Lifecycle states the summary subsystem assigns to a session row.
 *
 * The literal values match the strings the SQL writer stores in the
 * `sessions.summary_status` column (see design §1 schema and design
 * §6 / §6.5 for the state-machine semantics):
 *
 *   - `'pending'` — the session has been enqueued for summarisation
 *     but no provider call has completed yet. The aggregator marks a
 *     freshly closed session pending; observability counts these as
 *     `summary.pendingCount` (R8).
 *   - `'ready'` — a provider returned `kind: 'ok'` and the resulting
 *     `summary_text` plus `summary_provider_kind` plus
 *     `summary_generated_at` have been written.
 *   - `'failed'` — a permanent failure path (the configured provider
 *     errored AND the template fallback also failed, which in practice
 *     means a programmer error since the template is deterministic
 *     and dependency-free; see R6.7).
 *   - `'degraded'` — the configured provider was unavailable, the
 *     template fallback produced the current text, and the worker
 *     should retry the configured provider on the next call. The
 *     `summary_text` column is populated in this state too.
 *   - `'not_applicable'` — the session is ineligible for a summary
 *     (e.g. every evidence frame is `Empty_Extraction`), so the
 *     worker will never attempt to fill `summary_text`.
 *
 * The order of the union mirrors the state-machine diagram in design
 * §6 to keep grep / diff output predictable.
 */
export type SummaryStatus =
  | 'pending'
  | 'ready'
  | 'failed'
  | 'degraded'
  | 'not_applicable';

// ---------------------------------------------------------------------------
// SummaryProviderInput
// ---------------------------------------------------------------------------

/**
 * The single, structured payload a provider receives from
 * `SummaryWorker.ensureSummary` (design §6.5). Fields mirror the
 * relevant columns on `sessions` plus a snapshot of the evidence frames
 * pulled from `extracted_content`.
 *
 * `kind: 'session'` is a discriminator: design §6.1 reserves the slot
 * for a future `'time-block'` payload (so `recall(granularity='hour' |
 * 'day')` could one day route through a provider too). The first
 * delivery of this spec only uses `'session'`; per design §6.1 the
 * recall time-block narrative goes through a deterministic template,
 * not the provider, to avoid a 168×-per-week-query LLM blowup.
 *
 * Field semantics:
 *
 *   - `sessionId` — UUID of the session row being summarised. The
 *     remote-llm provider does not embed this in its prompt; it is
 *     here so the worker can correlate logs/health metrics with a
 *     specific row.
 *   - `appName` / `contextLabel` — surfaced verbatim in the template
 *     and in the remote-llm prompt's structured header so the model
 *     can ground the narrative in the right activity.
 *   - `startedAt` / `endedAt` — ISO-8601 strings (UTC) matching the
 *     `sessions.started_at` / `ended_at` columns. Already-formatted so
 *     the provider does not own date formatting.
 *   - `activeSeconds` — same column on `sessions`; the template uses
 *     it to render the human-friendly "约 N 分钟" prefix (design §6.2).
 *   - `evidenceFragments` — read-only array of the per-frame extracted
 *     text plus its `frame_id` and timestamp. Read-only because the
 *     worker reuses the input across retries and providers MUST NOT
 *     mutate the slice. The element shape is intentionally minimal:
 *     anything else a provider needs (`appName`, `contextLabel`)
 *     already lives at the input root.
 */
export interface SummaryProviderInput {
  kind: 'session';
  sessionId: string;
  appName: string;
  contextLabel: string;
  startedAt: string;
  endedAt: string;
  activeSeconds: number;
  evidenceFragments: ReadonlyArray<{
    frameId: number;
    timestamp: string;
    extractedText: string;
  }>;
}

// ---------------------------------------------------------------------------
// SummaryProviderResult / SummaryProviderError
// ---------------------------------------------------------------------------

/**
 * Discriminated-union result from a provider call.
 *
 * Providers MUST resolve their `Promise` with one of these two
 * shapes — they MUST NOT throw to signal a recoverable error. The
 * worker's branching logic (design §6.5) reads the discriminator and
 * decides whether to fall back to the template (`error`) or commit
 * the text to the database (`ok`).
 *
 *   - `kind: 'ok'`   — `text` is the rendered narrative; `latencyMs`
 *     is the provider-self-reported wall time (used by
 *     observability and ProviderHealthRegistry).
 *   - `kind: 'error'` — see {@link SummaryProviderError} for the
 *     allowed error codes.
 */
export type SummaryProviderResult =
  | { kind: 'ok'; text: string; latencyMs: number }
  | { kind: 'error'; error: SummaryProviderError };

/**
 * Structured error reported by a provider. The `code` field is a
 * closed enum so the worker / observability layer can branch without
 * pattern-matching free-form strings:
 *
 *   - `'NOT_CONFIGURED'`     — required configuration missing (e.g.
 *     remote-llm without `llm.base_url` / `llm.api_key`). The worker
 *     treats this as "use template" without recording a provider
 *     failure.
 *   - `'PROVIDER_UNAVAILABLE'` — the provider is reachable but
 *     returned an HTTP/transport error. Triggers the degraded state
 *     and is recorded against ProviderHealthRegistry.
 *   - `'PARSE_FAILED'`       — the provider returned a response that
 *     does not match the documented schema. Treated like
 *     `PROVIDER_UNAVAILABLE` on the fallback path.
 *   - `'TIMEOUT'`            — the provider did not respond within
 *     `analysis.summary.remoteLlmTimeoutMs`. Treated like
 *     `PROVIDER_UNAVAILABLE` on the fallback path.
 *
 * `message` is a human-readable string for logs; it is not surfaced
 * directly to MCP tool callers.
 */
export interface SummaryProviderError {
  code: 'NOT_CONFIGURED' | 'PROVIDER_UNAVAILABLE' | 'PARSE_FAILED' | 'TIMEOUT';
  message: string;
}

// ---------------------------------------------------------------------------
// SummaryProvider
// ---------------------------------------------------------------------------

/**
 * The interface every concrete summary provider implements
 * (`TemplateSummaryProvider` in task 7.2, `RemoteLlmSummaryProvider`
 * in task 7.3).
 *
 *   - `kind` — readonly literal so call sites and observability can
 *     branch on the provider identity without `instanceof` checks.
 *     The same literal is recorded on `sessions.summary_provider_kind`
 *     when a summary is committed (see design §6.1).
 *   - `generate` — async because the remote-llm provider does HTTP I/O.
 *     The template provider is synchronous in spirit but still returns
 *     a `Promise` to keep the interface uniform; it never rejects.
 *
 * Provider implementations MUST resolve with `SummaryProviderResult`
 * — they MUST NOT throw to signal a recoverable error (see
 * {@link SummaryProviderResult}).
 */
export interface SummaryProvider {
  readonly kind: 'template' | 'remote-llm';
  generate(input: SummaryProviderInput): Promise<SummaryProviderResult>;
}
