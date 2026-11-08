/**
 * workers/extraction.scheduler.ts
 * -------------------------------
 * Periodic driver for the durable memory-extraction outbox (Milestone 4.1).
 *
 * The API server only ENQUEUES jobs; this scheduler runs in the background
 * worker process and drains them. It is deliberately small and defensive:
 *
 * - Atomic claiming stays in SQL (`claim_memory_extraction_jobs`, FOR UPDATE
 *   SKIP LOCKED), so multiple worker replicas can run concurrently without
 *   processing the same job twice.
 * - Duplicate creation is additionally prevented by the conflict/dedupe path
 *   in `createMemory` (and the 0007 unique index).
 * - Bounded retries + failure tracking live in `claimAndProcess`
 *   (MAX_ATTEMPTS, `failed` + `error_message`).
 * - Stale claims from a crashed worker are recovered on every tick.
 * - A tick never overlaps itself; errors are logged and the loop continues.
 * - `stop()` clears the timer and awaits any in-flight tick for graceful
 *   shutdown.
 *
 * Extraction is a background concern: nothing here can fail a chat request.
 */

import {
  claimAndProcess,
  recoverStaleClaims,
} from './extraction.worker.js';

export interface ExtractionSchedulerLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface ExtractionSchedulerOptions {
  /** Service-role client — required to claim jobs across all users. */
  client: any;
  /** How often to poll, in milliseconds. Default 10s. */
  intervalMs?: number;
  /** Age after which a `claimed` job is considered orphaned. Default 300s. */
  staleSeconds?: number;
  /** Start draining immediately on creation. Default true. */
  runOnStart?: boolean;
  logger?: ExtractionSchedulerLogger;
  /** Injectable for tests. */
  processJobs?: (client: any) => Promise<{ processed: number; failed: number }>;
  /** Injectable for tests. */
  recover?: (client: any, staleSeconds: number) => Promise<number>;
}

export interface ExtractionTickStats {
  recovered: number;
  processed: number;
  failed: number;
}

export interface ExtractionSchedulerHandle {
  /** Run one tick immediately (also used by tests). */
  tick: () => Promise<ExtractionTickStats>;
  /** Stop scheduling and wait for the in-flight tick to settle. */
  stop: () => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_STALE_SECONDS = 300;

const defaultLogger: ExtractionSchedulerLogger = {
  info: (...args) => console.log('[extraction.scheduler]', ...args),
  warn: (...args) => console.warn('[extraction.scheduler]', ...args),
  error: (...args) => console.error('[extraction.scheduler]', ...args),
};

export function startExtractionScheduler(
  options: ExtractionSchedulerOptions,
): ExtractionSchedulerHandle {
  const {
    client,
    intervalMs = DEFAULT_INTERVAL_MS,
    staleSeconds = DEFAULT_STALE_SECONDS,
    runOnStart = true,
    logger = defaultLogger,
    processJobs = claimAndProcess,
    recover = recoverStaleClaims,
  } = options;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<ExtractionTickStats> | null = null;

  const runTick = async (): Promise<ExtractionTickStats> => {
    let recovered = 0;
    let processed = 0;
    let failed = 0;

    try {
      recovered = await recover(client, staleSeconds);
    } catch (err) {
      logger.error('stale-claim recovery failed:', err instanceof Error ? err.message : err);
    }

    try {
      const stats = await processJobs(client);
      processed = stats.processed;
      failed = stats.failed;
    } catch (err) {
      // A thrown storage/update error must not kill the scheduler.
      logger.error('job processing failed:', err instanceof Error ? err.message : err);
    }

    if (recovered > 0 || processed > 0 || failed > 0) {
      logger.info(
        `tick complete — recovered=${recovered} processed=${processed} failed=${failed}`,
      );
    }

    return { recovered, processed, failed };
  };

  const tick = (): Promise<ExtractionTickStats> => {
    if (inFlight) return inFlight;
    inFlight = runTick().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(scheduleNext);
    }, intervalMs);
    // Never keep the Node process alive solely for this timer in tests.
    timer.unref?.();
  };

  // Drain whatever is already queued, then poll.
  if (runOnStart) {
    void tick().finally(scheduleNext);
  } else {
    scheduleNext();
  }

  return {
    tick,
    stop: async (): Promise<void> => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
    },
  };
}
