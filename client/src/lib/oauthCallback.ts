/**
 * src/lib/oauthCallback.ts
 * ------------------------
 * Pure classification of an OAuth redirect's query parameters
 * (Milestone 3). No DOM, no Supabase calls — fully unit-testable.
 *
 * What it validates:
 *   - `error` params take precedence over `code` (a failed response can
 *     never be mistaken for success);
 *   - `access_denied` → `denied` (user pressed "Cancel");
 *   - any other `error` → `invalid`;
 *   - `code` must be present, non-empty, within a sane length, and match
 *     a conservative URL-safe charset before we hand it to the token
 *     exchange;
 *   - `error_description` is attacker-controllable URL input — it is
 *     sanitized (control characters stripped, whitespace collapsed,
 *     length capped) before any UI renders it.
 *
 * STATE / PKCE VALIDATION: performed by supabase-js during
 * `exchangeCodeForSession` (PKCE `code_verifier` stored at login time +
 * `state` match). This module only classifies; it never accepts a
 * session by itself.
 */

/** Outcome of parsing the OAuth callback query string. */
export type OAuthCallbackResult =
  | { kind: 'success'; code: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'invalid'; reason: string };

/** Authorization codes: URL-safe charset, bounded length. */
const CODE_PATTERN = /^[A-Za-z0-9._~-]+$/;
const MAX_CODE_LENGTH = 2048;
const MAX_REASON_LENGTH = 200;

const DENIED_FALLBACK = 'The request was denied.';
const INVALID_FALLBACK = 'The sign-in request could not be completed.';

/**
 * Sanitize an error description coming from the URL before display.
 * Strips control characters (incl. newlines used for UI spoofing),
 * collapses whitespace, and caps the length.
 */
export function sanitizeOAuthError(
  value: string | null | undefined,
  fallback: string,
): string {
  if (!value) return fallback;
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, MAX_REASON_LENGTH);
}

/**
 * Classify OAuth callback parameters.
 *
 * @param params The redirect URL's query string.
 */
export function parseOAuthCallback(params: URLSearchParams): OAuthCallbackResult {
  // 1. Errors win: a failed response must never be treated as success.
  const error = params.get('error');
  if (error !== null && error !== '') {
    const reason = sanitizeOAuthError(
      params.get('error_description'),
      error === 'access_denied' ? DENIED_FALLBACK : INVALID_FALLBACK,
    );
    if (error === 'access_denied') return { kind: 'denied', reason };
    return { kind: 'invalid', reason };
  }

  // 2. Otherwise a well-formed authorization code is required.
  const code = params.get('code');
  if (code === null || code.length === 0) {
    return { kind: 'invalid', reason: 'Missing authorization code.' };
  }
  if (code.length > MAX_CODE_LENGTH || !CODE_PATTERN.test(code)) {
    return { kind: 'invalid', reason: 'Invalid authorization code.' };
  }

  return { kind: 'success', code };
}
