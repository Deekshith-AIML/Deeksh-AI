/**
 * scheduler/reminder.worker.ts
 * ----------------------------
 * Persistent background scheduler for due reminders (Milestone 2).
 *
 * ARCHITECTURE
 * - The worker runs in its OWN process (src/worker.ts), not inside an
 *   Express request, and is NOT driven by an in-memory timer alone: all
 *   scheduling state (due time, attempts, next_attempt_at, claims) lives
 *   in PostgreSQL, so a crash/restart loses nothing — on restart the
 *   recovery + claim queries simply pick the work back up.
 * - Every tick performs, in order:
 *     1. recover_stale_reminders() — claims stuck by a dead worker are
 *        returned to `pending` (or failed when attempts are exhausted).
 *     2. claim_due_reminders()     — ONE SQL statement using
 *        SELECT ... FOR UPDATE SKIP LOCKED, so concurrent workers can
 *        never claim the same row → no duplicate notifications.
 *     3. For each claimed row: send the email through the provider
 *        abstraction, then persist the TRUE outcome:
 *          success → status 'sent' + sent_at
 *          transient failure → back to 'pending' with bounded
 *                     exponential backoff (next_attempt_at)
 *          attempts exhausted / permanent failure → status 'failed'
 *        The final update is guarded by `.eq('status', 'claimed')` so a
 *        row recovered/re-claimed by another worker is never double-written.
 * - Delivery is only ever marked 'sent' AFTER the provider resolves
 *   successfully — a 2xx from our own API is never treated as delivery.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { EmailProvider, EmailMessage } from '../services/email/types.js';
import { EmailProviderError } from '../services/email/types.js';
import { formatInIst } from '../services/date.service.js';

// ---------------------------------------------------------------------------
// Configuration & types
// ---------------------------------------------------------------------------

/** Reminder row shape returned by `claim_due_reminders()` (JSONB + email). */
export interface ClaimedReminder {
  id: string;
  user_id: string;
  task_id: string | null;
  title: string;
  reminder_at: string;
  status: string;
  attempts: number;
  max_attempts: number;
  recipient_email: string | null;
}

export interface SchedulerDeps {
  /** Privileged (service-role) client — the ONLY place RLS is bypassed, by design. */
  client: SupabaseClient;
  /** Provider abstraction (Resend in prod, mock in tests). */
  email: EmailProvider;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Max reminders claimed per tick (1..100, enforced by the SQL function). */
  batchSize?: number;
  /** Seconds after which a `claimed` row is considered orphaned. */
  staleSeconds?: number;
  /** Exponential backoff base (first retry delay). */
  baseBackoffMs?: number;
  /** Backoff ceiling (bounded exponential). */
  maxBackoffMs?: number;
  logger?: SchedulerLogger;
}

/** Minimal logging surface used by the scheduler. */
export interface SchedulerLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface TickStats {
  /** Stale claims recovered this tick. */
  recovered: number;
  /** Reminders claimed this tick. */
  claimed: number;
  /** Provider-confirmed deliveries. */
  sent: number;
  /** Transient failures rescheduled with backoff. */
  retried: number;
  /** Permanent/exhausted failures marked `failed`. */
  failed: number;
}

/** Default scheduler cadence: one scan per minute. */
export const DEFAULT_INTERVAL_MS = 60_000;

const defaultLogger: SchedulerLogger = {
  info: (...args) => console.log('[scheduler]', ...args),
  warn: (...args) => console.warn('[scheduler]', ...args),
  error: (...args) => console.error('[scheduler]', ...args),
};

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/**
 * Bounded exponential backoff: base * 2^(attempts-1), capped at maxMs.
 * attempts=1 → base, 2 → 2×base, 3 → 4×base, … never beyond maxMs.
 */
export function computeBackoffMs(
  attempts: number,
  baseMs = 60_000,
  maxMs = 3_600_000,
): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

// ---------------------------------------------------------------------------
// Email content
// ---------------------------------------------------------------------------

