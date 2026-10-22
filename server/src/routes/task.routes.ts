/**
 * routes/task.routes.ts
 * ---------------------
 * Route definitions for /api/tasks.
 *
 * SECURITY: `requireAuth` is mounted at the router level so every task
 * endpoint (list, get, create, update, delete) requires a verified bearer
 * token. Handlers additionally scope all queries to `req.auth.userId`.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  listTasksHandler,
  getTaskHandler,
  createTaskHandler,
  updateTaskHandler,
  deleteTaskHandler,
} from '../controllers/task.controller.js';

const router = Router();

// All task routes require authentication.
router.use(requireAuth);

router.get('/', listTasksHandler);
router.get('/:id', getTaskHandler);
router.post('/', createTaskHandler);
router.put('/:id', updateTaskHandler);
router.delete('/:id', deleteTaskHandler);

export default router;
