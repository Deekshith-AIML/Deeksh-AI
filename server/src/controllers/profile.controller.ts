/**
 * controllers/profile.controller.ts
 * ---------------------------------
 * REST handlers for the signed-in user's profile (Milestone 3).
 *
 * SECURITY: identity comes exclusively from `getAuth(req)` — the verified
 * value set by the auth middleware. The request body is validated with
 * `patchProfileSchema`, which only accepts `display_name`; `email`,
 * `provider`, and `id` sent by clients are stripped by Zod and can never
 * influence what is written.
 *
 * Status mapping:
 *   400 invalid payload
 *   401 missing/invalid token (handled by requireAuth)
 *   404 profile missing (cannot be self-healed — no verified email)
 */

import type { Request, Response, NextFunction } from 'express';
import { patchProfileSchema } from '../../../shared/schemas.js';
import * as profileService from '../services/profile.service.js';
import { getAuth, getDb } from '../middleware/auth.middleware.js';

/** Map service error codes to HTTP statuses. */
function statusFor(err: profileService.ProfileServiceError): number {
  switch (err.code) {
    case profileService.PROFILE_NOT_FOUND:
      return 404;
    default:
      return 500;
  }
}

// ---------------------------------------------------------------------------
// GET /api/me
// ---------------------------------------------------------------------------

export async function getMeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const identity = getAuth(req);
    const db = getDb(req);

    const user = await profileService.getProfile(db, identity);
    res.status(200).json({ user });
  } catch (err) {
    if (err instanceof profileService.ProfileServiceError) {
      const status = statusFor(err);
      if (status !== 500) {
        res.status(status).json({ error: err.message });
        return;
      }
    }
    next(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/me  (display name only)
// ---------------------------------------------------------------------------

export async function updateMeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const identity = getAuth(req);
    const db = getDb(req);

    const parsed = patchProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid profile payload', details: parsed.error.flatten() });
      return;
    }

    const user = await profileService.updateDisplayName(
      db,
      identity,
      parsed.data.display_name,
    );
    res.status(200).json({ user });
  } catch (err) {
    if (err instanceof profileService.ProfileServiceError) {
      const status = statusFor(err);
      if (status !== 500) {
        res.status(status).json({ error: err.message });
        return;
      }
    }
    next(err);
  }
}
