/**
 * middleware/auth.middleware.ts
 * -----------------------------
 * Express middleware that authenticates every protected API request.
 *
 * Extracts `Authorization: Bearer <access_token>`, verifies it through the
 * Supabase Auth service (signature + claims — see auth.service.ts), then
 * attaches:
 *   - `req.auth`   → verified AuthIdentity (userId/email)
 *   - `req.supabase` → user-scoped Supabase client carrying the same token,
 *                      so Row Level Security applies to every query.
 *
 * Client-supplied identity vectors (`x-user-id` header, `?user_id=` query
 * param, body `user_id`, AI-generated ids) are NEVER consulted.
 *
 * Rejections:
 *   - 401 missing header / malformed header / invalid / expired token
 *   - 403 is intentionally not used: we don't distinguish "wrong user"
 *     from "no user", which avoids leaking whether an account exists.
 */

import type { Request, Response, NextFunction } from 'express';
import { AuthError, verifyAccessToken } from '../services/auth.service.js';
import type { AuthIdentity } from '../../../shared/types.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Parse the Authorization header.
 * Strictly accepts `Bearer <token>` (case-insensitive scheme).
 * Returns undefined for missing/malformed values.
 */
export function extractBearerToken(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const match = /^Bearer[ ]+(\S+)$/i.exec(headerValue.trim());
  return match?.[1];
}

/** Express middleware enforcing authentication on protected routes. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearerToken(req.header('authorization'));

    if (!token) {
      throw new AuthError(
        'Authentication required. Provide a valid "Authorization: Bearer <token>" header.',
      );
    }

    const { identity, client } = await verifyAccessToken(token);

    // Attach verified context for downstream handlers.
    req.auth = identity;
    req.supabase = client;

    next();
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    // Unexpected failures: fail closed with 401 rather than exposing details.
    res.status(401).json({ error: 'Invalid or expired access token.' });
  }
}

// ---------------------------------------------------------------------------
// Accessors for handlers
// ---------------------------------------------------------------------------

/**
 * Get the verified identity inside a handler.
 * Throws 401 if the route was mounted without `requireAuth` — a programming
 * error that must never silently fall back to trusting request input.
 */
export function getAuth(req: Request): AuthIdentity {
  if (!req.auth) {
    throw new AuthError('Authentication required.');
  }
  return req.auth;
}

/** Get the user-scoped Supabase client for a request (see getAuth). */
export function getDb(req: Request): SupabaseClient {
  if (!req.supabase) {
    throw new AuthError('Authentication required.');
  }
  return req.supabase;
}
