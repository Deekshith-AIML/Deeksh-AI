/**
 * server/src/types/express.d.ts
 * -----------------------------
 * Express request augmentation.
 *
 * `requireAuth` populates `auth` and `supabase` on every protected request.
 * Handlers must obtain them through `getAuth(req)` / `getDb(req)` (which
 * throw a 401 if a handler was mounted without the middleware) rather than
 * trusting any client-supplied identity.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthIdentity } from '../../../shared/types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Verified identity from the bearer token. Set by `requireAuth`. */
      auth?: AuthIdentity;
      /**
       * Per-request Supabase client carrying the verified user's JWT.
       * Row Level Security therefore applies to every query, in addition to
       * the explicit `user_id` filters in the service layer.
       */
      supabase?: SupabaseClient;
    }
  }
}

export {};
