/**
 * src/lib/oauth.ts
 * ----------------
 * Google OAuth constants and helpers for the LOGIN flow (Milestone 3).
 *
 * SCOPE SEPARATION (security requirement):
 *   - Google login requests ONLY `openid email profile` — the minimal
 *     identity scopes needed to establish a session.
 *   - Gmail/Calendar permissions are SEPARATE, additional scopes that
 *     require their own explicit user consent (never requested here,
 *     never bundled into login).
 *
 * This file mirrors `shared/auth.ts`. Because the client build does not
 * import the shared package directly, the values are regression-tested
 * against shared/auth.ts in server/tests/oauth-callback.test.ts so the
 * two copies can never silently drift.
 */

'use client';

/** Minimal scopes for signing in with Google. Never extended silently. */
export const GOOGLE_LOGIN_SCOPES = 'openid email profile';

/**
 * Allow-list of additional (non-login) integrations a user may explicitly
 * authorize through their own consent flow. Never part of login.
 */
export const GOOGLE_EXTRA_SCOPES = ['gmail.readonly', 'calendar.readonly'] as const;

/** The only OAuth integration currently modeled. */
export const SUPPORTED_INTEGRATIONS = ['google'] as const;

/** Path the Google redirect returns to (same-origin, built from origin). */
export const OAUTH_CALLBACK_PATH = '/auth/callback';

/** Result of building the Google sign-in request for supabase-js. */
export interface GoogleLoginRequest {
  provider: 'google';
  options: {
    /** Identity scopes only — see GOOGLE_LOGIN_SCOPES. */
    scopes: string;
    /** Same-origin callback URL (never an external/attacker host). */
    redirectTo: string;
  };
}

/**
 * Build the Google login request.
 *
 * @param origin The page origin (e.g. `window.location.origin`). The
 *               callback URL is derived from it, so an attacker-supplied
 *               absolute URL can never be smuggled in as a redirect
 *               target (no open redirect).
 */
export function buildGoogleLogin(origin: string): GoogleLoginRequest {
  return {
    provider: 'google',
    options: {
      scopes: GOOGLE_LOGIN_SCOPES,
      redirectTo: `${origin.replace(/\/+$/, '')}${OAUTH_CALLBACK_PATH}`,
    },
  };
}
