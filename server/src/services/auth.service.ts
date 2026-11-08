/**
 * services/auth.service.ts
 * ------------------------
 * Trusted verification of Supabase Auth access tokens.
 *
 * Verification mechanism:
 *   `client.auth.getUser(token)` sends the token to the Supabase Auth
 *   service (GoTrue), which validates the JWT **signature** against the
 *   project's keys and checks standard claims (expiry, audience, issuer)
 *   before returning the user. We deliberately do NOT implement a local
 *   base64 decode — decoding without signature verification would accept
 *   attacker-forged tokens.
 *
 * Output: a verified {@link AuthIdentity} plus the user-scoped Supabase
 * client (carrying the same verified token) for downstream data access.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createUserScopedClient } from './supabase.service.js';
import { normalizeAuthProvider } from '../../../shared/auth.js';
import type { AuthIdentity } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Authentication failure carrying an HTTP status for the error handler. */
export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Outcome of a successful verification. */
export interface VerifiedIdentity {
  identity: AuthIdentity;
  /** User-scoped Supabase client carrying the verified token. */
  client: SupabaseClient;
}

/**
 * Verify a raw access token and return the authenticated identity.
 *
 * @param accessToken Raw JWT from the `Authorization: Bearer <token>` header.
 * @throws {AuthError} 401 when the token is missing, malformed, invalid or
 *         expired. The message is intentionally generic so callers cannot
 *         use it as an oracle for valid tokens.
 */
export async function verifyAccessToken(accessToken: string): Promise<VerifiedIdentity> {
  if (!accessToken || accessToken.trim().length === 0) {
    throw new AuthError('Access token is missing.');
  }

  // Crude shape check so we never send obviously malformed input upstream.
  // (Real validation — signature + claims — happens at the auth server.)
  if (accessToken.split('.').length !== 3) {
    throw new AuthError('Access token is malformed.');
  }

  // User-scoped client for both verification and subsequent data access.
  const client = createUserScopedClient(accessToken);

  let user: {
    id: string;
    email?: string;
    app_metadata?: Record<string, unknown>;
  } | null = null;
  try {
    const { data, error } = await client.auth.getUser(accessToken);
    if (error || !data?.user) {
      // Covers invalid signature, expiry, revoked tokens, unknown users.
      throw new AuthError('Invalid or expired access token.');
    }
    user = data.user;
  } catch (err) {
    // Network failure talking to the auth server: fail closed (401).
    // It is safer to reject than to proceed with an unverified identity.
    if (err instanceof AuthError) throw err;
    throw new AuthError('Invalid or expired access token.');
  }

  return {
    identity: {
      userId: user.id,
      email: user.email,
      // Provider comes from the VERIFIED auth server response only —
      // it is never taken from headers, query params, or the body.
      provider: normalizeAuthProvider(user.app_metadata?.provider),
    },
    client,
  };
}