/** Escape user-controlled text before it goes into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Build the reminder email (subject/text/html) for a claimed row. */
export function buildReminderEmail(
  row: ClaimedReminder,
  appBaseUrl: string,
): EmailMessage {
  const when = formatInIst(new Date(row.reminder_at));
  const safeTitle = escapeHtml(row.title);
  const link = escapeHtml(appBaseUrl);

  return {
    // Recipient comes from authenticated user data (public.users.email),
    // joined by the claim function — never from user-supplied input.
    to: row.recipient_email ?? '',
    subject: `Reminder: ${row.title}`,
    text: [
      `Hi,`,
      ``,
      `This is a reminder: ${row.title}`,
      `Scheduled for: ${when}`,
      ``,
      `Open TaskMate: ${appBaseUrl}`,
      ``,
      `— TaskMate`,
    ].join('\n'),
    html: [
      `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">`,
      `<h2 style="color:#0f172a;">Reminder</h2>`,
      `<p style="font-size:16px;color:#334155;"><strong>${safeTitle}</strong></p>`,
      `<p style="font-size:14px;color:#64748b;">Scheduled for: ${escapeHtml(when)}</p>`,
      `<p style="margin-top:24px;"><a href="${link}" style="background:#0f172a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block;">Open TaskMate</a></p>`,
      `<p style="font-size:12px;color:#94a3b8;margin-top:24px;">— TaskMate</p>`,
      `</div>`,
    ].join(''),
  };
}

// ---------------------------------------------------------------------------
// One scheduler tick
// ---------------------------------------------------------------------------

/**
 * Run a single recover → claim → deliver cycle.
 * Throws on infrastructure failure (claim RPC / DB unreachable) so the
 * caller can log it; per-reminder failures are handled internally and
 * reflected in the returned stats.
 */
export async function runTick(deps: SchedulerDeps): Promise<TickStats> {
  const {
    client,
    email,
    batchSize = 25,
    staleSeconds = 300,
    baseBackoffMs = 60_000,
    maxBackoffMs = 3_600_000,
    logger = defaultLogger,
  } = deps;

  const stats: TickStats = { recovered: 0, claimed: 0, sent: 0, retried: 0, failed: 0 };

  // 1. Crash recovery: orphaned claims → pending (or failed if exhausted).
  const recovered = await client.rpc('recover_stale_reminders', {
    p_stale_seconds: staleSeconds,
  });
  if (recovered.error) {
    throw new Error(`recover_stale_reminders failed: ${recovered.error.message}`);
  }
  stats.recovered = Number(recovered.data ?? 0);

  // 2. Atomic claim (FOR UPDATE SKIP LOCKED) — safe across workers.
  const claimed = await client.rpc('claim_due_reminders', { p_limit: batchSize });
  if (claimed.error) {
    throw new Error(`claim_due_reminders failed: ${claimed.error.message}`);
  }
  const rows = (claimed.data ?? []) as ClaimedReminder[];
  stats.claimed = rows.length;

  // 3. Deliver each claimed reminder and persist the TRUE outcome.
  for (const row of rows) {
    if (!row.recipient_email) {
      // No authenticated recipient on file → permanent failure; we must
      // NOT invent an address or claim delivery.
      await markFailed(client, row, 'No recipient email address on file.');
      stats.failed += 1;
      logger.warn(`reminder ${row.id}: no recipient email — marked failed`);
      continue;
    }

    const message = buildReminderEmail(row, process.env.APP_BASE_URL ?? 'http://localhost:3000');

    try {
      const result = await email.send(message);
      // Mark sent ONLY after the provider confirmed acceptance.
      const updated = await client
        .from('reminders')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          claimed_at: null,
          failure_reason: null,
        })
        .eq('id', row.id)
        .eq('status', 'claimed') // guard: never overwrite a re-claimed row
        .select('id');

      if ((updated.data?.length ?? 0) === 0) {
        logger.warn(`reminder ${row.id}: send succeeded but claim guard matched no row`);
      } else {
        stats.sent += 1;
        // Delivery event log — id/status only, no PII, no credentials.
        logger.info(`reminder ${row.id}: sent via ${email.name} (provider id ${result.id})`);
      }
    } catch (err) {
      const transient =
        err instanceof EmailProviderError ? err.transient : true; // unknown → retry
      const reason =
        err instanceof Error ? err.message : 'Unknown provider failure';

      if (!transient || row.attempts >= row.max_attempts) {
        await markFailed(
          client,
          row,
          row.attempts >= row.max_attempts
            ? `Delivery failed after ${row.attempts} attempt(s): ${reason}`
            : `Permanent delivery failure: ${reason}`,
        );
        stats.failed += 1;
        logger.error(`reminder ${row.id}: failed permanently (${reason})`);
      } else {
        const delay = computeBackoffMs(row.attempts, baseBackoffMs, maxBackoffMs);
        const nextAttemptAt = new Date((deps.now?.() ?? new Date()).getTime() + delay);
        const updated = await client
          .from('reminders')
          .update({
            status: 'pending',
            claimed_at: null,
            next_attempt_at: nextAttemptAt.toISOString(),
            failure_reason: reason,
          })
          .eq('id', row.id)
          .eq('status', 'claimed')
          .select('id');

        if ((updated.data?.length ?? 0) === 0) {
          logger.warn(`reminder ${row.id}: retry requeue lost the claim guard`);
        } else {
          stats.retried += 1;
          logger.warn(
            `reminder ${row.id}: transient failure, retry ${row.attempts}/${row.max_attempts} at ${nextAttemptAt.toISOString()}`,
          );
        }
      }
    }
  }

  return stats;
}

