/**
 * RoutineScheduler — manages cron-based scheduling for RoutineDefinitions.
 *
 * ROUT-06: schedule routines with node-cron on start()
 * ROUT-07: no-overlap guard — skip and record if a routine is already running
 *
 * Lifecycle:
 *   1. Call start() once; it reads all enabled definitions from the store
 *      and registers a cron task for each.
 *   2. Call stop() to destroy all tasks (e.g. on app shutdown).
 */

import { randomUUID } from 'node:crypto';
import * as nodeCron from 'node-cron';
import type { Logger } from '../../types/app-config.js';
import type { RoutineExecutor } from './executor.js';
import type { RoutineRunRecord, RoutineStore } from './types.js';

// ---------------------------------------------------------------------------
// RoutineScheduler
// ---------------------------------------------------------------------------

export class RoutineScheduler {
  /** Cron tasks keyed by routine name. */
  private readonly tasks = new Map<string, nodeCron.ScheduledTask>();

  /** Names of routines that are currently mid-execution. */
  private readonly running = new Set<string>();

  constructor(
    private readonly deps: {
      routineStore: RoutineStore;
      executor: RoutineExecutor;
      logger: Logger;
    }
  ) {}

  /**
   * Read all enabled definitions from the store and register a cron task for
   * each one. Tasks fire according to the definition's cron expression; if the
   * routine is already running when the cron fires, execution is skipped and a
   * 'skipped' run record is appended to the store.
   *
   * Definitions with invalid cron expressions are skipped with a warning.
   */
  async start(): Promise<void> {
    const definitions = await this.deps.routineStore.listDefinitions();
    const enabled = definitions.filter((d) => d.enabled);

    this.deps.logger.info('RoutineScheduler starting', { count: enabled.length });

    for (const definition of enabled) {
      if (!nodeCron.validate(definition.schedule)) {
        this.deps.logger.warn('Routine has invalid cron expression; skipping', {
          name: definition.name,
          schedule: definition.schedule
        });
        continue;
      }

      const task = nodeCron.schedule(definition.schedule, () => {
        void this.fireRoutine(definition.name);
      });

      this.tasks.set(definition.name, task);
      this.deps.logger.info('Routine scheduled', {
        name: definition.name,
        schedule: definition.schedule
      });
    }
  }

  /**
   * Destroy all registered cron tasks. Safe to call multiple times.
   */
  stop(): void {
    this.deps.logger.info('RoutineScheduler stopping', { count: this.tasks.size });
    for (const [name, task] of this.tasks) {
      task.destroy();
      this.deps.logger.debug('Routine cron task destroyed', { name });
    }
    this.tasks.clear();
  }

  /**
   * Re-reads all enabled definitions from the store and reconciles the
   * live task map:
   *   - new / re-enabled routines get a new cron task registered;
   *   - routines with an updated cron expression get their old task
   *     destroyed and a new one created;
   *   - routines that were removed or disabled get their task destroyed.
   *
   * Called after `routine-create` mutates a definition so the scheduler
   * picks up the change without a full server restart.
   */
  async refresh(): Promise<void> {
    const definitions = await this.deps.routineStore.listDefinitions();
    const enabledByName = new Map(
      definitions.filter((d) => d.enabled).map((d) => [d.name, d])
    );

    // Remove tasks for routines that are no longer enabled or defined.
    for (const [name, task] of this.tasks) {
      if (!enabledByName.has(name)) {
        task.destroy();
        this.tasks.delete(name);
        this.deps.logger.info('Routine task removed after refresh', { name });
      }
    }

    // Add or update tasks for enabled routines.
    for (const [name, definition] of enabledByName) {
      if (!nodeCron.validate(definition.schedule)) {
        this.deps.logger.warn('Routine has invalid cron expression; skipping', {
          name,
          schedule: definition.schedule
        });
        continue;
      }

      const existing = this.tasks.get(name);
      if (existing) {
        // Destroy and re-register if the expression might have changed
        // (simplest way to reconcile without storing the old expression).
        existing.destroy();
        this.tasks.delete(name);
      }

      const task = nodeCron.schedule(definition.schedule, () => {
        void this.fireRoutine(definition.name);
      });

      this.tasks.set(name, task);
      this.deps.logger.info('Routine task registered after refresh', {
        name,
        schedule: definition.schedule
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fireRoutine(name: string): Promise<void> {
    const startedAt = new Date().toISOString();
    const runId = randomUUID();

    // No-overlap guard (ROUT-07).
    if (this.running.has(name)) {
      this.deps.logger.info('Routine already running; skipping this tick', { name, runId });
      await this.appendRun({
        runId,
        name,
        startedAt,
        completedAt: new Date().toISOString(),
        status: 'skipped',
        summary: 'Skipped: previous run still in progress',
        output: ''
      });
      return;
    }

    this.running.add(name);

    try {
      // Re-read the definition in case it was updated since start().
      const definition = await this.deps.routineStore.readDefinition(name);
      if (!definition) {
        this.deps.logger.warn('Routine definition not found; removing task', { name });
        this.tasks.get(name)?.destroy();
        this.tasks.delete(name);
        return;
      }

      if (!definition.enabled) {
        this.deps.logger.info('Routine was disabled; skipping this tick', { name });
        await this.appendRun({
          runId,
          name,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 'skipped',
          summary: 'Skipped: routine is disabled',
          output: ''
        });
        return;
      }

      this.deps.logger.info('Routine execution started', { name, runId });

      const result = await this.deps.executor.execute(definition);

      const completedAt = new Date().toISOString();
      this.deps.logger.info('Routine execution completed', { name, runId });

      await this.appendRun({
        runId,
        name,
        startedAt,
        completedAt,
        status: 'success',
        summary: result.summary,
        output: result.output
      });
    } catch (error) {
      const completedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);

      this.deps.logger.error('Routine execution failed', { name, runId, message });

      await this.appendRun({
        runId,
        name,
        startedAt,
        completedAt,
        status: 'failed',
        summary: `Error: ${message}`,
        output: '',
        error: { message }
      });
    } finally {
      this.running.delete(name);
    }
  }

  private async appendRun(record: RoutineRunRecord): Promise<void> {
    try {
      await this.deps.routineStore.appendRun(record);
    } catch (error) {
      this.deps.logger.error('Failed to persist routine run record', {
        name: record.name,
        runId: record.runId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
