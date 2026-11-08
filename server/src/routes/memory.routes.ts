/**
 * routes/memory.routes.ts
 * -----------------------
 * Memory endpoints (Milestone 4 — additive).
 *
 * SECURITY: `requireAuth` is the first middleware on every route; the
 * authenticated identity (never the request body) scopes all queries.
 * `/settings` is registered BEFORE `/:id` so it can't be shadowed.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  listMemories,
  createMemoryHandler,
  searchMemoriesHandler,
  getMemoryByIdHandler,
  updateMemoryHandler,
  deleteMemoryHandler,
  supersedeMemoryHandler,
  getMemorySettingsHandler,
  updateMemorySettingsHandler,
} from '../controllers/memory.controller.js';

const router = Router();

// Authentication is enforced for every memory route.
router.use(requireAuth);

router.get('/settings', getMemorySettingsHandler);
router.patch('/settings', updateMemorySettingsHandler);

router.get('/', listMemories);
router.post('/', createMemoryHandler);
router.post('/search', searchMemoriesHandler);

router.get('/:id', getMemoryByIdHandler);
router.patch('/:id', updateMemoryHandler);
router.delete('/:id', deleteMemoryHandler);
router.post('/:id/supersede', supersedeMemoryHandler);

export default router;
