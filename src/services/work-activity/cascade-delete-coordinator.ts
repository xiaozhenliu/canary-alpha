/**
 * Cascade_Delete coordinator (work-activity-analysis task 10.1).
 *
 * Bridges the upstream privacy mechanisms (`accessibility-capture-ingestion`
 * retention pass + `delete-range`) with the derived layer introduced by
 * this spec: when ScreenPipe drops frames, the matching `sessions` rows,
 * `extracted_content` rows, and vector-store records MUST disappear with
 * them so the user does not surface deleted content from the derived
 * layer (R9.1 — Cascade_Delete; R9.2 — No re-sessionize).
 *
 * Design references: design §11 "Cascade_Delete 协调器（R9）".
 *
 * Validates: Requirements 9.1, 9.2
 *   - **Cascade_Completeness (W25)** — for every frame id in the input
 *     set F, no `extracted_content` row, `sessions` row, or vector-store
 *     record referencing a frame in F survives the call.
 *   - **No_Re_Sessionize (W26)** — sessions whose `evidence_frame_ids`
 *     intersect F are removed in their entirety. The coordinator never
 *     re-aggregates the remaining frames into a partial session.
 */

import type {
  ExtractedContentStore
} from './extraction/extracted-content-store.js';
import type { SessionStore } from './sessions/session-store.js';
import type { VectorStore } from '../retrieval/types.js';
import type { Logger } from '../../types/app-config.js';
import { deleteDerivedByFrameIds, type DerivedDatabase } from './derived-database.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CascadeDeleteResult {
  /** Number of `extracted_content` rows removed. */
  extractedContent: number;
  /** Number of `sessions` rows removed. */
  sessions: number;
  /**
   * Number of vector-store records removed. When the underlying vector
   * store does not implement `deleteByFrameIds` and the coordinator
   * falls back to `reset()`, this counter is 0 because the wipe
   * semantics do not give us a precise count (R9.1 reports as
   * `fallbackUsed === 'vector-store-reset'`).
   */
  embeddings: number;
  /**
   * Indicates whether the vector-store side of the cascade had to fall
   * back to `reset()` because the store lacked a fine-grained delete
   * method. The two production stores (`InMemoryVectorStore`,
   * `FileBackedVectorStore`) both implement `deleteByFrameIds` /
   * `deleteByTimestampRange` (task 2.1), so the fallback only triggers
   * when a future remote vector store is wired in without those
   * methods.
   */
  fallbackUsed: 'none' | 'vector-store-reset';
}

