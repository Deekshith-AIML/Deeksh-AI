/**
 * src/lib/api.ts
 * --------------
 * Pre-configured Axios instance pointing at the backend API.
 *
 * SECURITY:
 * - Every request attaches `Authorization: Bearer <access_token>` from the
 *   current Supabase session. The token is fetched per-request (with
 *   automatic refresh of expired sessions) rather than cached in module
 *   state, so a refresh or sign-out takes effect immediately.
 * - The hard-coded demo `x-user-id` header has been REMOVED — the backend
 *   no longer reads it and would ignore it. Identity is server-side only.
 * - A 401 response (expired/revoked token) clears the local session and
 *   redirects to the sign-in page instead of looping.
 */

import axios, { type InternalAxiosRequestConfig } from 'axios';
import { getSupabase } from './supabase';

/** Backend API base URL. Override with NEXT_PUBLIC_API_URL for deployments. */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';

/** Shared Axios instance used by all Zustand stores. */
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 60_000, // AI responses can take a while
  headers: {
    'Content-Type': 'application/json',
  },
});

// ---------------------------------------------------------------------------
// Request interceptor — attach the current access token
// ---------------------------------------------------------------------------

api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  try {
    // getSession() returns the persisted session and refreshes it if
    // expired, so the token we attach is always a valid one.
    const { data } = await getSupabase().auth.getSession();
    const token = data.session?.access_token;
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // Not configured / no session: send the request without a token; the
    // backend will answer 401 and the response interceptor handles it.
  }
  return config;
});

// ---------------------------------------------------------------------------
// Response interceptor — normalize errors, handle 401 (session expiry)
// ---------------------------------------------------------------------------

/** True when the browser is already on the login page (avoids redirect loops). */
function onLoginPage(): boolean {
  return typeof window !== 'undefined' && window.location.pathname === '/login';
}

api.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (axios.isAxiosError(error)) {
      // Session expired or token revoked → clear it and force re-login.
      if (error.response?.status === 401 && typeof window !== 'undefined' && !onLoginPage()) {
        try {
          await getSupabase().auth.signOut();
        } catch {
          // Best effort — still redirect below.
        }
        // Full navigation (not router.push) so all in-memory stores reset.
        window.location.assign('/login?reason=session_expired');
        // Return a never-resolving promise to halt downstream handling
        // while the navigation starts.
        return new Promise(() => {});
      }

      // Prefer the backend's `{ error: string }` envelope when present.
      const serverMessage = (error.response?.data as { error?: string } | undefined)?.error;
      const message = serverMessage ?? error.message ?? 'Network error';
      return Promise.reject(new Error(message));
    }
    return Promise.reject(new Error('An unexpected error occurred'));
  },
);

export default api;
