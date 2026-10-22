/**
 * tests/task-validation.test.ts
 * -----------------------------
 * Request validation, consistent error responses, and database-failure
 * sanitization for the task API.
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
  injectDatabaseFailure,
  fakeDb,
} from './helpers/fakeSupabase.js';

const TOKEN_A = 'headerA.payloadA.signatureA';
const USER_A = '11111111-1111-4111-8111-111111111111';
const auth = () => ({ Authorization: `Bearer ${TOKEN_A}` });

describe('Zod validation of task requests', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN_A, USER_A, 'a@example.com');
  });

  it('400s task creation without a title', async () => {
    const res = await request(app).post('/api/tasks').set(auth()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid task payload');
    expect(res.body.details).toBeDefined();
  });

  it('400s task creation with an invalid priority', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'x', priority: 'urgent' });
    expect(res.status).toBe(400);
  });

  it('400s task creation with an invalid status', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'x', status: 'archived' });
    expect(res.status).toBe(400);
  });

  it('400s an empty update payload', async () => {
    const res = await request(app)
      .put(`/api/tasks/${randomUUID()}`)
      .set(auth())
      .send({});
    expect(res.status).toBe(400);
  });

  it('400s an invalid status on update', async () => {
    const res = await request(app)
      .put(`/api/tasks/${randomUUID()}`)
      .set(auth())
      .send({ status: 'nope' });
    expect(res.status).toBe(400);
  });

  it('400s a non-uuid task id', async () => {
    const res = await request(app)
      .get('/api/tasks/not-a-uuid')
      .set(auth());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid task id');
  });

  it('400s invalid list query filters', async () => {
    const res = await request(app)
      .get('/api/tasks?status=finished')
      .set(auth());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid query parameters');
  });

  it('404s a valid but non-existent task id', async () => {
    const res = await request(app)
      .get(`/api/tasks/${randomUUID()}`)
      .set(auth());
    expect(res.status).toBe(404);
  });
});

describe('database failure handling', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN_A, USER_A, 'a@example.com');
  });

  it('returns a sanitized 500 when task creation fails', async () => {
    injectDatabaseFailure('tasks', 'insert', 'simulated: relation "tasks" is broken');

    const res = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'will fail' });

    expect(res.status).toBe(500);
    // Generic message only — internals must not leak to the client.
    expect(res.body.error).toBe('Internal server error');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('simulated');
    expect(raw).not.toContain('relation');
    expect(raw).not.toContain('Failed to create task');

    // No phantom task was created.
    expect(fakeDb.tasks).toHaveLength(0);
  });

  it('returns a sanitized 500 when task update fails', async () => {
    injectDatabaseFailure('tasks', 'update', 'simulated: deadlock detected');

    const res = await request(app)
      .put(`/api/tasks/${randomUUID()}`)
      .set(auth())
      .send({ title: 'will fail' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toContain('deadlock');
  });

  it('returns a sanitized 500 when listing fails', async () => {
    injectDatabaseFailure('tasks', 'select', 'simulated: connection lost');

    const res = await request(app).get('/api/tasks').set(auth());
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toContain('connection lost');
  });

  it('recovers on the next request after a transient failure', async () => {
    injectDatabaseFailure('tasks', 'insert', 'transient');
    const fail = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'first try' });
    expect(fail.status).toBe(500);

    const ok = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'second try' });
    expect(ok.status).toBe(201);
    expect(fakeDb.tasks).toHaveLength(1);
  });
});
