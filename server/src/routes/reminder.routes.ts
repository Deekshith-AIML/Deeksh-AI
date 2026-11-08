/**
 * routes/reminder.routes.ts
 * -------------------------
 * Route definitions for /api/reminders (Milestone 2).
 *
 * SECURITY: `requireAuth` is mounted at the router level so EVERY
 * endpoint requires a verified bearer token; handlers then scope all
 * queries to `req.auth.userId` (never to anything client-supplied).
 *
 * Endpoints:
 *   GET    /api/reminders          list (filter by status/scope)
 *   GET    /api/reminders/:id      detail (delivery status, failures)
 *   POST   /api/reminders          create (idempotency_key supported)
 *   PUT    /api/reminders/:id      reschedule a pending reminder
 *   DELETE /api/reminders/:id      cancel a pending reminder (soft)
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  listRemindersHandler,
  getReminderHandler,
  createReminderHandler,
  updateReminderHandler,
  cancelReminderHandler,
} from '../controllers/reminder.controller.js';

const router = Router();

// All reminder routes require authentication.
router.use(requireAuth);

router.get('/', listRemindersHandler);
router.get('/:id', getReminderHandler);
router.post('/', createReminderHandler);
router.put('/:id', updateReminderHandler);
router.delete('/:id', cancelReminderHandler);

export default router;
