/**
 * shared/schemas.ts
 * -----------------
 * Zod validation schemas for task creation and updates.
 * Used by controllers to validate request bodies before they reach services.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enum schemas (mirror the TypeScript union types / SQL ENUMs)
// ---------------------------------------------------------------------------

export const taskStatusSchema = z.enum(['todo', 'in_progress', 'done']);

export const taskPrioritySchema = z.enum(['low', 'medium', 'high']);

export const messageRoleSchema = z.enum(['user', 'assistant', 'system']);

// ---------------------------------------------------------------------------
// Task schemas
// ---------------------------------------------------------------------------

/** ISO-8601 date-time string, or `null` to explicitly clear the due date. */
const dueDateSchema = z
  .string()
  .datetime({ offset: true })
  .nullable()
  .optional();

/** Schema for `POST /api/tasks`. */
export const createTaskSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'title must be at least 1 character')
    .max(500, 'title must be at most 500 characters'),
  priority: taskPrioritySchema.default('medium'),
  status: taskStatusSchema.default('todo'),
  due_date: dueDateSchema,
});

/** Schema for `PUT /api/tasks/:id` — all fields optional, at least one required. */
export const updateTaskSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'title must be at least 1 character')
      .max(500, 'title must be at most 500 characters')
      .optional(),
    priority: taskPrioritySchema.optional(),
    status: taskStatusSchema.optional(),
    due_date: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional(),
  })
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: 'at least one field must be provided for update' },
  );

/** Schema for the `:id` path parameter (must be a valid uuid). */
export const taskIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid uuid'),
});

/** Schema for `GET /api/tasks` query filters. */
export const listTasksQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
});

// ---------------------------------------------------------------------------
// Chat schemas
// ---------------------------------------------------------------------------

/**
 * Schema for `POST /api/chat`.
 *
 * SECURITY: The request body deliberately does NOT accept a `user_id`.
 * Identity is derived exclusively from the verified `Authorization: Bearer`
 * token by the auth middleware. Any `user_id`/`history` keys a client might
 * still send are stripped by Zod (non-strict objects drop unknown keys),
 * so they can never influence server behavior. Conversation history is
 * always loaded server-side, scoped to the authenticated user.
 */
export const chatRequestSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, 'message must be at least 1 character')
    .max(4000, 'message must be at most 4000 characters'),
});

// ---------------------------------------------------------------------------
// AI tool argument schemas
// ---------------------------------------------------------------------------

/**
 * Schema for arguments the LLM may pass to the `create_task` tool.
 *
 * SECURITY: This is the ONLY trust boundary for tool input.
 * - Unknown keys (e.g. a `user_id` injected by the model) are stripped by
 *   Zod's default non-strict behavior and never reach the service layer —
 *   ownership always comes from the authenticated request context.
 * - `due_date` accepts any string that JavaScript can parse as a date;
 *   the caller converts it to a canonical ISO-8601 string afterwards.
 */
export const createTaskToolArgsSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'title must be at least 1 character')
    .max(500, 'title must be at most 500 characters'),
  priority: taskPrioritySchema.default('medium'),
  due_date: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => !Number.isNaN(Date.parse(value)), 'due_date is not a valid date')
    .optional(),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

export type CreateTaskInputValidated = z.infer<typeof createTaskSchema>;
export type UpdateTaskInputValidated = z.infer<typeof updateTaskSchema>;
export type ChatRequestValidated = z.infer<typeof chatRequestSchema>;
export type ListTasksQueryValidated = z.infer<typeof listTasksQuerySchema>;
export type CreateTaskToolArgsValidated = z.infer<typeof createTaskToolArgsSchema>;
