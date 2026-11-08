/**
 * workers/document.scheduler.ts
 * -----------------------------
 * Periodic driver for the durable document-processing outbox (Milestone 5).
 *
 * The API server only ENQUEUES jobs; this scheduler runs in the background
 * worker process and drains them. It is deliberately small and defensive:
 *
 * - Atomic claiming stays in SQL (`claim_document_processing_jobs`, FOR UPDATE
 *   SKIP LOCKED), so multiple worker replicas can run concurrently without
 *   processing the same job twice.
 * - Bounded retries + failure tracking live in `processDocumentJobs`.
 * - Stale claims from a crashed worker are recovered on every tick.
 * - A tick never overlaps itself; errors are logged and the loop continues.
 * - `stop()` clears the timer and awaits any in-flight tick for graceful
 *   shutdown.
 *
 * Deletion sweeping runs on every tick after processing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getDocumentsConfig } from '../config/documents.config.js';
import { processDocumentJobs, sweepDeletingDocuments } from './document.worker.js';

export interface DocumentSchedulerOptions {
  client: SupabaseClient;
  intervalMs?: number;
  batchSize?: number;
  runOnStart?: boolean;
  logger?: { info?: Function; warn?: Function; error?: Function };
}

export interface DocumentScheduler {
  tick: () => Promise<{ recovered: number; processed: number; failed: number; swept: number }>;
  stop: () => Promise<void>;
}

export function startDocumentScheduler(opts: DocumentSchedulerOptions): DocumentScheduler {
  const config = getDocumentsConfig();
  const intervalMs = opts.intervalMs ?? config.workerIntervalMs;
  const batchSize = opts.batchSize ?? config.workerBatchSize;
  const logger = opts.logger ?? console;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let currentTick: Promise<{ recovered: number; processed: number; failed: number; swept: number }> | null = null;

  async function tick() {
    if (currentTick) return currentTick;

    const run = async () => {
      running = true;
      let recovered = 0;
      let processed = 0;
      let failed = 0;
      let swept = 0;

      try {
        // Recover stale claims.
        const { data: recoveredCount } = await opts.client.rpc('recover_stale_document_jobs', {
          p_stale_seconds: 300,
        });
        recovered = Number(recoveredCount ?? 0);

        // Claim jobs.
        const { data: claimed } = await opts.client.rpc('claim_document_processing_jobs', {
          p_limit: batchSize,
        });

        const jobs = Array.isArray(claimed) ? claimed : [];
        if (jobs.length > 0) {
          const result = await processDocumentJobs({ client: opts.client, logger }, jobs);
          processed = result.processed;
          failed = result.failed;
        }

        // Sweep deletions.
        swept = await sweepDeletingDocuments({ client: opts.client, logger });
      } catch (err) {
        logger.error?.('[document.scheduler] tick failed:', err);
      } finally {
        running = false;
        currentTick = null;
      }

      return { recovered, processed, failed, swept };
    };

    currentTick = run();
    return currentTick;
  }

  if (opts.runOnStart !== false) {
    // Fire-and-forget initial tick.
    tick().catch((err) => logger.error?.('[document.scheduler] initial tick failed:', err));
  }

  timer = setInterval(() => {
    tick().catch((err) => logger.error?.('[document.scheduler] tick failed:', err));
  }, intervalMs);

  return {
    tick,
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (currentTick) {
        await currentTick;
      }
    },
  };
}