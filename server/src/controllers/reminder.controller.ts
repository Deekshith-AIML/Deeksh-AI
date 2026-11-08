/**
 * controllers/reminder.controller.ts
 * ----------------------------------
 * REST handlers for reminder CRUD (Milestone 2).
 *
 * SECURITY: identity comes exclusively from `getAuth(req)` — the verified
 * value set by the auth middleware. Request bodies are validated with Zod;
 * any `user_id` a client sends is stripped (non-strict object) and can
 * never influence ownership. Every service call receives the user-scoped
 * client + the verified userId, so RLS and the explicit filter both apply.
 *
 * Status mapping:
 *   400 invalid payload / invalid or past reminder time
 *   401 missing/invalid token (handled by requireAuth)
 *   404 reminder missing OR owned by another user (indistinguishable)
 *   409 state conflict (editing/cancelling a non-pending reminder)
 */

import type { Request, Response, NextFunction } from 'express';
import {
  createReminderSchema,
  updateReminderSchema,
  reminderIdParamSchema,
  listRemindersQuerySchema,
} from '../../../shared/schemas.js';
import * as reminderService from '../services/reminder.service.js';
import { getAuth, getDb } from '../middleware/auth.middleware.js';
import type { Reminder } from '../../../shared/types.js';

/** Map service error codes to HTTP statuses. */
function statusFor(err: reminderService.ReminderServiceError): number {
  switch (err.code) {
    case reminderService.REMINDER_NOT_FOUND:
      return 404;
    case reminderService.REMINDER_CONFLICT:
      return 409;
    case reminderService.REMINDER_INVALID_TIME:
      return 400;
    default:
      return 500;
  }
}

// ---------------------------------------------------------------------------
// GET /api/reminders
// ---------------------------------------------------------------------------

export async function listRemindersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const parsed = listRemindersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
      return;
    }

    const reminders = await reminderService.listReminders(db, userId, parsed.data);
    res.status(200).json({ reminders });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/reminders/:id
// ---------------------------------------------------------------------------

export async function getReminderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const params = reminderIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: 'Invalid reminder id' });
      return;
    }

    // null for both "missing" and "someone else's" → 404 either way.
    const reminder = await reminderService.getReminderById(db, userId, params.data.id);
    if (!reminder) {
      res.status(404).json({ error: 'Reminder not found' });
      return;
    }

    res.status(200).json({ reminder });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/reminders
// ---------------------------------------------------------------------------

export async function createReminderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const parsed = createReminderSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid reminder payload', details: parsed.error.flatten() });
      return;
    }

    // Idempotent creation: a repeated post with the same key returns the
    // EXISTING reminder with 200 instead of creating a duplicate (201).
    const { reminder, created } = await reminderService.createReminder(
      db,
      userId,
      parsed.data,
    );
    res.status(created ? 201 : 200).json({ reminder, created });
  } catch (err) {
    if (err instanceof reminderService.ReminderServiceError) {
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
// PUT /api/reminders/:id  (reschedule a pending reminder)
// ---------------------------------------------------------------------------

export async function updateReminderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const params = reminderIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: 'Invalid reminder id' });
      return;
    }

    const parsed = updateReminderSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid reminder payload', details: parsed.error.flatten() });
      return;
    }

    const reminder = await reminderService.updateReminder(
      db,
      userId,
      params.data.id,
      parsed.data,
    );
    res.status(200).json({ reminder });
  } catch (err) {
    if (err instanceof reminderService.ReminderServiceError) {
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
// DELETE /api/reminders/:id  (cancel a pending reminder — soft delete)
// ---------------------------------------------------------------------------

export async function cancelReminderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const params = reminderIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: 'Invalid reminder id' });
      return;
    }

    const reminder: Reminder = await reminderService.cancelReminder(
      db,
      userId,
      params.data.id,
    );
    res.status(200).json({ reminder });
  } catch (err) {
    if (err instanceof reminderService.ReminderServiceError) {
      const status = statusFor(err);
      if (status !== 500) {
        res.status(status).json({ error: err.message });
        return;
      }
    }
    next(err);
  }
}
