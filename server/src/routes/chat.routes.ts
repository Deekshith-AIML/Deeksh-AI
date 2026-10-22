/**
 * routes/chat.routes.ts
 * ---------------------
 * Route definitions for /api/chat.
 *
 * SECURITY: requires a verified bearer token; the authenticated identity
 * (not the request body) determines which user's messages/tasks are used.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { chatHandler } from '../controllers/chat.controller.js';

const router = Router();

// Chat requires authentication.
router.use(requireAuth);

router.post('/', chatHandler);

export default router;
