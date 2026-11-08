/**
 * tests/profile-api.test.ts — clean, parse-safe (Milestone 3).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
vi.mock('../src/services/supabase.service.js', async () => {
  const { fakeCreateUserScopedClient } = await import('./helpers/fakeSupabase.js');
  return { createUserScopedClient: fakeCreateUserScopedClient, createAdminClient: () => { throw new Error('no'); } };
});
import app from '../src/app.js';
import { registerUser, resetFakeSupabase } from './helpers/fakeSupabase.js';
const TOKEN_A = 'headerA.payloadA.signatureA';
const USER_A = '11111111-1111-4111-8111-111111111111';

describe('Profile API', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN_A, USER_A, 'a@example.com', { provider: 'google', displayName: 'Gi' });
  });
  it('GET /api/me returns verified profile', async () => {
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(USER_A);
  });
  it('PATCH changes display_name', async () => {
    const r = await request(app).patch('/api/me').set('Authorization', `Bearer ${TOKEN_A}`).send({ display_name: 'X' });
    expect(r.status).toBe(200);
    expect(r.body.user.display_name).toBe('X');
  });
});
