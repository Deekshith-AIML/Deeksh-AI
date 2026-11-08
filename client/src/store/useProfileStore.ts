/**
 * src/store/useProfileStore.ts
 * ----------------------------
 * Zustand store for the signed-in user's profile and Google integration
 * permission records (Milestone 3).
 *
 * - `fetchProfile()` loads `GET /api/me` (the backend self-heals a
 *   missing profile row; identity comes from the bearer token).
 * - `updateDisplayName()` calls `PATCH /api/me` — the ONLY writable field.
 *   Email/provider/id are displayed read-only and never sent.
 * - `fetchIntegrations()` / `revokeIntegration()` manage EXPLICIT consent
 *   records for additional Google scopes (never part of login).
 *
 * Errors are surfaced (never swallowed); the Axios 401 interceptor signs
 * out and redirects on revoked/invalid sessions before these handlers run.
 */

'use client';

import { create } from 'zustand';
import api from '@/lib/api';
import type { IntegrationGrant, UserProfile } from '@/types';

type ProfileStatus = 'idle' | 'loading' | 'loaded' | 'error';

interface ProfileState {
  /** The signed-in user's profile (null until loaded). */
  profile: UserProfile | null;
  /** Additional-scope Google grants for this user. */
  integrations: IntegrationGrant[];
  /** Load state for the profile fetch. */
  status: ProfileStatus;
  /** Last error message (profile/integrations operations). */
  error: string | null;
  /** True while a mutation is in flight (button spinners). */
  isSaving: boolean;

  /** Fetch the profile + integrations. Idempotent (safe to call on menu open). */
  fetch: () => Promise<void>;
  /** Update the display name (null clears it). Returns true on success. */
  updateDisplayName: (displayName: string | null) => Promise<boolean>;
  /** Revoke an integration grant (idempotent server-side). */
  revokeIntegration: (integration: string) => Promise<boolean>;
  /** Clear local state on sign-out. */
  reset: () => void;
}

/** Extract a safe message from an Axios/API failure. */
function messageFrom(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const response = (err as { response?: { data?: { error?: string } } }).response;
    if (response?.data?.error) return response.data.error;
  }
  return err instanceof Error ? err.message : fallback;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profile: null,
  integrations: [],
  status: 'idle',
  error: null,
  isSaving: false,

  fetch: async () => {
    if (get().status === 'loading') return;
    set({ status: 'loading', error: null });
    try {
      const [meRes, integrationsRes] = await Promise.all([
        api.get('/me'),
        api.get('/integrations'),
      ]);
      set({
        profile: meRes.data.user,
        integrations: integrationsRes.data.integrations ?? [],
        status: 'loaded',
      });
    } catch (err) {
      set({ status: 'error', error: messageFrom(err, 'Failed to load your profile.') });
    }
  },

  updateDisplayName: async (displayName) => {
    set({ isSaving: true, error: null });
    try {
      const res = await api.patch('/me', { display_name: displayName });
      set({ profile: res.data.user, isSaving: false });
      return true;
    } catch (err) {
      set({
        isSaving: false,
        error: messageFrom(err, 'Failed to update your display name.'),
      });
      return false;
    }
  },

  revokeIntegration: async (integration) => {
    set({ isSaving: true, error: null });
    try {
      const res = await api.delete(`/integrations/${encodeURIComponent(integration)}`);
      const updated: IntegrationGrant = res.data.integration;
      set({
        integrations: get().integrations.map((g) =>
          g.integration === updated.integration ? updated : g,
        ),
        isSaving: false,
      });
      return true;
    } catch (err) {
      set({
        isSaving: false,
        error: messageFrom(err, 'Failed to revoke the permission.'),
      });
      return false;
    }
  },

  reset: () =>
    set({ profile: null, integrations: [], status: 'idle', error: null, isSaving: false }),
}));
