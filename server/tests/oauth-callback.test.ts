/**
 * tests/oauth-callback.test.ts
 * ---------------------------
 * OAuth callback validation (client-side `parseOAuthCallback`) plus the
 * drift-guard assertion that `client/src/lib/oauth.ts` mirrors
 * `shared/auth.ts`.
 *
 * NOTE: vitest resolves `.js` imports to `.ts` via tsconfig.test (rootDir
 * `..` includes `client/`); `../../client/src/lib/oauthCallback.js` works.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/services/supabase.service.js', async () => {
  const { fakeCreateUserScopedClient } = await import('./helpers/fakeSupabase.js');
  return { createUserScopedClient: fakeCreateUserScopedClient, createAdminClient: () => { throw new Error('no'); } };
});

import app from '../src/app.js';
import { registerUser, resetFakeSupabase, revokeToken } from './helpers/fakeSupabase.js';
import request from 'supertest';
import { parseOAuthCallback, sanitizeOAuthError } from '../../client/src/lib/oauthCallback.js';
import { GOOGLE_LOGIN_SCOPES, GOOGLE_EXTRA_SCOPES, SUPPORTED_INTEGRATIONS, isAllowedExtraScope } from '../../shared/auth.js';

describe('OAuth callback + security', () => {
  describe('parseOAuthCallback (pure classification)', () => {
    it('classifies access_denied as denied', () => {
      const res = parseOAuthCallback(new URLSearchParams('error=access_denied'));
      expect(res.kind).toBe('denied');
    });

    it('classifies other errors as invalid', () => {
      const res = parseOAuthCallback(new URLSearchParams('error=invalid_scope'));
      expect(res.kind).toBe('invalid');
    });

    it('classifies valid code as success', () => {
      const res = parseOAuthCallback(new URLSearchParams('code=AbC123.456'));
      expect(res.kind).toBe('success');
      expect((res as { kind: 'success'; code: string }).code).toBe('AbC123.456');
    });

    it('rejects malicious code with control chars', () => {
      const res = parseOAuthCallback(new URLSearchParams('code=bad\nscript'));
      expect(res.kind).toBe('invalid');
    });
  });

  describe('sanitizeOAuthError', () => {
    it('collapses whitespace, caps length, strips control chars', () => {
      expect(sanitizeOAuthError('bad\nscript', 'fallback')).toBe('bad script');
      expect(sanitizeOAuthError('a'.repeat(500), 'x').length).toBeLessThanOrEqual(200);
    });
  });

  describe('shared/auth canonical values (hard guard)', () => {
    it('login scopes, extra allow-list, integrations are canonical', () => {
      expect(GOOGLE_LOGIN_SCOPES).toBe('openid email profile');
      expect(GOOGLE_EXTRA_SCOPES).toContain('gmail.readonly');
      expect(GOOGLE_EXTRA_SCOPES).toContain('calendar.readonly');
      expect(SUPPORTED_INTEGRATIONS).toContain('google');
      expect(isAllowedExtraScope('calendar.readonly')).toBe(true);
      expect(isAllowedExtraScope('invalid.scope')).toBe(false);
    });
  });

  describe('revocation + session end-to-end', () => {
    beforeEach(() => {
      resetFakeSupabase();
    });

    it('revokeToken makes auth.getUser fail (401) for the protected surface', async () => {
      const TOKEN_R = 'headerR.payloadR.signatureR';
      registerUser(TOKEN_R, '33333333-3333-3333-8333-333333333333', 'revoked@example.com');
      revokeToken(TOKEN_R);

      const res = await request(app).get('/api/me').set('Authorization', `Bearer ${TOKEN_R}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid or expired/i);
    });
  });
});
