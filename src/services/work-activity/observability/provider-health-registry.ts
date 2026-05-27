/**
 * `ProviderHealthRegistry` — process-singleton health/latency snapshot
 * for the embedding and summary providers (work-activity-analysis
 * task 7.4, design §9.3).
 *
 * The registry is a small, mutation-friendly object the rest of the
 * pipeline writes to whenever it makes a provider call:
 *
 *   - The embedding pipeline (`Embedding_Service` / its callers) calls
 *     {@link ProviderHealthRegistry.recordOk} on a successful
 *     `provider.embed`, or {@link ProviderHealthRegistry.recordFailure}
 *     on a thrown / `provider-unavailable` outcome.
 *   - The summary pipeline (`SummaryWorker`) calls the same two methods
 *     against the `'summary'` slot whenever the *configured* remote-llm
 *     provider is invoked. Calls to the local `template` provider are
 *     **not** recorded — the template is dependency-free and always
 *     available, so observability has nothing useful to surface.
 *
 * `internal-status.providers.embedding` / `internal-status.providers.summary`
 * (R8.2 / R8.3, design §9.1) reads the entries verbatim and surfaces
 * them as the `status` / `lastErrorAt` / `lastLatencyMs` fields visible
 * to MCP clients. The W24 property (zero-call → `'unknown'`) is the
 * reason the default state is `{ status: 'unknown' }` rather than an
 * `'ok'` placeholder.
 *
 * Lifecycle: a single instance is constructed at app bootstrap (next
 * to the embedding provider and the summary registry) and shared across
 * the indexing pipeline, the summary worker, and the observability
 * service. The class holds in-memory state only — there is no
 * persistence — so a process restart resets every entry to `'unknown'`,
 * which is the documented behaviour (R8.2 says the field is allowed to
 * report `'unknown'` until a call has happened).
 *
 * The `now` injection point lets tests pin `lastSuccessAt` /
 * `lastErrorAt` to deterministic timestamps; production wires
 * `() => new Date()`.
 *
 * **Validates: Requirements 8.2, 8.3**
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Targets the registry tracks. The two slots are kept as plain field
 * names rather than a `Map` because the surface is fixed at compile
 * time — the type checker will catch a typo where a `Map.get('embeding')`
 * call would silently return `undefined`.
 */
export type ProviderHealthTarget = 'embedding' | 'summary';

/**
 * Snapshot of a single provider slot. Mirrors the shape design §9.1
 * surfaces through `internal-status` modulo field naming —
 * `lastErrorAt` / `lastLatencyMs` are emitted on the wire under the
 * same names; `lastSuccessAt` and `lastError` are internal extras
 * used by the observability layer to build a more diagnostic
 * narrativeText if needed.
 *
 *   - `status: 'ok'`          — most recent call succeeded.
 *   - `status: 'unavailable'` — most recent call failed (network /
 *     transport error, non-2xx, parse failure, abort).
 *   - `status: 'unknown'`     — no call has been recorded since
 *     process startup (the fresh-bootstrap case).
 *
 * All other fields are optional so the type narrows cleanly between
 * states without forcing callers to populate placeholder values.
 */
export interface ProviderHealthEntry {
  status: 'ok' | 'unavailable' | 'unknown';
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  lastLatencyMs?: number;
}

/**
 * Construction-time options. `now` is injectable for deterministic
 * tests; production callers pass nothing and the registry uses a
 * fresh `new Date()` per record.
 */
export interface ProviderHealthRegistryOptions {
  /**
   * Wall-clock provider used to stamp `lastSuccessAt` / `lastErrorAt`
   * on the entry. Tests inject a fixed clock; production wires the
   * default below.
   */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Tracks the most recent outcome of every provider call. Constructor
 * options are optional so the simplest call site —
 * `new ProviderHealthRegistry()` — works as a drop-in for the
 * observability wiring.
 */
export class ProviderHealthRegistry {
  /**
   * Snapshot of the embedding provider's last invocation. Mutated
   * directly by callers via {@link recordOk} / {@link recordFailure};
   * the field is public so the observability service can read it
   * without an accessor wrapper that would just thread the same
   * object through.
   */
  embedding: ProviderHealthEntry = { status: 'unknown' };

  /**
   * Snapshot of the summary provider's last invocation. The
   * `SummaryWorker` only records into this slot for `remote-llm`
   * calls — the deterministic template provider is always available
   * so observability has nothing to track on it.
   */
  summary: ProviderHealthEntry = { status: 'unknown' };

  private readonly now: () => Date;

  constructor(options: ProviderHealthRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Record a successful call for the given target. Replaces the slot
   * entirely (no merging with the previous failure state) — design
   * §9.3 specifies that `status` reflects the **most recent** call,
   * not a rolling history. Latency is what the provider measured and
   * passed back via `SummaryProviderResult.latencyMs` /
   * `EmbeddingService` outcome.
   */
  recordOk(target: ProviderHealthTarget, latencyMs: number): void {
    this[target] = {
      status: 'ok',
      lastSuccessAt: this.now().toISOString(),
      lastLatencyMs: latencyMs
    };
  }

  /**
   * Record a failed call for the given target. The error string is
   * surfaced internally (logs, internal narrativeText) but is not
   * returned on the wire — `internal-status` only exposes the
   * timestamp and the closed-enum status. We still keep the message
   * here so observability code can build a richer downstream story
   * without re-calling the provider.
   */
  recordFailure(target: ProviderHealthTarget, error: string): void {
    this[target] = {
      status: 'unavailable',
      lastErrorAt: this.now().toISOString(),
      lastError: error
    };
  }
}
