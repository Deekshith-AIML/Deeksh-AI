/**
 * tests/task-isolation.test.ts
 * ----------------------------
 * Cross-user task isolation (the core multi-tenancy boundary).
 *
 * User A must never be able to read, list, update or delete User B's
 * tasks — including by supplying B's identity through the legacy vectors
 * (query param, x-user-id header, request body). Ownership on create must
 * come from the verified bearer token.
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
import type { FakeTask } from './helpers/fakeSupabase.js';

const TOKEN_A = 'headerA.payloadA.signatureA';
const TOKEN_B = 'headerB.payloadB.signatureB';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

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

let taskA: FakeTask;
let taskB: FakeTask;

describe('task ownership isolation', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN_A, USER_A, 'a@example.com');
    registerUser(TOKEN_B, USER_B, 'b@example.com');
    taskA = seedTask(USER_A, 'A secret task');
    taskB = seedTask(USER_B, 'B secret task');
  });

  it('lists only the authenticated user\'s tasks', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].id).toBe(taskA.id);
    expect(res.body.tasks[0].title).toBe('A secret task');
  });

  it('ignores ?user_id= pointing at another user', async () => {
    const res = await request(app)
      .get(`/api/tasks?user_id=${USER_B}`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].user_id).toBe(USER_A);
  });

  it('ignores an x-user-id header pointing at another user', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .set('x-user-id', USER_B);
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].user_id).toBe(USER_A);
  });

  it('returns 404 when reading another user\'s task by id', async () => {
    const res = await request(app)
      .get(`/api/tasks/${taskB.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task not found');
  });

  it('returns 200 for the user\'s own task', async () => {
    const res = await request(app)
      .get(`/api/tasks/${taskA.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(200);
    expect(res.body.task.id).toBe(taskA.id);
  });

  it('404s an update against another user\'s task and leaves it unchanged', async () => {
    const res = await request(app)
      .put(`/api/tasks/${taskB.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ title: 'pwned by A' });
    expect(res.status).toBe(404);

    // B's task must be untouched in the database.
    const stillThere = fakeDb.tasks.find((t) => t.id === taskB.id);
    expect(stillThere).toBeDefined();
    expect(stillThere?.title).toBe('B secret task');
  });

  it('404s a delete against another user\'s task and preserves it', async () => {
    const res = await request(app)
      .delete(`/api/tasks/${taskB.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(404);

    const stillThere = fakeDb.tasks.find((t) => t.id === taskB.id);
    expect(stillThere).toBeDefined();
  });

  it('creates tasks under the verified user, ignoring body user_id', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ title: 'A new task', user_id: USER_B });

    expect(res.status).toBe(201);
    expect(res.body.task.user_id).toBe(USER_A);

    // And B's list must not contain it.
    const resB = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${TOKEN_B}`);
    expect(resB.body.tasks).toHaveLength(1);
    expect(resB.body.tasks[0].id).toBe(taskB.id);
  });

  it('allows task creation with no identity fields in the body', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${TOKEN_B}`)
      .send({ title: 'B new task' });
    expect(res.status).toBe(201);
    expect(res.body.task.user_id).toBe(USER_B);
  });

  it('keeps each user\'s list independent after mixed activity', async () => {
    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ title: 'second A task' });
    await request(app)
      .put(`/api/tasks/${taskA.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ status: 'in_progress' });

    const [resA, resB] = await Promise.all([
      request(app).get('/api/tasks').set('Authorization', `Bearer ${TOKEN_A}`),
      request(app).get('/api/tasks').set('Authorization', `Bearer ${TOKEN_B}`),
    ]);

    expect(resA.body.tasks).toHaveLength(2);
    expect(resA.body.tasks.every((t: FakeTask) => t.user_id === USER_A)).toBe(true);
    expect(resB.body.tasks).toHaveLength(1);
    expect(resB.body.tasks[0].user_id).toBe(USER_B);
  });
});
