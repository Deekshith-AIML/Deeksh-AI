/**
 * src/store/useAuthStore.ts
 * -------------------------
 * Zustand store for Supabase Auth session state and sign-in/up/out flows.
 *
 * - `initialize()` subscribes to Supabase auth events once and resolves
 *   the current session (loading → authenticated / unauthenticated).
 * - Sign-in/sign-up surface Supabase errors verbatim so auth problems are
 *   clearly visible to the user (never swallowed).
 * - The backend never receives this identity directly: the Axios
 *   interceptor attaches the access token, and the server derives the
 *   user id from the verified token.
 */

'use client';

import { create } from 'zustand';
import { getSupabase } from '@/lib/supabase';
import { buildGoogleLogin } from '@/lib/oauth';
import type { User } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthState {
  /** Session lifecycle state used by the route guard. */
  status: AuthStatus;
  /** Supabase user object of the signed-in user (null when signed out). */
  user: User | null;
  /** Last auth-related error message for display. */
  error: string | null;
  /** Informational message (e.g. "confirm your email" after sign-up). */
  notice: string | null;
  /** True while an auth request is in flight (button spinners). */
  isSubmitting: boolean;

  /** Subscribe to auth state changes and resolve the initial session. Idempotent. */
  initialize: () => void;
  /** Email + password sign-in. Returns true on success. */
  signIn: (email: string, password: string) => Promise<boolean>;
  /** Email + password sign-up. Returns true on success (may require email confirmation). */
  signUp: (email: string, password: string) => Promise<boolean>;
  /**
   * Start the Google OAuth login (identity scopes only — never Gmail or
   * Calendar). The browser redirects to Google and back to /auth/callback.
   */
  signInWithGoogle: () => Promise<void>;
  /** Sign out locally (and revoke the Supabase session). */
  signOut: () => Promise<void>;
  /** Clear the displayed error. */
  clearError: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map Supabase Auth errors to readable, user-facing messages. */
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Incorrect email or password.';
  if (m.includes('email not confirmed')) return 'Please confirm your email address first.';
  if (m.includes('already registered')) return 'An account with this email already exists.';
  if (m.includes('password should be at least')) return 'Password must be at least 6 characters.';
  if (m.includes('rate limit')) return 'Too many attempts. Please wait and try again.';
  return message;
}

let initialized = false;

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  user: null,
  error: null,
  notice: null,
  isSubmitting: false,

  initialize: () => {
    // Only ever subscribe once (React StrictMode double-invokes effects).
    if (initialized) return;
    initialized = true;

    try {
      const supabase = getSupabase();

      // Resolve the existing session (also refreshes an expired one).
      supabase.auth
        .getSession()
        .then(({ data, error }) => {
          if (error) {
            set({ status: 'unauthenticated', error: friendlyAuthError(error.message) });
            return;
          }
          const session = data.session;
          set(
            session
              ? { status: 'authenticated', user: session.user }
              : { status: 'unauthenticated', user: null },
          );
        })
        .catch((err: unknown) => {
          set({
            status: 'unauthenticated',
            error: err instanceof Error ? err.message : 'Failed to initialize authentication.',
          });
        });

      // React to future auth events (token refresh, sign-out, sign-in).
      supabase.auth.onAuthStateChange((_event, session) => {
        set(
          session
            ? { status: 'authenticated', user: session.user, error: null }
            : { status: 'unauthenticated', user: null },
        );
      });
    } catch (err) {
      // Supabase env not configured — fail visibly to an unauthenticated state.
      set({
        status: 'unauthenticated',
        error: err instanceof Error ? err.message : 'Authentication is unavailable.',
      });
    }
  },

  signIn: async (email, password) => {
    set({ isSubmitting: true, error: null, notice: null });
    try {
      const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
      if (error) {
        set({ isSubmitting: false, error: friendlyAuthError(error.message) });
        return false;
      }
      set({
        isSubmitting: false,
        status: data.session ? 'authenticated' : 'unauthenticated',
        user: data.session?.user ?? null,
      });
      return Boolean(data.session);
    } catch (err) {
      set({
        isSubmitting: false,
        error: err instanceof Error ? err.message : 'Sign-in failed.',
      });
      return false;
    }
  },

  signUp: async (email, password) => {
    set({ isSubmitting: true, error: null, notice: null });
    try {
      const { data, error } = await getSupabase().auth.signUp({ email, password });
      if (error) {
        set({ isSubmitting: false, error: friendlyAuthError(error.message) });
        return false;
      }

      // Email confirmation enabled → no session yet; tell the user.
      if (!data.session) {
        set({
          isSubmitting: false,
          status: 'unauthenticated',
          user: null,
          notice: 'Account created. Check your inbox to confirm your email, then sign in.',
        });
        return true;
      }

      set({ isSubmitting: false, status: 'authenticated', user: data.user });
      return true;
    } catch (err) {
      set({
        isSubmitting: false,
        error: err instanceof Error ? err.message : 'Sign-up failed.',
      });
      return false;
    }
  },

  signInWithGoogle: async () => {
    set({ isSubmitting: true, error: null, notice: null });
    try {
      const supabase = getSupabase();
      // Same-origin callback only — buildGoogleLogin derives it from the
      // current origin (no open redirect). Scopes are identity-only.
      const { provider, options } = buildGoogleLogin(window.location.origin);
      const { error } = await supabase.auth.signInWithOAuth({ provider, options });
      if (error) {
        // Redirect did not start — surface the reason instead of hanging.
        set({ isSubmitting: false, error: friendlyAuthError(error.message) });
      }
      // On success the browser navigates away; isSubmitting stays true.
    } catch (err) {
      set({
        isSubmitting: false,
        error: err instanceof Error ? err.message : 'Google sign-in failed.',
      });
    }
  },

  signOut: async () => {
    try {
      await getSupabase().auth.signOut();
    } finally {
      // Local state is also updated by the onAuthStateChange listener.
      set({ status: 'unauthenticated', user: null, notice: null, error: null });
    }
  },

  clearError: () => set({ error: null }),
}));
