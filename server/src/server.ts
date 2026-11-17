/**
 * server.ts
 * ---------
 * Process entry point: load environment variables, import the assembled
 * Express app (app.ts), and start listening.
 *
 * All application wiring (CORS, routes, auth, error handling) lives in
 * app.ts so the test suite can import the same app without opening a port.
 *
 * Phase 7.1: Workflow recovery worker — started once per process, runs in
 * its own tick loop with database-level coordination (FOR UPDATE SKIP LOCKED).
 * Graceful SIGINT/SIGTERM shutdown is supported.
 */

import 'dotenv/config';
import app from './app.js';
import { startWorkflowRecoveryWorker, type SchedulerHandle } from './scheduler/workflow.worker.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const PORT = Number(process.env.PORT ?? 3001);

// ── Workflow recovery worker ──────────────────────────────────────────────
// Starts a minute-interval recovery tick loop that claims stale leases,
// recovers abandoned steps, and persist outcomes.  Runs in the same process
// as the Express server; cross-process safety is via SQL FOR UPDATE SKIP LOCKED.
// -----------------------------------------------------------------------
let workflowWorker: SchedulerHandle | null = null;

const enableWorkflowWorker = () => {
  // Do not start the workflow recovery worker in test environments.
  // Tests use a mock Supabase client and should not trigger real worker ticks.
  if (process.env.NODE_ENV === 'test') return;

  // Use the service-role key so the RPC recover_stale_agent_runs
  // (SECURITY DEFINER) is executable — the request-handling code path
  // never uses this key; it is only for background workers and admin scripts.
  const serviceSupabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  ) as SupabaseClient;

  workflowWorker = startWorkflowRecoveryWorker({
    client: serviceSupabase,
    intervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 60_000),
    config: {
      staleSeconds: Number(process.env.STALE_SECONDS ?? 300),
      leaseTtlSeconds: Number(process.env.LEASE_TTL_SECONDS ?? 30),
      baseBackoffMs: Number(process.env.BACKOFF_BASE_MS ?? 60_000),
      maxBackoffMs: Number(process.env.BACKOFF_MAX_MS ?? 3_600_000),
      maxRetries: Number(process.env.MAX_RETRIES ?? 2),
      batchSize: Number(process.env.WORKER_BATCH_SIZE ?? 25),
      logger: {
        info: (...args: unknown[]) => console.log('[workflow-worker] INFO:', ...args),
        warn: (...args: unknown[]) => console.warn('[workflow-worker] WARN:', ...args),
        error: (...args: unknown[]) => console.error('[workflow-worker] ERROR:', ...args),
      },
    },
  });
};

// Start the worker once the Express app is listening.
// If the process receives SIGINT or SIGTERM, the worker stops gracefully.
const server = app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
  enableWorkflowWorker();
});

let closeResolve: (() => void) | null = null;
const closePromise = new Promise<void>(resolve => {
  closeResolve = resolve;
});

server.on('close', () => {
  // The HTTP server has been stopped; clean up the worker if running.
  if (workflowWorker) {
    void workflowWorker.stop();
  }
});

process.on('SIGINT', async () => {
  if (workflowWorker) {
    console.log('🛑 Shutting down workflow recovery worker…');
    await workflowWorker.stop();
  }
  closeResolve?.();
});

process.on('SIGTERM', async () => {
  if (workflowWorker) {
    console.log('🛑 Shutting down workflow recovery worker…');
    await workflowWorker.stop();
  }
  closeResolve?.();
});