/** Mark a claimed reminder as permanently failed (guarded by status). */
async function markFailed(
  client: SupabaseClient,
  row: ClaimedReminder,
  reason: string,
): Promise<void> {
  await client
    .from('reminders')
    .update({
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_reason: reason,
      claimed_at: null,
    })
    .eq('id', row.id)
    .eq('status', 'claimed')
    .select('id');
}

// ---------------------------------------------------------------------------
// Scheduler loop + graceful shutdown
// ---------------------------------------------------------------------------

export interface SchedulerHandle {
  /** Stop ticking and wait for any in-flight tick to finish. */
  stop(): Promise<void>;
}

/**
 * Start the minute-interval scheduler loop.
 *
 * - First tick runs immediately (a freshly started worker catches up on
 *   anything that came due while it was down).
 * - Overlapping ticks are prevented (a slow tick skips the next one) so
 *   two ticks of the SAME process never race; cross-process safety comes
 *   from the SQL SKIP LOCKED claim.
 * - `stop()` clears the timer and awaits the in-flight tick — used for
 *   graceful SIGTERM/SIGINT shutdown.
 */
export function startScheduler(
  deps: SchedulerDeps & { intervalMs?: number },
): SchedulerHandle {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const logger = deps.logger ?? defaultLogger;

  let stopped = false;
  let ticking = false;
  let inFlight: Promise<void> = Promise.resolve();

  const tickOnce = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const stats = await runTick(deps);
      if (stats.claimed > 0 || stats.recovered > 0) {
        logger.info(
          `tick: recovered=${stats.recovered} claimed=${stats.claimed} sent=${stats.sent} retried=${stats.retried} failed=${stats.failed}`,
        );
      }
    } catch (err) {
      // Infra failure (DB unreachable, RPC missing): log and try again
      // next interval — the scheduler must not die on a transient outage.
      logger.error('tick failed:', err instanceof Error ? err.message : err);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => {
    inFlight = tickOnce();
  }, intervalMs);
  // Never keep the process alive just for the timer (graceful exit paths).
  timer.unref?.();

  // Immediate catch-up tick on startup.
  inFlight = tickOnce();

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
