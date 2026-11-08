/**
 * tests/reminder-api.test.ts
 * --------------------------
 * Milestone 2: /api/reminders endpoints — CRUD, ownership isolation,
 * idempotency, state conflicts, validation, and delivery-status views
 * (scenarios 6, 7, 8, 14, 15, 18, 19, 20 of the test plan).
 *
 * Supabase is the in-memory fake (service-layer ownership filters are
 * what these tests verify; RLS itself is verified separately against the
 * local dev database — see supabase/local-dev/verify_0003.sql).
 * NO real emails are sent: this suite never touches the email provider.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

vi.mock('../src/services/supabase.service.js', async () => {
  const { fakeCreateUserScopedClient } = await import('./helpers/fakeSupabase.js');
  return {
    createUserScopedClient: fakeCreateUserScopedClient,
    createAdminClient: () => {
      throw new Error('admin client unavailable in tests');
    },
  };
});

import app from '../src/app.js';
import {
  registerUser,
  resetFakeSupabase,
  fakeDb,
} from './helpers/fakeSupabase.js';
import type { FakeReminder } from './helpers/fakeSupabase.js';

const TOKEN_A = 'headerA.payloadA.signatureA';
const TOKEN_B = 'headerB.payloadB.signatureB';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

/** ISO timestamps relative to the REAL test clock (always future/past safely). */
const inOneDay = () => new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const inTwoDays = () => new Date(Date.now() + 48 * 3600 * 1000).toISOString();
const oneHourAgo = () => new Date(Date.now() - 3600 * 1000).toISOString();

