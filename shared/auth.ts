/**
 * shared/auth.ts
 * --------------
 * Authentication constants shared by the backend and mirrored by the
 * frontend (client is a standalone build — see client/src/lib/oauth.ts,
 * whose value is regression-tested against this file).
 *
 * SCOPE SEPARATION (Milestone 3 security requirement):
 * - Google LOGIN requests ONLY the minimal identity scopes:
 *   `openid email profile`. That is what establishes the session.
 * - Additional Google capabilities (Gmail, Calendar, …) are SEPARATE
 *   permissions that must each be explicitly authorized by the user
 *   through their own consent flow. They are NEVER requested at login,
 *   never bundled silently, and nothing in this codebase calls a Gmail
 *   or Calendar API.
 *
 * `GOOGLE_EXTRA_SCOPES` is our canonical allow-list of future, explicitly
 * consensual integrations. The strings are OUR identifiers; they map to
 * real Google wire scopes only when a future consent flow is implemented.
 * Recording a grant (POST /api/integrations) stores the user's explicit
 * decision — it does NOT by itself grant any live Google access.
 */

import type { AuthProvider } from './types.js';

/** Minimal scopes for signing in with Google. Never extended silently. */
export const GOOGLE_LOGIN_SCOPES = 'openid email profile';

/**
 * Allow-list of additional (non-login) integrations a user may explicitly
 * authorize. Anything else is rejected by validation.
 */
export const GOOGLE_EXTRA_SCOPES = ['gmail.readonly', 'calendar.readonly'] as const;

export type GoogleExtraScope = (typeof GOOGLE_EXTRA_SCOPES)[number];

/** Type guard for the extra-scope allow-list. */
export function isAllowedExtraScope(value: string): value is GoogleExtraScope {
  return (GOOGLE_EXTRA_SCOPES as readonly string[]).includes(value);
}

/** The only OAuth integration currently modeled. */
export const SUPPORTED_INTEGRATIONS = ['google'] as const;

export type SupportedIntegration = (typeof SUPPORTED_INTEGRATIONS)[number];

export function isSupportedIntegration(value: string): value is SupportedIntegration {
  return (SUPPORTED_INTEGRATIONS as readonly string[]).includes(value);
}

/**
 * Normalize an auth-server-reported provider to this application's known
 * values ('email' | 'google'). Unknown/absent values fall back to 'email':
 * the database CHECK constraint accepts only these two, and this app only
 * enables email/password and Google sign-in.
 *
 * NEVER accepts client input — callers pass the verified auth server's
 * `app_metadata.provider` (or a trusted profile row).
 */
export function normalizeAuthProvider(value: unknown): AuthProvider {
  return value === 'google' ? 'google' : 'email';
}
