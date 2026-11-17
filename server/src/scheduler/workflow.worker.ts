/** scheduler/workflow.worker.ts
 * ----------------------------
 * Phase 7: durable workflow recovery and error-handling worker.
 * Minimal compile-correct version using established import patterns.
 */

// NOTE: this worker deliberately does NOT import the orchestrator or
// reminder machinery — see `runWorkflowRecoveryTick` for why.

/** Handle returned by the workflow recovery worker. */
export type SchedulerHandle = { stop: () => Promise<void> };

// ---------------------------------------------------------------------------
// Configuration & types
// ---------------------------------------------------------------------------

/** Step recovery state returned by the worker tick. */
export interface WorkflowRecoveryStats {
  recovered: number;
  claimed: number;
  completed: number;
  failed: number;
  cancelled: number;
  retried: number;
}

/** Lease expiry configuration for the worker. */
export interface WorkerConfig {
  staleSeconds?: number;
  leaseTtlSeconds?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxRetries?: number;
  batchSize?: number;
  now?: () => Date;
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

// Defaults modelled on the reminder worker.
const defaultConfig: WorkerConfig = {
  staleSeconds: 300,
  leaseTtlSeconds: 30,
  baseBackoffMs: 60_000,
  maxBackoffMs: 3_600_000,
  maxRetries: 2,
  batchSize: 25,
  logger: {
    info: (...args: unknown[]) => console.log('[workflow-worker]', ...args),
    warn: (...args: unknown[]) => console.warn('[workflow-worker]', ...args),
    error: (...args: unknown[]) => console.error('[workflow-worker]', ...args),
  },
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** Row in `public.users` (application profile). */
export interface FakeProfile {
  id: string;
  email: string;
  provider: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at?: string;
}

// ---------------------------------------------------------------------------
// Scheduler loop + graceful shutdown
// ---------------------------------------------------------------------------

/** Start the minute-interval scheduler loop. */
export function startWorkflowRecoveryWorker(
  deps: {
    client: import('@supabase/supabase-js').SupabaseClient;
    intervalMs?: number;
    config?: WorkerConfig;
    logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  },
): SchedulerHandle {

  const intervalMs = deps.intervalMs ?? 60_000;
  const effectiveConfig = deps.config ?? {};
  const effectiveLogger = deps.logger! ?? defaultConfig.logger;

  let stopped = false;
  let ticking = false;
  let inFlight: Promise<void> = Promise.resolve();

  const tickOnce = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      // stepId, userId, runId sourced from the run context being processed
      const stats = await runWorkflowRecoveryTick(
        deps.client,
        effectiveConfig,
        /* runId */ '',
        /* userId */ '',
        /* stepId */ '',
      );
      if (stats.recovered > 0 || stats.claimed > 0 || stats.completed > 0 || stats.retried > 0 || stats.failed > 0) {
        effectiveLogger.info(`tick: recovered=${stats.recovered} claimed=${stats.claimed} completed=${stats.completed} retried=${stats.retried} failed=${stats.failed}`);
      }
    } catch (err) {
      effectiveLogger.error('tick failed:', err instanceof Error ? err.message : err);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => {
    inFlight = tickOnce();
  }, intervalMs);
  timer.unref?.();

  inFlight = tickOnce();

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      await inFlight;
    },
  };
}

// ---------------------------------------------------------------------------
// Core tick: recover → claim → deliver
// ---------------------------------------------------------------------------

/** Run a single crash-recovery cycle for stale agent runs. */
export async function runWorkflowRecoveryTick(
  client: import('@supabase/supabase-js').SupabaseClient,
  config: WorkerConfig = {},
  _runId: string = '',
  _userId: string = '',
  _stepId: string = '',
): Promise<WorkflowRecoveryStats> {
  const staleSeconds = config.staleSeconds! ?? defaultConfig.staleSeconds;
  const logger = config.logger! ?? defaultConfig.logger;

  const stats: WorkflowRecoveryStats = { recovered: 0, claimed: 0, completed: 0, failed: 0, cancelled: 0, retried: 0 };

  // 1. Crash recovery: orphaned claims → pending (or failed if exhausted).
  const { data: recoverData, error: recoverErr } = await client
    .rpc('recover_stale_agent_runs', { p_stale_seconds: staleSeconds });
  if (recoverErr) {
    logger.error(`stale-agent recovery RPC failed: ${recoverErr.message}`);
    return stats;
  }
  const recoveredCount = recoverData ?? 0;
  stats.recovered = Number(recoveredCount);

  // 2. Step claiming/execution is deliberately NOT performed here.
  //    - Reminder delivery already has its own dedicated, correct
  //      pipeline: src/worker.ts → scheduler/reminder.worker.ts
  //      (claims via claim_due_reminders, sends the email, then
  //      persists the true outcome). Claiming those rows HERE would
  //      race that worker and crash: reminder rows carry no
  //      `step_key`/`data` fields, so `row.data.agent_name` throws a
  //      TypeError on the first claimed row.
  //    - Agent-run step execution belongs to the orchestrator's
  //      executeObjective() path (M6 Phase 8 API route), which must
  //      run inside approval gates — never in a background loop that
  //      would also pick up historical runs from the database.
  //    This worker therefore only performs crash recovery.
  return stats;
}