export interface CascadeDeleteCoordinator {
  /**
   * Drop every derived artefact tied to the supplied frame ids. Used by
   * the retention pass after ScreenPipe deletes a batch of frames.
   *
   * Empty input is a no-op (the cascade is invoked from the retention
   * loop after a `WHERE` query that may legitimately return zero rows).
   */
  cascadeByFrameIds(frameIds: ReadonlyArray<number>): Promise<CascadeDeleteResult>;
  /**
   * Drop every derived artefact whose source frame falls in the closed
   * interval `[from, to]`. Used by `delete-range`.
   *
   * Implementation strategy: enumerate the matching frame ids via
   * `extractedContentStore.listByTimeWindow` and reuse
   * `cascadeByFrameIds` so the sessions / extracted_content / vector
   * paths share one code path. The vector store is additionally swept
   * by timestamp to catch records whose metadata is missing
   * `frameId` (R5.3 keeps `frameTimestamp` as a parallel index).
   */
  cascadeByTimestampRange(from: string, to: string): Promise<CascadeDeleteResult>;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface CascadeDeleteCoordinatorDependencies {
  sessionStore: SessionStore;
  extractedContentStore: ExtractedContentStore;
  vectorStore: VectorStore;
  /**
   * Optional derived-database handle used for the transactional
   * delete path (P1-5). When provided, `cascadeByFrameIds` removes
   * `sessions` and `extracted_content` rows inside a single
   * `BEGIN IMMEDIATE` / `COMMIT` so a mid-cascade failure cannot
   * leave the two tables out of sync. The vector store deletion
   * runs only after the SQL transaction commits.
   *
   * When the handle is omitted (legacy test setups), the coordinator
   * falls back to the per-store deletes used before this fix —
   * sessions then extracted_content as separate operations.
   */
  derivedDatabase?: DerivedDatabase;
  /**
   * Optional logger; the coordinator only emits a warning when the
   * vector store lacks `deleteByFrameIds` and the fallback `reset()`
   * is triggered. Production wiring passes the application logger;
   * tests may omit it.
   */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Default `CascadeDeleteCoordinator` used by the retention pass and
 * `delete-range`. The class is intentionally a thin sequencer over the
 * three storage adapters — there is no cross-store transaction (the
 * derived database and vector store are independent storage engines)
 * and the coordinator MUST tolerate partial failure.
 *
 * Delete order — sessions → extracted_content → vectorStore — mirrors
 * design §11.2:
 *
 *   - Removing `sessions` first means an in-flight `recall` cannot
 *     surface an aggregate that points at frames we are about to drop.
 *   - Removing `extracted_content` next collapses the per-frame
 *     evidence table.
 *   - Removing the vector store records last leaves the keyword path
 *     consistent before the semantic path catches up; an interrupted
 *     run leaves orphan vectors that a future "startup reconcile" can
 *     mop up (deferred per design §11.2).
 */
export class DefaultCascadeDeleteCoordinator
  implements CascadeDeleteCoordinator
{
  constructor(private readonly deps: CascadeDeleteCoordinatorDependencies) {}

  async cascadeByFrameIds(
    frameIds: ReadonlyArray<number>
  ): Promise<CascadeDeleteResult> {
    // Empty fast-path: SQLite would refuse `IN ()` and the retention
    // loop calls us after every batch — including batches that
    // returned zero deletable rows. Returning the zero-result here
    // keeps the call-site simple and matches the spirit of the
    // empty-array fast-paths used by the underlying stores.
    if (frameIds.length === 0) {
      return {
        extractedContent: 0,
        sessions: 0,
        embeddings: 0,
        fallbackUsed: 'none'
      };
    }

    const ids = [...frameIds];

    // 1) sessions + extracted_content — when the derived database
    //    handle is wired in, both deletes run inside a single
    //    `BEGIN IMMEDIATE` / `COMMIT` transaction (P1-5). This
    //    prevents the previous failure mode where the second
    //    delete could throw and leave the first one's effect
    //    behind, e.g. dropping `sessions` while leaving orphan
    //    `extracted_content` rows.
    //
    //    When `derivedDatabase` is undefined (legacy test wiring
    //    that constructs the coordinator with only the store
    //    interfaces), fall back to the previous two-call path.
    let sessions: number;
    let extractedContent: number;
    if (this.deps.derivedDatabase !== undefined) {
      const result = deleteDerivedByFrameIds(this.deps.derivedDatabase, ids);
      sessions = result.sessions;
      extractedContent = result.extractedContent;
    } else {
      // Legacy fallback path — kept until the test rigs that
      // construct the coordinator without the database handle are
      // migrated. Maintains the original delete order.
      sessions = await this.deps.sessionStore.deleteSessionsTouchingFrames(ids);
      extractedContent = await this.deps.extractedContentStore.deleteByFrameIds(ids);
    }

    // 2) vector store — runs ONLY after the SQL transaction
    //    committed. Vector backends live outside the SQLite
    //    consistency boundary, so we sequence them after the
    //    derived-table commit succeeds.
    const { embeddings, fallbackUsed } = await this.deleteVectorRecordsByIds(ids);

    return { extractedContent, sessions, embeddings, fallbackUsed };
  }

  async cascadeByTimestampRange(
    from: string,
    to: string
  ): Promise<CascadeDeleteResult> {
    // Strategy (per task 10.1 design comments):
    //
    //   1. Resolve the time window to a concrete `frameId[]` via
    //      `extractedContentStore.listByTimeWindow`. This is the only
    //      authoritative source of frame ids for the derived layer
    //      (sessions store does not index by timestamp, vector store
    //      may not have `frameId` metadata for older records).
    //   2. Reuse `cascadeByFrameIds(frameIds)` so sessions /
    //      extracted_content / vector deletes share one code path.
    //   3. Additionally sweep the vector store by timestamp range to
    //      catch records that lack `metadata.frameId` (R5.3 keeps
    //      `metadata.frameTimestamp` as a fallback index — see
    //      `VectorStore.deleteByTimestampRange`).
    const extractionsInRange =
      await this.deps.extractedContentStore.listByTimeWindow(from, to);
    const frameIds = extractionsInRange.map((e) => e.frameId);

    const result = await this.cascadeByFrameIds(frameIds);

    // The timestamp-range sweep is best-effort: if the store does not
    // expose the method (older deployments, custom test stubs), we
    // skip it. The frame-id pass already covered every record whose
    // metadata carries a recognisable `frameId`, so the worst case is
    // a few orphan vectors with non-`frameId` metadata.
    if (typeof this.deps.vectorStore.deleteByTimestampRange === 'function') {
      const additional = await this.deps.vectorStore.deleteByTimestampRange(
        from,
        to
      );
      result.embeddings += additional;
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async deleteVectorRecordsByIds(
    ids: number[]
  ): Promise<{ embeddings: number; fallbackUsed: 'none' | 'vector-store-reset' }> {
    const { vectorStore, logger } = this.deps;
    if (typeof vectorStore.deleteByFrameIds === 'function') {
      const embeddings = await vectorStore.deleteByFrameIds(ids);
      return { embeddings, fallbackUsed: 'none' };
    }

    // Fallback path: design §11.2 "wipe everything" for vector
    // backends that lack a metadata-aware delete. Counts are 0 because
    // a wipe leaves no precise per-frame attribution.
    logger?.warn(
      'cascade-delete: vectorStore lacks deleteByFrameIds; falling back to reset()'
    );
    await vectorStore.reset();
    return { embeddings: 0, fallbackUsed: 'vector-store-reset' };
  }
}

/**
 * Convenience factory mirroring the pattern used elsewhere in the
 * package (e.g. `createSummaryProviderRegistry`). Keeps the bootstrap
 * wiring readable when more dependencies are added later.
 */
export function createCascadeDeleteCoordinator(
  deps: CascadeDeleteCoordinatorDependencies
): CascadeDeleteCoordinator {
  return new DefaultCascadeDeleteCoordinator(deps);
}
