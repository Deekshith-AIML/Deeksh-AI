/**
 * src/lib/supabase.ts
 * -------------------
 * Supabase browser client (email/password Auth).
 *
 * Configuration uses only PUBLIC values:
 *   - NEXT_PUBLIC_SUPABASE_URL       — project URL
 *   - NEXT_PUBLIC_SUPABASE_ANON_KEY  — anon/publishable key
 * The service-role key and the AI provider (Gemini) API key must NEVER appear in
 * frontend code or NEXT_PUBLIC_* variables.
 *
 * The client is created lazily so that `next build` succeeds even when
 * env vars are absent; a clear error surfaces at runtime instead.
 */

'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/**
 * Return the shared Supabase browser client.
 * @throws Descriptive error when env configuration is missing.
 */
export function getSupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY in client/.env.local (see .env.example).',
    );
  }

  client = createClient(url, anonKey, {
    auth: {
      // Browser session persistence (localStorage) with automatic token
      // refresh; getSession() transparently refreshes expired sessions.
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      // PKCE for every OAuth flow (Google login): supabase-js stores the
      // code_verifier at login time and validates `state` + the verifier
      // when the callback URL's code is exchanged — this is the OAuth
      // state validation for our redirect flow.
      flowType: 'pkce',
    },
  });

  return client;
}
