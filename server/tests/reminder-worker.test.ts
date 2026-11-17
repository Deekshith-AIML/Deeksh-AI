/**
 * tests/reminder-worker.test.ts
 * -----------------------------
 * Milestone 2: background scheduler — atomic claiming, duplicate
 * prevention, provider success/failure handling, bounded retries,
 * crash recovery, and cancellation (scenarios 8, 9, 10, 11, 12, 13,
 * 14, 17, 20 of the test plan).
 *
 * The Supabase double emulates `claim_due_reminders()` /
 * `recover_stale_reminders()` synchronously — the same single-statement
 * atomicity the real SQL provides via FOR UPDATE SKIP LOCKED (whose
 * behavior against real PostgreSQL is verified separately in
 * supabase/local-dev/verify_0003.sql: 6 concurrent claimers, zero
 * duplicates, locked rows skipped).
 *
 * Emails go to the MOCK provider only — nothing is ever sent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  runTick,
  startScheduler,
  computeBackoffMs,
  buildReminderEmail,
  type SchedulerDeps,
  type TickStats,
} from '../src/scheduler/reminder.worker.js';
import { MockEmailProvider } from '../src/services/email/index.js';
import type { SchedulerLogger } from '../src/scheduler/reminder.worker.js';
import {
  fakeCreateUserScopedClient,
  registerUser,
  resetFakeSupabase,
  fakeDb,
} from './helpers/fakeSupabase.js';
import type { FakeReminder } from './helpers/fakeSupabase.js';

const TOKEN = 'headerW.payloadW.signatureW';
const USER = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const past = (seconds = 60) => new Date(Date.now() - seconds * 1000).toISOString();
const future = (seconds = 3600) => new Date(Date.now() + seconds * 1000).toISOString();

/** Silent logger that records lines for assertions. */
function recordingLogger(): SchedulerLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (...args) => lines.push(args.join(' ')),
    warn: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' ')),
  };
}

function seedReminder(
  userId: string,
  overrides: Partial<FakeReminder> = {},
): FakeReminder {
  const at = past();
  const reminder: FakeReminder = {
    id: randomUUID(),
    user_id: userId,
    task_id: null,
    title: 'Seeded reminder',
    reminder_at: at,
    status: 'pending',
    attempts: 0,
    max_attempts: 3,
    next_attempt_at: at,
    last_attempt_at: null,
    sent_at: null,
    failed_at: null,
    failure_reason: null,
    claimed_at: null,
    idempotency_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  fakeDb.reminders.push(reminder);
  return reminder;
}

function makeDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    client: fakeCreateUserScopedClient(TOKEN) as unknown as SupabaseClient,
    email: overrides.email ?? new MockEmailProvider(),
    logger: overrides.logger ?? recordingLogger(),
    now: overrides.now,
    batchSize: overrides.batchSize,
    staleSeconds: overrides.staleSeconds,
    baseBackoffMs: overrides.baseBackoffMs,
    maxBackoffMs: overrides.maxBackoffMs,
  };
}

