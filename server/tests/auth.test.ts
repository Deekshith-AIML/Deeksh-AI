/**
 * tests/auth.test.ts
 * ------------------
 * Authentication matrix for the protected API surface.
 *
 * All requests run against the real Express app (src/app.ts) via supertest;
 * Supabase is replaced by the in-memory fake (see helpers/fakeSupabase.ts),
 * so no live credentials or network calls are involved.
 *
 * Covers: missing token, malformed token/header, expired token, unknown
 * token, valid token, and the removal of the legacy `x-user-id` vector.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

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
  resetFakeSupabase,
} from './helpers/fakeSupabase.js';
import { extractBearerToken } from '../src/middleware/auth.middleware.js';

// Three-segment strings pass the JWT shape check in auth.service.
const TOKEN_A = 'headerA.payloadA.signatureA';
const EXPIRED_TOKEN = 'headerX.payloadX.signatureX';
const UNKNOWN_TOKEN = 'headerU.payloadU.signatureU';
const USER_A = '11111111-1111-4111-8111-111111111111';

describe('API authentication', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN_A, USER_A, 'a@example.com');
    registerUser(EXPIRED_TOKEN, USER_A, 'a@example.com');
    expireToken(EXPIRED_TOKEN);
  });

  it('rejects a request with no Authorization header (401)', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/authentication required/i);
  });

  it('rejects a non-Bearer scheme (401)', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Basic ${Buffer.from('user:pass').toString('base64')}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/authentication required/i);
  });

  it('rejects "Bearer" with no token (401)', async () => {
    const res = await request(app).get('/api/tasks').set('Authorization', 'Bearer');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed (non-JWT-shaped) token (401)', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/malformed/i);
  });

  it('rejects an expired token (401)', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${EXPIRED_TOKEN}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });

  it('rejects an unknown but well-formed token (401)', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${UNKNOWN_TOKEN}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });

  it('accepts a valid token and returns the user\'s tasks (200)', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tasks)).toBe(true);
  });

  it('does not let x-user-id bypass authentication (401)', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .set('x-user-id', '22222222-2222-4222-8222-222222222222');
    expect(res.status).toBe(401);
  });

  it('keeps /health unauthenticated (200, no user data)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', uptime: expect.any(Number) });
  });

  it('returns 401 for unauthenticated chat requests', async () => {
    const res = await request(app)
      .post('/api/chat')
      .send({ message: 'hi' });
    expect(res.status).toBe(401);
  });
});

describe('extractBearerToken (unit)', () => {
  it('parses a standard Bearer header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('rejects missing values', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('')).toBeUndefined();
  });

  it('rejects non-Bearer schemes', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
    expect(extractBearerToken('Token abc')).toBeUndefined();
  });

  it('rejects a scheme with no token', () => {
    expect(extractBearerToken('Bearer ')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
  });
});
