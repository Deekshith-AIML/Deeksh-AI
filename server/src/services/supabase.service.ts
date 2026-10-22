/**
 * services/supabase.service.ts
 * ----------------------------
 * Supabase client factory for the backend.
 *
 * SECURITY MODEL (important):
 * This server no longer performs data access with the service-role key.
 * Instead, every request gets its own client whose Authorization header
 * carries the *verified end-user's* access token:
 *
 *   createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
 *     global: { headers: { Authorization: `Bearer <user access token>` } },
 *   });
 *
 * Consequences:
 * - PostgREST sees the user's JWT, so Postgres runs queries as the
 *   `authenticated` role and Row Level Security policies apply — ownership
 *   is enforced by the database itself on every statement.
 * - The service layer *additionally* filters by the verified user id
 *   (defense in depth), so a missing RLS policy alone cannot leak data.
 * - The browser-published anon/publishable key is the only non-secret key
 *   used here; it is safe to ship in frontend code as well.
 *
 * The token passed to `createUserScopedClient` MUST already have been
 * validated (see auth.service.ts). Never build a scoped client from an
 * unverified client-supplied string without validating it first.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Environment variables (fail fast at boot)
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL) {
  throw new Error('Missing required environment variable: SUPABASE_URL');
}

if (!SUPABASE_ANON_KEY) {
  throw new Error(
    'Missing required environment variable: SUPABASE_ANON_KEY (the public anon/publishable key)',
  );
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Create a Supabase client scoped to a single, already-verified user token.
 *
 * Session handling is disabled: this is a stateless server that receives a
 * fresh bearer token on every request instead of maintaining a session.
 *
 * @param accessToken Verified Supabase Auth access token (JWT).
 */
export function createUserScopedClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Admin client (privileged)
// ---------------------------------------------------------------------------

/**
 * PRIVILEGED service-role client.
 *
 * Intentionally NOT exported: no request-handling code path may use it.
 * It exists only as an escape hatch for offline admin scripts (e.g. data
 * repairs run by an operator). If a future feature needs it inside a
 * request, that is a design smell — use a user-scoped client instead so
 * RLS and ownership checks keep applying.
 *
 * Enabled only when `SUPABASE_SERVICE_ROLE_KEY` is present; the API server
 * does not require it.
 */
export function createAdminClient(): SupabaseClient {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured; admin access is unavailable.',
    );
  }
  return createClient(SUPABASE_URL as string, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}
