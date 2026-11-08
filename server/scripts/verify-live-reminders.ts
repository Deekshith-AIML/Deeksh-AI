/**
 * scripts/verify-live-reminders.ts
 * --------------------------------
 * Milestone 4.2 Task D — isolated LIVE reminder-worker verification.
 *
 * Runs the REAL scheduler tick (`runTick`) against the local PostgREST +
 * PostgreSQL stack with a MOCK email provider (no real email is sent) and
 * real `claim_due_reminders()` / `recover_stale_reminders()` SQL.
 *
 * The scheduler under test uses the SAME `service_role` PostgREST client as
 * production. Fixtures/assertions use a direct `pg` connection (superuser)
 * so the migration stays least-privilege (the worker has no INSERT grant
 * on reminders, because it never inserts them).
 *
 * Covered, in order:
 *   1. claim + send: pending → claimed → sent with sent_at persisted;
 *   2. duplicate prevention: a second tick claims nothing (already sent);
 *   3. transient failure: back to pending, attempts+1, backoff scheduled;
 *   4. attempts exhausted: marked failed with a failure reason;
 *   5. stale-claim recovery on worker restart: orphaned claimed row is
 *      returned to pending and then delivered by the same tick;
 *   6. future reminder not claimable;
 *   7. cancelled reminder not claimable.
 *
 * Reminder ownership/RLS is verified separately by
 * `supabase/local-dev/verify_0007_0008.sql` (rolled-back live SQL).
 *
 * SAFETY: every PRE-EXISTING reminder is temporarily deferred (pending rows
 * pushed out of the due window, claimed rows given a fresh claimed_at) and
 * restored exactly in `finally`. Fixtures are deleted at the end. Local DB
 * only.
 *
 * Env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY,
 *      DATABASE_URL (default local chitti-pg).
 * Not part of `npm test`. Prints no secrets.
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createAdminClient } from '../src/services/supabase.service.js';
import { runTick } from '../src/scheduler/reminder.worker.js';
import { EmailProviderError, type EmailProvider, type EmailMessage } from '../src/services/email/types.js';

const USER_ID = process.env.VERIFY_USER_ID ?? '';
if (!USER_ID) {
  console.error('VERIFY_USER_ID is required.');
  process.exit(2);
}

const LOCAL_DB_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:55432/task_assistant';

const client = createAdminClient();
const pool = new pg.Pool({ connectionString: LOCAL_DB_URL });

const sentMessages: EmailMessage[] = [];
const provider = (name: string, behaviour: 'ok' | 'transient' | 'permanent'): EmailProvider => ({
  name,
  send: async (message) => {
    if (behaviour === 'transient') {
      throw new EmailProviderError('simulated transient provider failure', true, 503);
    }
    if (behaviour === 'permanent') {
      throw new EmailProviderError('simulated permanent provider failure', false, 400);
    }
    sentMessages.push(message);
    return { id: `mock-${randomUUID()}` };
  },
});

const logs: string[] = [];
const logger = {
  info: (...a: unknown[]) => logs.push(`INFO ${a.map(String).join(' ')}`),
  warn: (...a: unknown[]) => logs.push(`WARN ${a.map(String).join(' ')}`),
  error: (...a: unknown[]) => logs.push(`ERROR ${a.map(String).join(' ')}`),
};

async function insertReminder(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  const now = new Date();
  const row = {
    id,
    user_id: USER_ID,
    title: `verify reminder ${id.slice(0, 8)}`,
    reminder_at: now,
    next_attempt_at: now,
    status: 'pending',
    ...overrides,
  };
  const columns = Object.keys(row);
  const values = Object.values(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  await pool.query(
    `INSERT INTO public.reminders (${columns.join(', ')}) VALUES (${placeholders})`,
    values,
  );
  return id;
}

async function getReminder(id: string) {
  const { rows } = await pool.query('SELECT * FROM public.reminders WHERE id = $1', [id]);
  if (!rows[0]) throw new Error(`reminder ${id} missing`);
  return rows[0] as Record<string, unknown>;
}

const results: Record<string, unknown> = {};
const fixtureIds: string[] = [];
const deferred: Array<{
  id: string;
  next_attempt_at: string;
  claimed_at: string | null;
}> = [];

async function main() {
  const deferredIds = await deferPreexisting();
  results.deferredPreexisting = deferredIds;

  // ---- 1. Claim + send ------------------------------------------------
  const okId = await insertReminder();
  fixtureIds.push(okId);
  const tick1 = await runTick({ client, email: provider('verify-mock-ok', 'ok'), logger });
  const okRow = await getReminder(okId);
  results.claimAndSend = {
    tick: tick1,
    status: okRow.status,
    sentAt: okRow.sent_at ?? null,
    attempts: okRow.attempts,
    mockEmailsSent: sentMessages.length,
    recipient: sentMessages[0]?.to ?? null,
  };

  // ---- 2. Duplicate prevention: nothing left to claim -----------------
  const tick2 = await runTick({ client, email: provider('verify-mock-ok', 'ok'), logger });
  results.duplicatePrevention = {
    tick: tick2,
    sentAtUnchanged:
      new Date(String((await getReminder(okId)).sent_at)).getTime() ===
      new Date(String(okRow.sent_at)).getTime(),
  };

  // ---- 3. Transient failure → pending with backoff --------------------
  const transientId = await insertReminder();
  fixtureIds.push(transientId);
  const tick3 = await runTick({ client, email: provider('verify-mock-transient', 'transient'), logger });
  const transientRow = await getReminder(transientId);
  results.transientRetry = {
    tick: tick3,
    status: transientRow.status,
    attempts: transientRow.attempts,
    nextAttemptAt: transientRow.next_attempt_at,
    failureReason: transientRow.failure_reason,
    scheduledInFuture:
      new Date(String(transientRow.next_attempt_at)).getTime() > Date.now(),
  };

  // ---- 4. Attempts exhausted → failed ---------------------------------
  const exhaustedId = await insertReminder({ attempts: 2, max_attempts: 3 });
  fixtureIds.push(exhaustedId);
  const tick4 = await runTick({ client, email: provider('verify-mock-transient', 'transient'), logger });
  const exhaustedRow = await getReminder(exhaustedId);
  results.attemptsExhausted = {
    tick: tick4,
    status: exhaustedRow.status,
    attempts: exhaustedRow.attempts,
    failureReason: exhaustedRow.failure_reason,
    failedAt: exhaustedRow.failed_at ?? null,
  };

  // ---- 5. Stale-claim recovery on restart -----------------------------
  const staleId = await insertReminder({
    status: 'claimed',
    claimed_at: new Date(Date.now() - 10 * 60_000),
    attempts: 1,
  });
  fixtureIds.push(staleId);
  const tick5 = await runTick({ client, email: provider('verify-mock-ok', 'ok'), logger });
  const staleRow = await getReminder(staleId);
  results.staleClaimRecovery = {
    tick: tick5,
    status: staleRow.status,
    attempts: staleRow.attempts,
    sentAt: staleRow.sent_at ?? null,
  };

  // ---- 6. Future reminder not claimable -------------------------------
  const futureId = await insertReminder({
    reminder_at: new Date(Date.now() + 86_400_000),
    next_attempt_at: new Date(Date.now() + 86_400_000),
  });
  fixtureIds.push(futureId);
  // ---- 7. Cancelled reminder not claimable ----------------------------
  const cancelledId = await insertReminder({ status: 'cancelled' });
  fixtureIds.push(cancelledId);
  const tick6 = await runTick({ client, email: provider('verify-mock-ok', 'ok'), logger });
  const futureRow = await getReminder(futureId);
  const cancelledRow = await getReminder(cancelledId);
  results.notClaimable = {
    tick: tick6,
    futureStatus: futureRow.status,
    cancelledStatus: cancelledRow.status,
    futureSentAt: futureRow.sent_at ?? null,
    cancelledSentAt: cancelledRow.sent_at ?? null,
  };
}

async function deferPreexisting(): Promise<string[]> {
  const { rows } = await pool.query(
    'SELECT id, status, next_attempt_at, claimed_at FROM public.reminders',
  );
  for (const row of rows as Array<Record<string, unknown>>) {
    deferred.push({
      id: String(row.id),
      next_attempt_at: new Date(String(row.next_attempt_at)).toISOString(),
      claimed_at: row.claimed_at ? new Date(String(row.claimed_at)).toISOString() : null,
    });
    await pool.query(
      `UPDATE public.reminders
          SET next_attempt_at = $2,
              claimed_at = CASE WHEN status = 'claimed' THEN now() ELSE claimed_at END
        WHERE id = $1`,
      [row.id, new Date(Date.now() + 86_400_000).toISOString()],
    );
  }
  return deferred.map((r) => r.id);
}

main()
  .catch((err) => {
    results.error = err instanceof Error ? err.message : String(err);
  })
  .finally(async () => {
    // Restore deferred reminders exactly, then remove fixtures.
    for (const row of deferred) {
      await pool.query(
        'UPDATE public.reminders SET next_attempt_at = $2, claimed_at = $3 WHERE id = $1',
        [row.id, row.next_attempt_at, row.claimed_at],
      );
    }
    if (fixtureIds.length > 0) {
      await pool.query('DELETE FROM public.reminders WHERE id = ANY($1::uuid[])', [fixtureIds]);
    }
    await pool.end();

    console.log(JSON.stringify({ logs, results }, null, 2));

    const r = results as Record<string, any>;
    const ok =
      r.claimAndSend?.status === 'sent' &&
      r.claimAndSend?.mockEmailsSent >= 1 &&
      r.duplicatePrevention?.tick?.claimed === 0 &&
      r.transientRetry?.status === 'pending' &&
      r.transientRetry?.scheduledInFuture === true &&
      r.attemptsExhausted?.status === 'failed' &&
      r.staleClaimRecovery?.status === 'sent' &&
      r.notClaimable?.futureSentAt === null &&
      r.notClaimable?.cancelledSentAt === null;
    process.exit(ok ? 0 : 1);
  });
