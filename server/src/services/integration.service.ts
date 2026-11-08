/**
 * services/integration.service.ts
 * -------------------------------
 * Explicit consent records for ADDITIONAL Google scopes (Milestone 3).
 *
 * SECURITY / SCOPE-SEPARATION INVARIANT:
 *   - Google LOGIN only ever requests `openid email profile`
 *     (shared/auth.ts GOOGLE_LOGIN_SCOPES). Nothing in this service is
 *     part of the login flow, and no Gmail/Calendar API is ever called.
 *   - A row here is an AUDIT RECORD of the user's explicit decision.
 *     Recording or revoking a grant performs zero Google API calls.
 *   - Scopes are validated against the allow-list in shared/auth.ts
 *     (also re-checked by the database CHECK constraint).
 *
 * SECURITY — same model as the other services: the user-scoped client +
 * the verified userId from `req.auth`; every statement carries an
 * explicit `.eq('user_id', userId)` filter on top of RLS.
 *
 * Semantics:
 *   - One row per (user, integration) — grant is an idempotent upsert.
 *   - Revoke clears `scopes` and stamps `revoked_at` (idempotent).
 *   - Never-granted integration → NOT_FOUND (404, no probing).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IntegrationGrant } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Error type so controllers can distinguish failure kinds
// ---------------------------------------------------------------------------

/** Integration-side failure. Messages are authored for clients. */
export class IntegrationServiceError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'IntegrationServiceError';
  }
}

export const INTEGRATION_NOT_FOUND = 'INTEGRATION_NOT_FOUND';

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Shape of an `integration_grants` row as returned by PostgREST. */
interface GrantRow {
  integration: string;
  scopes: string[];
  granted_at: string;
  revoked_at: string | null;
}

function toGrant(row: GrantRow): IntegrationGrant {
  return {
    integration: row.integration,
    scopes: Array.isArray(row.scopes) ? [...row.scopes] : [],
    granted_at: row.granted_at,
    revoked_at: row.revoked_at ?? null,
  };
}

async function selectGrant(
  client: SupabaseClient,
  userId: string,
  integration: string,
): Promise<GrantRow | null> {
  const { data, error } = await client
    .from('integration_grants')
    .select('*')
    .eq('user_id', userId)
    .eq('integration', integration)
    .maybeSingle();

  if (error) {
    throw new IntegrationServiceError(
      `Failed to fetch integration: ${error.message}`,
      error.code,
    );
  }
  return (data as GrantRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** List all integration grants belonging to the verified user. */
export async function listIntegrations(
  client: SupabaseClient,
  userId: string,
): Promise<IntegrationGrant[]> {
  const { data, error } = await client
    .from('integration_grants')
    .select('*')
    .eq('user_id', userId)
    .order('integration', { ascending: true });

  if (error) {
    throw new IntegrationServiceError(
      `Failed to list integrations: ${error.message}`,
      error.code,
    );
  }
  return ((data ?? []) as GrantRow[]).map(toGrant);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Record an EXPLICIT consent grant (idempotent per user+integration).
 * Re-granting replaces the scope set and clears any previous revocation.
 *
 * @returns the persisted grant plus `created: true` when a new row appeared.
 */
export async function grantIntegration(
  client: SupabaseClient,
  userId: string,
  integration: string,
  scopes: string[],
): Promise<{ grant: IntegrationGrant; created: boolean }> {
  // 1. UPDATE path — cheap when the row already exists (common case).
  const updated = await updateGrantRow(client, userId, integration, scopes);
  if (updated) return { grant: toGrant(updated), created: false };

  // 2. INSERT path — no row existed at step 1.
  const { data, error } = await client
    .from('integration_grants')
    .insert({ user_id: userId, integration, scopes })
    .select()
    .single();

  if (error) {
    // Race-safe: another request created the row between steps 1 and 2.
    // Re-run the update (bounded — never recurses into insert again).
    if (error.code === '23505') {
      const winner = await updateGrantRow(client, userId, integration, scopes);
      if (winner) return { grant: toGrant(winner), created: false };
      const row = await selectGrant(client, userId, integration);
      if (row) return { grant: toGrant(row), created: false };
    }
    throw new IntegrationServiceError(
      `Failed to record integration grant: ${error.message}`,
      error.code,
    );
  }
  if (!data) {
    throw new IntegrationServiceError('Grant creation returned no row.', 'INSERT_NO_ROW');
  }
  return { grant: toGrant(data as GrantRow), created: true };
}

/** Overwrite the scope set of an existing grant. null when no row matched. */
async function updateGrantRow(
  client: SupabaseClient,
  userId: string,
  integration: string,
  scopes: string[],
): Promise<GrantRow | null> {
  const { data, error } = await client
    .from('integration_grants')
    .update({ scopes, revoked_at: null })
    .eq('user_id', userId)
    .eq('integration', integration)
    .select()
    .maybeSingle();

  if (error) {
    throw new IntegrationServiceError(
      `Failed to update integration grant: ${error.message}`,
      error.code,
    );
  }
  return (data as GrantRow | null) ?? null;
}

/**
 * Revoke a previously granted integration: clears the scope set and
 * stamps `revoked_at`. IDEMPOTENT — revoking twice returns the same
 * revoked grant. Never granted → INTEGRATION_NOT_FOUND (404).
 */
export async function revokeIntegration(
  client: SupabaseClient,
  userId: string,
  integration: string,
): Promise<IntegrationGrant> {
  const existing = await selectGrant(client, userId, integration);
  if (!existing) {
    throw new IntegrationServiceError(
      'Integration has not been authorized.',
      INTEGRATION_NOT_FOUND,
    );
  }
  if (existing.revoked_at !== null) {
    return toGrant(existing); // already revoked → idempotent no-op
  }

  const { data, error } = await client
    .from('integration_grants')
    .update({ scopes: [], revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('integration', integration)
    .select()
    .maybeSingle();

  if (error) {
    throw new IntegrationServiceError(
      `Failed to revoke integration: ${error.message}`,
      error.code,
    );
  }
  if (!data) {
    throw new IntegrationServiceError(
      'Integration has not been authorized.',
      INTEGRATION_NOT_FOUND,
    );
  }
  return toGrant(data as GrantRow);
}
