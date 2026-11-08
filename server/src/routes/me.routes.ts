/**
 * routes/me.routes.ts
 * --------------------
 * Route definitions for /api/me — the signed-in user's profile
 * (Milestone 3).
 *
 * SECURITY: `requireAuth` is mounted at the router level so EVERY
 * endpoint requires a verified bearer token; handlers scope all reads
 * and writes to `req.auth` (never to anything client-supplied).
 *
 * Endpoints:
 *   GET   /api/me   current profile (self-heals a missing row)
 *   PATCH /api/me   update display_name ONLY (email/provider/id are
 *                   stripped from the body and never writable)
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { getMeHandler, updateMeHandler } from '../controllers/profile.controller.js';

const router = Router();

// All profile routes require authentication.
router.use(requireAuth);

router.get('/', getMeHandler);
router.patch('/', updateMeHandler);

export default router;
