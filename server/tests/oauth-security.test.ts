/**
 * tests/oauth-security.test.ts
 * ----------------------------
 * Unified multi-user security matrix (Milestone 3).
 *
 * All requests run against the real Express app (src/app.ts) via supertest
 * with the in-memory Supabase double — no live credentials or network.
 *
 * Covers the required security test list end-to-end:
 *   - invalid tokens, expired tokens, REVOKED tokens (session revocation)
 *   - unauthorized requests (incl. the new /api/me + /api/integrations)
 *   - cross-user TASK access
 *   - cross-user REMINDER access
 *   - cross-user CONVERSATION access (history handed to the model)
 *   - cross-user PROFILE access (incl. forged identity vectors)
 *   - cross-user INTEGRATION GRANT access
 *   - identity derived exclusively from the verified bearer token
 *
 * OAuth callback validation lives in oauth-callback.test.ts; profile and
 * integration API behavior in profile-api.test.ts / integrations-api.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

const { openaiCreate } = vi.hoisted(() => ({ openaiCreate: vi.fn() }));

vi.mock('openai', () => {
  class APIConnectionTimeoutError extends Error {}
  class APIError extends Error {}
  class FakeOpenAI {
    chat = { completions: { create: openaiCreate } };
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    static APIError = APIError;
    constructor(_options?: Record<string, unknown>) {}
  }
  return { default: FakeOpenAI };
});

// Replace the Supabase client factory before the app graph is imported.
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
  expireToken,
  revokeToken,
  resetFakeSupabase,
  fakeDb,
} from './helpers/fakeSupabase.js';
import type { FakeProfile, FakeGrant, FakeReminder, FakeTask } from './helpers/fakeSupabase.js';
import { assistantReply } from './helpers/geminiMocks.js';

const TOKEN_A = 'headerA.payloadA.signatureA';
const TOKEN_B = 'headerB.payloadB.signatureB';
const EXPIRED_TOKEN = 'headerX.payloadX.signatureX';
const UNKNOWN_TOKEN = 'headerU.payloadU.signatureU';
const REVOKED_TOKEN = 'headerR.payloadR.signatureR';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const authA = () => ({ Authorization: `Bearer ${TOKEN_A}` });
const authB = () => ({ Authorization: `Bearer ${TOKEN_B}` });

/** Every protected surface used by the matrix. */
const PROTECTED_ENDPOINTS: Array<{ method: 'get' | 'post'; path: string; body?: unknown }> = [
  { method: 'get', path: '/api/tasks' },
  { method: 'get', path: '/api/reminders' },
  { method: 'post', path: '/api/chat', body: { message: 'hi' } },
  { method: 'get', path: '/api/me' },
  { method: 'get', path: '/api/integrations' },
];

function seedTask(userId: string, title: string): FakeTask {
  const task: FakeTask = {
    id: randomUUID(),
    user_id: userId,
    title,
    status: 'todo',
    priority: 'medium',
    due_date: null,
    created_at: new Date().toISOString(),
  };
  fakeDb.tasks.push(task);
  return task;
}

