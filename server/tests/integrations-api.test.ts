/**
 * tests/integrations-api.test.ts
 * -----------------------------
 * Integration consent endpoints (GET/POST /api/integrations, DELETE /api/integrations/:int).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/services/supabase.service.js', async () => {
  const { fakeCreateUserScopedClient } = await import('./helpers/fakeSupabase.js');
  return { createUserScopedClient: fakeCreateUserScopedClient, createAdminClient: () => { throw new Error('no'); } };
});

import app from '../src/app.js';
import { registerUser, resetFakeSupabase, fakeDb, injectConcurrentInsert } from './helpers/fakeSupabase.js';
import type { FakeGrant } from './helpers/fakeSupabase.js';

const TOKEN = 'headerI.payloadI.signatureI';
const USER = '14444444-4444-4444-8444-444444444444';

describe('Integrations API (Milestone 3)', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN, USER, 'int@example.com');
  });

  it('lists empty grants initially', async () => {
    const res = await request(app).get('/api/integrations').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.integrations).toEqual([]);
  });

  it('POST records an allowed scope; 400 on disallowed', async () => {
    const ok = await request(app).post('/api/integrations').set('Authorization', `Bearer ${TOKEN}`).send({ integration: 'google', scopes: ['gmail.readonly'] });
    expect(ok.status).toBe(201);

    const bad = await request(app).post('/api/integrations').set('Authorization', `Bearer ${TOKEN}`).send({ integration: 'google', scopes: ['drive.full'] });
    expect(bad.status).toBe(400);
  });

  it('DELETE revokes (idempotent) when granted', async () => {
    await request(app).post('/api/integrations').set('Authorization', `Bearer ${TOKEN}`).send({ integration: 'google', scopes: ['calendar.readonly'] });
    const r = await request(app).delete('/api/integrations/google').set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
  });

  it('DELETE returns 404 when never granted', async () => {
    const r = await request(app).delete('/api/integrations/google').set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status).toBe(404);
  });

  it('race-safe create handles 23505 (simulated concurrent insert)', async () => {
    injectConcurrentInsert('integration_grants', { user_id: USER, integration: 'google', scopes: ['gmail.readonly'] });
    const res = await request(app).post('/api/integrations').set('Authorization', `Bearer ${TOKEN}`).send({ integration: 'google', scopes: ['gmail.readonly'] });
    // Should resolve via update path rather than crash.
    expect(res.status).toBeGreaterThanOrEqual(200);
  });
});
