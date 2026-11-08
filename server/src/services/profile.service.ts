/**
 * services/profile.service.ts
 * ---------------------------
 * Application profile (row in `public.users`) reads/writes — Milestone 3.
 *
 * SECURITY — same model as task.service.ts / reminder.service.ts:
 *   1. `client` — the user-scoped Supabase client created by the auth
 *      middleware (verified JWT → RLS applies), and
 *   2. `identity` — the verified AuthIdentity from `req.auth`, NEVER from
 *      the request body. Every statement filters on `.eq('id', userId)`.
 *
 * Profile contents:
 *   - `email` / `provider` come from verified auth data. Clients can
 *     update ONLY `display_name` (enforced by patchProfileSchema and by
 *     this service writing just that column).
 *   - If the profile row is missing (created before migration 0004, or a
 *     rare trigger gap), the API SELF-HEALS by inserting its OWN row
 *     (id = verified user id) — the `users_insert_own` RLS policy allows
 *     exactly this and nothing else.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeAuthProvider } from '../../../shared/auth.js';
import type { AuthIdentity, UserProfile } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Error type so controllers can distinguish failure kinds
// ---------------------------------------------------------------------------

/** Profile-side failure. Messages are authored for clients. */
export class ProfileServiceError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ProfileServiceError';
  }
}

export const PROFILE_NOT_FOUND = 'PROFILE_NOT_FOUND';

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Shape of a `public.users` row as returned by PostgREST. */
interface UserRow {
  id: string;
  email: string;
  provider: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string | null;
}

function toProfile(row: UserRow): UserProfile {
  return {
    id: row.id,
    email: row.email,
    provider: normalizeAuthProvider(row.provider),
    display_name: row.display_name ?? null,
    avatar_url: row.avatar_url ?? null,
    created_at: row.created_at ?? null,
  };
}

async function selectProfile(
  client: SupabaseClient,
  userId: string,
): Promise<UserProfile | null> {
  const { data, error } = await client
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw new ProfileServiceError(`Failed to fetch profile: ${error.message}`, error.code);
  }
  return data ? toProfile(data as UserRow) : null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Fetch the verified user's profile, self-healing a missing row.
 *
 * Self-heal: INSERT with `id` = verified userId only (RLS `users_insert_own`
 * enforces this at the database too). On a unique race (23505) the winner's
 * row is re-selected. Email comes from the verified identity — if even that
 * is absent there is nothing safe to insert, so PROFILE_NOT_FOUND is thrown.
 */
export async function getProfile(
  client: SupabaseClient,
  identity: AuthIdentity,
): Promise<UserProfile> {
  const existing = await selectProfile(client, identity.userId);
  if (existing) return existing;

  if (!identity.email) {
    throw new ProfileServiceError('Profile not found.', PROFILE_NOT_FOUND);
  }

  const { data, error } = await client
    .from('users')
    .insert({
      id: identity.userId,
      email: identity.email,
      provider: normalizeAuthProvider(identity.provider),
      display_name: null,
      avatar_url: null,
    })
    .select()
    .single();

  if (error) {
    // Race-safe: another request self-healed the same row first.
    if (error.code === '23505') {
      const winner = await selectProfile(client, identity.userId);
      if (winner) return winner;
    }
    throw new ProfileServiceError(`Failed to create profile: ${error.message}`, error.code);
  }

  if (!data) {
    throw new ProfileServiceError('Profile creation returned no row.', 'INSERT_NO_ROW');
  }
  return toProfile(data as UserRow);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Update the verified user's display name (the ONLY client-writable field).
 * Email/provider/id are never read from the request and never written here.
 */
export async function updateDisplayName(
  client: SupabaseClient,
  identity: AuthIdentity,
  displayName: string | null,
): Promise<UserProfile> {
  // Ensure the row exists first (self-heal path above).
  await getProfile(client, identity);

  const { data, error } = await client
    .from('users')
    .update({ display_name: displayName })
    .eq('id', identity.userId)
    .select()
    .maybeSingle();

  if (error) {
    throw new ProfileServiceError(`Failed to update profile: ${error.message}`, error.code);
  }
  if (!data) {
    // Row disappeared between the read and the update (or RLS blocked it).
    throw new ProfileServiceError('Profile not found.', PROFILE_NOT_FOUND);
  }
  return toProfile(data as UserRow);
}