function seedReminder(userId: string, title: string): FakeReminder {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const reminder: FakeReminder = {
    id: randomUUID(),
    user_id: userId,
    task_id: null,
    title,
    reminder_at: future,
    status: 'pending',
    attempts: 0,
    max_attempts: 3,
    next_attempt_at: future,
    last_attempt_at: null,
    sent_at: null,
    failed_at: null,
    failure_reason: null,
    claimed_at: null,
    idempotency_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  fakeDb.reminders.push(reminder);
  return reminder;
}

function seedMessage(userId: string, content: string): void {
  fakeDb.messages.push({
    id: randomUUID(),
    user_id: userId,
    role: 'user',
    content,
    created_at: new Date().toISOString(),
  });
}

let taskA: FakeTask;
let taskB: FakeTask;
let reminderA: FakeReminder;
let reminderB: FakeReminder;
let profileA: FakeProfile;
let profileB: FakeProfile;

describe('Milestone 3 security matrix', () => {
  beforeEach(() => {
    resetFakeSupabase();

    registerUser(TOKEN_A, USER_A, 'a@example.com', { displayName: 'Alice' });
    registerUser(TOKEN_B, USER_B, 'b@example.com', { displayName: 'Bob' });
    registerUser(EXPIRED_TOKEN, USER_A, 'a@example.com');
    expireToken(EXPIRED_TOKEN);
    registerUser(REVOKED_TOKEN, USER_A, 'a@example.com');
    revokeToken(REVOKED_TOKEN);

    openaiCreate.mockReset();
    openaiCreate.mockResolvedValue(assistantReply('OK.'));

    taskA = seedTask(USER_A, 'A secret task');
    taskB = seedTask(USER_B, 'B secret task');
    reminderA = seedReminder(USER_A, 'A secret reminder');
    reminderB = seedReminder(USER_B, 'B secret reminder');
    profileA = fakeDb.users.find((u) => u.id === USER_A)!;
    profileB = fakeDb.users.find((u) => u.id === USER_B)!;
  });

  // -------------------------------------------------------------------------
  // Token validity matrix (invalid / expired / revoked / unauthorized)
  // -------------------------------------------------------------------------

  it('rejects unknown tokens on every protected endpoint (401)', async () => {
    for (const ep of PROTECTED_ENDPOINTS) {
      const res = await request(app)
        [ep.method](ep.path)
        .set('Authorization', `Bearer ${UNKNOWN_TOKEN}`)
        .send(ep.body ?? {});
      expect(res.status, `${ep.method.toUpperCase()} ${ep.path}`).toBe(401);
    }
  });

  it('rejects expired tokens on every protected endpoint (401)', async () => {
    for (const ep of PROTECTED_ENDPOINTS) {
      const res = await request(app)
        [ep.method](ep.path)
        .set('Authorization', `Bearer ${EXPIRED_TOKEN}`)
        .send(ep.body ?? {});
      expect(res.status, `${ep.method.toUpperCase()} ${ep.path}`).toBe(401);
      expect(res.body.error).toMatch(/invalid or expired/i);
    }
  });

  it('rejects REVOKED sessions (sign-out/revocation) on every endpoint (401)', async () => {
    for (const ep of PROTECTED_ENDPOINTS) {
      const res = await request(app)
        [ep.method](ep.path)
        .set('Authorization', `Bearer ${REVOKED_TOKEN}`)
        .send(ep.body ?? {});
      expect(res.status, `${ep.method.toUpperCase()} ${ep.path}`).toBe(401);
    }
  });

  it('rejects unauthorized (no token) requests to the new endpoints (401)', async () => {
    const me = await request(app).get('/api/me');
    expect(me.status).toBe(401);

    const integrations = await request(app).get('/api/integrations');
    expect(integrations.status).toBe(401);

    const patch = await request(app).patch('/api/me').send({ display_name: 'x' });
    expect(patch.status).toBe(401);

    const grant = await request(app)
      .post('/api/integrations')
      .send({ integration: 'google', scopes: ['gmail.readonly'] });
    expect(grant.status).toBe(401);

    const revoke = await request(app).delete('/api/integrations/google');
    expect(revoke.status).toBe(401);
  });

  it('accepts a valid token on the new endpoints (200)', async () => {
    const me = await request(app).get('/api/me').set(authA());
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(USER_A);

    const integrations = await request(app).get('/api/integrations').set(authA());
    expect(integrations.status).toBe(200);
    expect(integrations.body.integrations).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Identity comes exclusively from verified credentials
  // -------------------------------------------------------------------------

  it('ignores forged identity vectors on /api/me (x-user-id, body, query)', async () => {
    const res = await request(app)
      .get(`/api/me?user_id=${USER_B}`)
      .set(authA())
      .set('x-user-id', USER_B)
      .send({ id: USER_B, email: 'b@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(USER_A);
    expect(res.body.user.email).toBe('a@example.com');
  });

  it('never lets a client overwrite another profile via PATCH /api/me', async () => {
    const res = await request(app)
      .patch('/api/me')
      .set(authA())
      .send({
        display_name: 'Alice Renamed',
        id: USER_B,
        email: 'forged@evil.example',
        provider: 'google',
      });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(USER_A);
    expect(res.body.user.email).toBe('a@example.com'); // unchanged
    expect(res.body.user.provider).toBe('email'); // unchanged

    // B's row is untouched.
    expect(profileB.display_name).toBe('Bob');
    expect(profileB.email).toBe('b@example.com');
    expect(profileB.provider).toBe('email');
  });

  // -------------------------------------------------------------------------
  // Cross-user TASK access
  // -------------------------------------------------------------------------

  it('blocks cross-user task read/update/delete (404, data untouched)', async () => {
    const read = await request(app).get(`/api/tasks/${taskB.id}`).set(authA());
    expect(read.status).toBe(404);

    const update = await request(app)
      .put(`/api/tasks/${taskB.id}`)
      .set(authA())
      .send({ title: 'pwned by A' });
    expect(update.status).toBe(404);

    const del = await request(app).delete(`/api/tasks/${taskB.id}`).set(authA());
    expect(del.status).toBe(404);

    const still = fakeDb.tasks.find((t) => t.id === taskB.id);
    expect(still?.title).toBe('B secret task');
  });

  // -------------------------------------------------------------------------
  // Cross-user REMINDER access
  // -------------------------------------------------------------------------

  it('blocks cross-user reminder read/reschedule/cancel (404, data untouched)', async () => {
    const read = await request(app).get(`/api/reminders/${reminderB.id}`).set(authA());
    expect(read.status).toBe(404);

    const reschedule = await request(app)
      .put(`/api/reminders/${reminderB.id}`)
      .set(authA())
      .send({ reminder_at: new Date(Date.now() + 7_200_000).toISOString() });
    expect(reschedule.status).toBe(404);

    const cancel = await request(app)
      .delete(`/api/reminders/${reminderB.id}`)
      .set(authA());
    expect(cancel.status).toBe(404);

    const still = fakeDb.reminders.find((r) => r.id === reminderB.id);
    expect(still?.status).toBe('pending');
    expect(still?.reminder_at).toBe(reminderB.reminder_at);
    expect(still?.title).toBe('B secret reminder');
  });

  it('lists only the caller\'s reminders', async () => {
    const res = await request(app).get('/api/reminders').set(authA());
    expect(res.status).toBe(200);
    expect(res.body.reminders).toHaveLength(1);
    expect(res.body.reminders[0].id).toBe(reminderA.id);
  });

  // -------------------------------------------------------------------------
  // Cross-user CONVERSATION access
  // -------------------------------------------------------------------------

  it('never hands the model another user\'s conversation history', async () => {
    seedMessage(USER_A, 'ALPHA-SECRET-TURN');
    seedMessage(USER_B, 'BRAVO-SECRET-TURN');

    const res = await request(app)
      .post('/api/chat')
      .set(authA())
      .send({ message: 'continue' });
    expect(res.status).toBe(200);

    const payload = openaiCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content?: string | null }>;
    };
    const contents = payload.messages.map((m) => m.content ?? '').join('\n');
    expect(contents).toContain('ALPHA-SECRET-TURN');
    expect(contents).not.toContain('BRAVO-SECRET-TURN');

    // B gained no new messages from A's request.
    const bMessages = fakeDb.messages.filter((m) => m.user_id === USER_B);
    expect(bMessages).toHaveLength(1);
    expect(bMessages[0]!.content).toBe('BRAVO-SECRET-TURN');
  });

  // -------------------------------------------------------------------------
  // Cross-user PROFILE + INTEGRATION GRANT access
  // -------------------------------------------------------------------------

  it('keeps profiles isolated: /api/me always returns the caller', async () => {
    const resA = await request(app).get('/api/me').set(authA());
    const resB = await request(app).get('/api/me').set(authB());
    expect(resA.body.user.id).toBe(USER_A);
    expect(resB.body.user.id).toBe(USER_B);
    expect(resA.body.user.email).toBe('a@example.com');
    expect(resB.body.user.email).toBe('b@example.com');
  });

  it('scopes integration grants to each user and blocks cross-user revoke', async () => {
    // A records an explicit grant.
    const grant = await request(app)
      .post('/api/integrations')
      .set(authA())
      .send({ integration: 'google', scopes: ['gmail.readonly'] });
    expect(grant.status).toBe(201);

    // B sees nothing of A's grants.
    const listB = await request(app).get('/api/integrations').set(authB());
    expect(listB.status).toBe(200);
    expect(listB.body.integrations).toEqual([]);

    // B cannot revoke A's grant (never granted by B → 404).
    const revokeB = await request(app)
      .delete('/api/integrations/google')
      .set(authB());
    expect(revokeB.status).toBe(404);

    // A's grant is untouched.
    const listA = await request(app).get('/api/integrations').set(authA());
    expect(listA.body.integrations).toHaveLength(1);
    expect(listA.body.integrations[0].scopes).toEqual(['gmail.readonly']);
    expect(listA.body.integrations[0].revoked_at).toBeNull();
  });

  it('ignores forged ownership in the grant body (stored under caller)', async () => {
    const res = await request(app)
      .post('/api/integrations')
      .set(authA())
      .send({
        integration: 'google',
        scopes: ['calendar.readonly'],
        user_id: USER_B, // stripped by Zod — never trusted
      });
    expect(res.status).toBe(201);

    const rows = fakeDb.integration_grants as FakeGrant[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(USER_A);
    expect(rows[0]!.scopes).toEqual(['calendar.readonly']);
  });

  it('keeps profile A unchanged while B edits theirs', async () => {
    const res = await request(app)
      .patch('/api/me')
      .set(authB())
      .send({ display_name: 'Bobby' });
    expect(res.status).toBe(200);

    expect(profileA.display_name).toBe('Alice');
    expect(profileB.display_name).toBe('Bobby');
    expect(profileA.email).toBe('a@example.com');
  });
});