function seedReminder(
  userId: string,
  overrides: Partial<FakeReminder> = {},
): FakeReminder {
  const at = inOneDay();
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

describe('reminder API (Milestone 2)', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN_A, USER_A, 'alice@example.com');
    registerUser(TOKEN_B, USER_B, 'bob@example.com');
  });

  // --- Scenario 6: create + list + detail ---------------------------------

  it('creates a reminder for the verified user (ignores body user_id)', async () => {
    const res = await request(app)
      .post('/api/reminders')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ title: 'Interview call', reminder_at: inOneDay(), user_id: USER_B });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.reminder.user_id).toBe(USER_A);
    expect(res.body.reminder.status).toBe('pending');
    expect(res.body.reminder.attempts).toBe(0);
    expect(res.body.reminder.reminder_at).toMatch(/Z$/);
    expect(fakeDb.reminders).toHaveLength(1);
  });

  it('lists only the authenticated user\'s reminders', async () => {
    const mine = seedReminder(USER_A, { title: 'mine' });
    seedReminder(USER_B, { title: 'theirs' });

    const res = await request(app)
      .get('/api/reminders')
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(res.status).toBe(200);
    expect(res.body.reminders).toHaveLength(1);
    expect(res.body.reminders[0].id).toBe(mine.id);
    expect(res.body.reminders[0].user_id).toBe(USER_A);
  });

  it('returns a reminder detail including delivery status fields', async () => {
    const seeded = seedReminder(USER_A, {
      status: 'sent',
      sent_at: new Date().toISOString(),
      attempts: 1,
    });

    const res = await request(app)
      .get(`/api/reminders/${seeded.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(res.status).toBe(200);
    expect(res.body.reminder.status).toBe('sent');
    expect(res.body.reminder.sent_at).toBeTruthy();
  });

  // --- Scenario 7: tasks and due dates do NOT create reminders ------------

  it('does not create reminders as a side effect of task operations', async () => {
    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ title: 'Task with due date', due_date: inOneDay() });

    const res = await request(app)
      .get('/api/reminders')
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(res.status).toBe(200);
    expect(res.body.reminders).toHaveLength(0);
    expect(fakeDb.reminders).toHaveLength(0);
  });

  // --- Scenario 8: duplicate prevention (idempotency) ----------------------

  it('is idempotent: the same idempotency_key returns the existing reminder', async () => {
    const payload = {
      title: 'Pay rent',
      reminder_at: inOneDay(),
      idempotency_key: 'rent-nov-2026',
    };

    const first = await request(app)
      .post('/api/reminders')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send(payload);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/reminders')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send(payload);

    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.reminder.id).toBe(first.body.reminder.id);
    expect(fakeDb.reminders).toHaveLength(1);
  });

  it('scopes idempotency keys per user (same key, different user, new row)', async () => {
    const payload = { title: 'Shared key', reminder_at: inOneDay(), idempotency_key: 'same-key' };

    await request(app).post('/api/reminders').set('Authorization', `Bearer ${TOKEN_A}`).send(payload);
    const other = await request(app)
      .post('/api/reminders')
      .set('Authorization', `Bearer ${TOKEN_B}`)
      .send(payload);

    expect(other.status).toBe(201);
    expect(other.body.reminder.user_id).toBe(USER_B);
    expect(fakeDb.reminders).toHaveLength(2);
  });

  // --- Scenario 18: unauthorized cross-user access -------------------------

  it('404s reading another user\'s reminder by id', async () => {
    const theirs = seedReminder(USER_B);

    const res = await request(app)
      .get(`/api/reminders/${theirs.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Reminder not found');
  });

  it('404s a reschedule against another user\'s reminder and leaves it unchanged', async () => {
    const theirs = seedReminder(USER_B);

    const res = await request(app)
      .put(`/api/reminders/${theirs.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ reminder_at: inTwoDays() });

    expect(res.status).toBe(404);
    const stillThere = fakeDb.reminders.find((r) => r.id === theirs.id);
    expect(stillThere?.reminder_at).toBe(theirs.reminder_at);
  });

  it('404s a cancel against another user\'s reminder and preserves it', async () => {
    const theirs = seedReminder(USER_B);

    const res = await request(app)
      .delete(`/api/reminders/${theirs.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(res.status).toBe(404);
    expect(fakeDb.reminders.find((r) => r.id === theirs.id)?.status).toBe('pending');
  });

  // --- Scenario 14: cancellation before delivery ---------------------------

  it('cancels a pending reminder (soft delete keeps status history)', async () => {
    const mine = seedReminder(USER_A);

    const res = await request(app)
      .delete(`/api/reminders/${mine.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(res.status).toBe(200);
    expect(res.body.reminder.status).toBe('cancelled');
    expect(fakeDb.reminders).toHaveLength(1); // history preserved, not deleted
  });

  it('refuses to cancel twice (409 after the first cancel)', async () => {
    const mine = seedReminder(USER_A);
    await request(app).delete(`/api/reminders/${mine.id}`).set('Authorization', `Bearer ${TOKEN_A}`);

    const res = await request(app)
      .delete(`/api/reminders/${mine.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot be cancelled/i);
  });

  it('refuses to cancel an already-sent reminder (409)', async () => {
    const sent = seedReminder(USER_A, { status: 'sent', sent_at: new Date().toISOString() });

    const res = await request(app)
      .delete(`/api/reminders/${sent.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(res.status).toBe(409);
    expect(fakeDb.reminders.find((r) => r.id === sent.id)?.status).toBe('sent');
  });

  // --- Scenario 15: modification of pending reminders ----------------------

  it('reschedules a pending reminder to a future time', async () => {
    const mine = seedReminder(USER_A);
    const newTime = inTwoDays();

    const res = await request(app)
      .put(`/api/reminders/${mine.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ reminder_at: newTime });

    expect(res.status).toBe(200);
    expect(res.body.reminder.reminder_at).toBe(newTime);
    expect(res.body.reminder.status).toBe('pending');
    // The claim window moves with the new time.
    expect(res.body.reminder.next_attempt_at).toBe(newTime);
  });

  it('refuses to reschedule a non-pending reminder (409)', async () => {
    const claimed = seedReminder(USER_A, { status: 'claimed', claimed_at: new Date().toISOString() });

    const res = await request(app)
      .put(`/api/reminders/${claimed.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ reminder_at: inTwoDays() });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot be rescheduled/i);
  });

  // --- Scenario 19: invalid reminder timestamps ----------------------------

  it('rejects creating a reminder in the past (400, nothing persisted)', async () => {
    const res = await request(app)
      .post('/api/reminders')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ title: 'Too late', reminder_at: oneHourAgo() });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/in the past/i);
    expect(fakeDb.reminders).toHaveLength(0);
  });

  it('rejects a malformed reminder_at (400 from Zod)', async () => {
    const res = await request(app)
      .post('/api/reminders')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ title: 'Bad time', reminder_at: 'tomorrow-ish at some point' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid reminder payload/i);
    expect(fakeDb.reminders).toHaveLength(0);
  });

  it('rejects rescheduling to a past time (400, unchanged)', async () => {
    const mine = seedReminder(USER_A);

    const res = await request(app)
      .put(`/api/reminders/${mine.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ reminder_at: oneHourAgo() });

    expect(res.status).toBe(400);
    expect(fakeDb.reminders.find((r) => r.id === mine.id)?.reminder_at).toBe(mine.reminder_at);
  });

  it('requires authentication for every reminder endpoint', async () => {
    const seeded = seedReminder(USER_A);
    const endpoints: Array<[string, string]> = [
      ['get', '/api/reminders'],
      ['get', `/api/reminders/${seeded.id}`],
      ['post', '/api/reminders'],
      ['put', `/api/reminders/${seeded.id}`],
      ['delete', `/api/reminders/${seeded.id}`],
    ];
    for (const [method, path] of endpoints) {
      // eslint-disable-next-line no-await-in-loop
      const res = await (request(app) as any)[method](path);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });

  // --- Scenario 20: delivery status consistency / filtering ----------------

  it('filters by status and scope so delivered vs pending are distinguishable', async () => {
    seedReminder(USER_A, { title: 'pending one', status: 'pending', reminder_at: inOneDay() });
    seedReminder(USER_A, {
      title: 'delivered one',
      status: 'sent',
      reminder_at: oneHourAgo(),
      sent_at: new Date().toISOString(),
      next_attempt_at: oneHourAgo(),
    });
    seedReminder(USER_A, {
      title: 'failed one',
      status: 'failed',
      reminder_at: oneHourAgo(),
      failed_at: new Date().toISOString(),
      failure_reason: 'provider rejected sender',
      next_attempt_at: oneHourAgo(),
    });

    const upcoming = await request(app)
      .get('/api/reminders?scope=upcoming')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(upcoming.status).toBe(200);
    expect(upcoming.body.reminders.map((r: FakeReminder) => r.title)).toEqual(['pending one']);

    const past = await request(app)
      .get('/api/reminders?scope=past')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(past.status).toBe(200);
    expect(past.body.reminders).toHaveLength(2);

    const failed = await request(app)
      .get('/api/reminders?status=failed')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(failed.status).toBe(200);
    expect(failed.body.reminders).toHaveLength(1);
    expect(failed.body.reminders[0].failure_reason).toBe('provider rejected sender');
  });

  it('rejects invalid query filters (400)', async () => {
    const res = await request(app)
      .get('/api/reminders?status=exploded')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(400);
  });

  it('rejects an invalid reminder id path parameter (400)', async () => {
    const res = await request(app)
      .get('/api/reminders/not-a-uuid')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(400);
  });
});
