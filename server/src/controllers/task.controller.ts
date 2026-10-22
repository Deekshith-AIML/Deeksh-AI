/**
 * controllers/task.controller.ts
 * ------------------------------
 * REST handlers for CRUD operations on tasks.
 *
 * SECURITY: identity comes exclusively from `getAuth(req)` — the verified
 * value set by the auth middleware. The previous `resolveUserId()` helper
 * (which trusted the `x-user-id` header, `?user_id=` query, and body
 * fields) has been removed; none of those vectors are consulted anymore.
 * Bodies/queries are additionally validated with Zod before reaching the
 * service layer, which always receives the user-scoped client.
 */

import type { Request, Response, NextFunction } from 'express';
import {
  createTaskSchema,
  updateTaskSchema,
  taskIdParamSchema,
  listTasksQuerySchema,
} from '../../../shared/schemas.js';
import * as taskService from '../services/task.service.js';
import { getAuth, getDb } from '../middleware/auth.middleware.js';
import type { Task } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// GET /api/tasks
// ---------------------------------------------------------------------------

export async function listTasksHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const parsedQuery = listTasksQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: 'Invalid query parameters', details: parsedQuery.error.flatten() });
      return;
    }

    const tasks: Task[] = await taskService.listTasks(db, userId, parsedQuery.data);
    res.status(200).json({ tasks });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/tasks/:id
// ---------------------------------------------------------------------------

export async function getTaskHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const params = taskIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: 'Invalid task id', details: params.error.flatten() });
      return;
    }

    // Returns null both when the task does not exist and when it belongs to
    // another user — both are 404, so ids cannot be probed across accounts.
    const task = await taskService.getTaskById(db, userId, params.data.id);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.status(200).json({ task });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/tasks
// ---------------------------------------------------------------------------

export async function createTaskHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const parsed = createTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid task payload', details: parsed.error.flatten() });
      return;
    }

    // `parsed.data` contains only validated task fields; even if a client
    // sends `user_id` in the body it is stripped by Zod, and ownership is
    // set from the verified identity below.
    const task = await taskService.createTask(db, userId, parsed.data);
    res.status(201).json({ task });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// PUT /api/tasks/:id
// ---------------------------------------------------------------------------

export async function updateTaskHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const params = taskIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: 'Invalid task id', details: params.error.flatten() });
      return;
    }

    const parsed = updateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid update payload', details: parsed.error.flatten() });
      return;
    }

    const task = await taskService.updateTask(db, userId, params.data.id, parsed.data);
    res.status(200).json({ task });
  } catch (err) {
    if (err instanceof taskService.TaskServiceError && err.code === taskService.TASK_NOT_FOUND) {
      // Other users' task ids produce the same 404 as missing ids.
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    next(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/tasks/:id
// ---------------------------------------------------------------------------

export async function deleteTaskHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const params = taskIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: 'Invalid task id', details: params.error.flatten() });
      return;
    }

    const deleted = await taskService.deleteTask(db, userId, params.data.id);
    if (!deleted) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