describe('reminder scheduler (Milestone 2)', () => {
  let email: MockEmailProvider;
  let logger: ReturnType<typeof recordingLogger>;

  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN, USER, 'alice@example.com');
    registerUser('other-token', USER_B, 'bob@example.com');
    email = new MockEmailProvider();
    logger = recordingLogger();
  });

  // --- Scenario 10: successful email delivery -----------------------------

  it('delivers a due reminder and marks it sent only after provider confirmation', async () => {
    const row = seedReminder(USER, { title: 'Interview at 9' });

    const stats = await runTick(makeDeps({ email, logger }));

    expect(stats).toMatchObject({ claimed: 1, sent: 1, failed: 0, retried: 0 });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.to).toBe('alice@example.com'); // from authenticated user data
    expect(email.sent[0]!.subject).toBe('Reminder: Interview at 9');

    const updated = fakeDb.reminders.find((r) => r.id === row.id)!;
    expect(updated.status).toBe('sent');
    expect(updated.sent_at).toBeTruthy();
    expect(updated.attempts).toBe(1); // incremented at claim
    expect(updated.claimed_at).toBeNull();
    expect(logger.lines.some((l) => l.includes('sent via mock'))).toBe(true);
  });

  it('does not touch future reminders (not yet due)', async () => {
    const row = seedReminder(USER, { reminder_at: future(), next_attempt_at: future() });

    const stats = await runTick(makeDeps({ email }));

    expect(stats.claimed).toBe(0);
    expect(email.sent).toHaveLength(0);
    expect(fakeDb.reminders.find((r) => r.id === row.id)!.status).toBe('pending');
  });

  // --- Scenario 11: failed email delivery ---------------------------------

  it('requeues a transient provider failure with backoff (never claims success)', async () => {
    const row = seedReminder(USER, { title: 'Flaky send' });
    email.failNext('transient');

    const stats = await runTick(makeDeps({ email, logger }));

    expect(stats).toMatchObject({ sent: 0, retried: 1, failed: 0 });
    const updated = fakeDb.reminders.find((r) => r.id === row.id)!;
    expect(updated.status).toBe('pending');
    expect(updated.sent_at).toBeNull(); // NOT marked delivered
    expect(updated.failure_reason).toMatch(/transient/i);
    expect(updated.claimed_at).toBeNull();
    expect(updated.next_attempt_at > new Date().toISOString()).toBe(true);
  });

  it('fails permanently on a permanent provider error (no pointless retries)', async () => {
    const row = seedReminder(USER, { title: 'Bad sender' });
    email.failNext('permanent');

    const stats = await runTick(makeDeps({ email, logger }));

    expect(stats).toMatchObject({ sent: 0, failed: 1, retried: 0 });
    const updated = fakeDb.reminders.find((r) => r.id === row.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.failed_at).toBeTruthy();
    expect(updated.failure_reason).toMatch(/permanent/i);
    expect(updated.sent_at).toBeNull();
  });

  it('marks a reminder failed when no recipient email exists (no invented address)', async () => {
    const unknownUser = randomUUID(); // never registered → no email on file
    const row = seedReminder(unknownUser, { title: 'No recipient' });

    const stats = await runTick(makeDeps({ email, logger }));

    expect(stats.failed).toBe(1);
    expect(email.sent).toHaveLength(0); // nothing sent anywhere
    const updated = fakeDb.reminders.find((r) => r.id === row.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.failure_reason).toMatch(/no recipient email/i);
  });

  // --- Scenario 12: retry after transient provider failure ----------------

  it('retries after backoff elapses and succeeds on a later tick', async () => {
    const row = seedReminder(USER, { title: 'Retry me' });
    email.failNext('transient');

    const first = await runTick(makeDeps({ email }));
    expect(first.retried).toBe(1);
    // The mock records the ATTEMPT (including the failed one) — the
    // reminder itself must not be marked sent.
    expect(email.sent).toHaveLength(1);
    expect(fakeDb.reminders.find((r) => r.id === row.id)!.status).toBe('pending');

    // Simulate the backoff window passing: the claim window opens again.
    row.next_attempt_at = past(1);

    const second = await runTick(makeDeps({ email }));
    expect(second.sent).toBe(1);
    expect(email.sent).toHaveLength(2); // attempt 1 (failed) + attempt 2 (delivered)

    const updated = fakeDb.reminders.find((r) => r.id === row.id)!;
    expect(updated.status).toBe('sent');
    expect(updated.attempts).toBe(2); // claim consumed a second attempt
    expect(updated.failure_reason).toBeNull();
  });

  it('does not claim a retry before its backoff expires', async () => {
    const row = seedReminder(USER, {
      status: 'pending',
      next_attempt_at: future(600),
      attempts: 1,
      failure_reason: 'earlier transient error',
    });
    row.reminder_at = past(); // due time passed, but backoff has not

    const stats = await runTick(makeDeps({ email }));

    expect(stats.claimed).toBe(0);
    expect(email.sent).toHaveLength(0);
    expect(fakeDb.reminders.find((r) => r.id === row.id)!.status).toBe('pending');
  });

  // --- Scenario 13: maximum retry attempts --------------------------------

  it('marks the reminder failed when the attempt budget is exhausted', async () => {
    const row = seedReminder(USER, { title: 'Doomed', attempts: 2, max_attempts: 3 });
    email.failNext('transient'); // claim makes attempts=3 → last allowed try

    const stats = await runTick(makeDeps({ email, logger }));

    expect(stats).toMatchObject({ failed: 1, retried: 0, sent: 0 });
    const updated = fakeDb.reminders.find((r) => r.id === row.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.attempts).toBe(3);
    expect(updated.failure_reason).toMatch(/after 3 attempt/i);
    expect(updated.failed_at).toBeTruthy();
  });

  it('never claims a reminder whose attempts already reached max_attempts', async () => {
    seedReminder(USER, { attempts: 3, max_attempts: 3, status: 'pending' });

    const stats = await runTick(makeDeps({ email }));

    expect(stats.claimed).toBe(0);
    expect(email.sent).toHaveLength(0);
  });

  // --- Scenarios 8 & 9: duplicate prevention / two competing workers ------

  it('two concurrent workers never deliver the same reminder twice', async () => {
    for (let i = 1; i <= 4; i += 1) {
      seedReminder(USER, { title: `Concurrent ${i}` });
    }

    // Two independent worker "processes" (separate clients) tick at once.
    const workerA = makeDeps({ email, logger });
    const workerB = {
      ...makeDeps({ email, logger }),
      client: fakeCreateUserScopedClient('other-token') as unknown as SupabaseClient,
    };

    const [statsA, statsB] = await Promise.all([
      runTick(workerA),
      runTick(workerB),
    ]);

    // Every reminder delivered exactly once across both workers.
    expect(statsA.claimed + statsB.claimed).toBe(4);
    expect(statsA.sent + statsB.sent).toBe(4);
    expect(email.sent).toHaveLength(4);

    const subjects = email.sent.map((m) => m.subject).sort();
    expect(new Set(subjects).size).toBe(4); // no subject delivered twice
    expect(fakeDb.reminders.every((r) => r.status === 'sent')).toBe(true);
  });

  it('a reminder claimed by one worker is invisible to the other', async () => {
    const row = seedReminder(USER);

    const statsA = await runTick(makeDeps({ email }));
    const statsB = await runTick(makeDeps({ email }));

    expect(statsA.claimed).toBe(1);
    expect(statsB.claimed).toBe(0);
    expect(email.sent).toHaveLength(1);
    expect(fakeDb.reminders.find((r) => r.id === row.id)!.attempts).toBe(1);
  });

  // --- Scenario 14: cancellation before delivery ---------------------------

  it('never delivers a cancelled reminder', async () => {
    const row = seedReminder(USER, { status: 'cancelled' });

    const stats = await runTick(makeDeps({ email }));

    expect(stats.claimed).toBe(0);
    expect(email.sent).toHaveLength(0);
    expect(fakeDb.reminders.find((r) => r.id === row.id)!.status).toBe('cancelled');
  });

  // --- Scenario 17: worker recovery after interruption ---------------------

  it('recovers claims orphaned by a crashed worker and delivers them', async () => {
    const row = seedReminder(USER, {
      title: 'Interrupted worker',
      status: 'claimed',
      claimed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // stale
      attempts: 1,
    });

    const stats = await runTick(makeDeps({ email, logger }));

    expect(stats.recovered).toBe(1);
    expect(stats.sent).toBe(1);
    expect(email.sent).toHaveLength(1);
    const updated = fakeDb.reminders.find((r) => r.id === row.id)!;
    expect(updated.status).toBe('sent');
  });

  it('fails a stale claim whose attempt budget is exhausted instead of looping', async () => {
    const row = seedReminder(USER, {
      status: 'claimed',
      claimed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      attempts: 3,
      max_attempts: 3,
    });

    const stats = await runTick(makeDeps({ email, logger }));

    expect(stats.recovered).toBe(1);
    expect(stats.claimed).toBe(0);
    expect(email.sent).toHaveLength(0);
    const updated = fakeDb.reminders.find((r) => r.id === row.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.failure_reason).toMatch(/interrupted repeatedly/i);
  });

  it('leaves fresh claims alone (not yet stale)', async () => {
    seedReminder(USER, {
      status: 'claimed',
      claimed_at: new Date().toISOString(), // claimed seconds ago
      attempts: 1,
    });

    const stats = await runTick(makeDeps({ email }));

    expect(stats.recovered).toBe(0);
    expect(stats.claimed).toBe(0);
    expect(email.sent).toHaveLength(0);
  });

  // --- Scenario 20: delivery status consistency ---------------------------

  it('records honest delivery events: sent only on provider success', async () => {
    seedReminder(USER, { title: 'will fail' });
    email.failNext('permanent');

    await runTick(makeDeps({ email }));

    const row = fakeDb.reminders[0]!;
    expect(row.status).toBe('failed');
    expect(row.sent_at).toBeNull(); // no fake delivery timestamp
    expect(row.failed_at).toBeTruthy();
    expect(row.failure_reason).toBeTruthy();
  });

  it('leaves DB rows untouched when the claim RPC fails (throws, no writes)', async () => {
    const row = seedReminder(USER);
    const brokenClient = {
      rpc: async () => ({ data: null, error: { message: 'connection refused' } }),
      from: () => {
        throw new Error('should not be reached');
      },
    } as unknown as SupabaseClient;

    await expect(
      runTick({ client: brokenClient, email, logger }),
    ).rejects.toThrow(/connection refused/i);

    const untouched = fakeDb.reminders.find((r) => r.id === row.id)!;
    expect(untouched.status).toBe('pending');
    expect(untouched.attempts).toBe(0);
  });

  // --- Backoff math (bounded exponential) ----------------------------------

  it('computeBackoffMs grows exponentially and is bounded by the cap', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      expect(computeBackoffMs(1)).toBe(60_000); // 1 min, jitter at midpoint (0.5)
      expect(computeBackoffMs(2)).toBe(120_000); // 2 min
      expect(computeBackoffMs(3)).toBe(240_000); // 4 min
      expect(computeBackoffMs(10)).toBe(3_600_000); // capped at 1 hour
      expect(computeBackoffMs(50)).toBe(3_600_000); // stays capped
    } finally {
      vi.restoreAllMocks()
    }
  });

  // --- Email content safety ------------------------------------------------

  it('escapes HTML in titles inside the email body', () => {
    const msg = buildReminderEmail(
      {
        id: 'x',
        user_id: USER,
        task_id: null,
        title: '<script>alert(1)</script>',
        reminder_at: new Date().toISOString(),
        status: 'claimed',
        attempts: 1,
        max_attempts: 3,
        recipient_email: 'alice@example.com',
      },
      'http://localhost:3000',
    );
    expect(msg.subject).toBe('Reminder: <script>alert(1)</script>'); // subject is plain text
    expect(msg.html).not.toContain('<script>');
    expect(msg.html).toContain('&lt;script&gt;');
  });

  // --- Scheduler loop lifecycle -------------------------------------------

  it('startScheduler ticks immediately and stop() awaits the in-flight tick', async () => {
    const row = seedReminder(USER, { title: 'startup catch-up' });

    const handle = startScheduler({
      ...makeDeps({ email, logger }),
      intervalMs: 60_000, // never fires during the test; startup tick does the work
    });

    // Give the immediate startup tick a moment to complete.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await handle.stop();

    expect(email.sent).toHaveLength(1);
    expect(fakeDb.reminders.find((r) => r.id === row.id)!.status).toBe('sent');

    // After stop, no further ticks happen.
    const sentAfterStop = email.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(email.sent).toHaveLength(sentAfterStop);
  });

  it('overlapping ticks within one worker do not double-send', async () => {
    for (let i = 1; i <= 3; i += 1) seedReminder(USER, { title: `overlap ${i}` });

    const deps = makeDeps({ email, logger });
    // Fire two runTicks directly at once against the SAME worker client:
    // the second claim sees rows already claimed by the first.
    const [a, b] = await Promise.all([runTick(deps), runTick(deps)]);
    expect(a.sent + b.sent).toBe(3);
    expect(email.sent).toHaveLength(3);
  });
});
