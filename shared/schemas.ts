/**
 * shared/schemas.ts
 * -----------------
 * Zod validation schemas for task creation and updates.
 * Used by controllers to validate request bodies before they reach services.
 */

import { z } from 'zod';
import { isAllowedExtraScope } from './auth.js';

// ---------------------------------------------------------------------------
// Enum schemas (mirror the TypeScript union types / SQL ENUMs)
// ---------------------------------------------------------------------------

export const taskStatusSchema = z.enum(['todo', 'in_progress', 'done']);

export const taskPrioritySchema = z.enum(['low', 'medium', 'high']);

export const messageRoleSchema = z.enum(['user', 'assistant', 'system']);

export const reminderStatusSchema = z.enum(['pending', 'claimed', 'sent', 'failed', 'cancelled']);

// ---------------------------------------------------------------------------
// Profile & integration schemas (Milestone 3)
// ---------------------------------------------------------------------------

/**
 * Schema for `PATCH /api/me` — display name only.
 *
 * SECURITY: no `email`, `provider`, or `id` field — those come from the
 * verified token / auth provider and are never client-writable. Unknown
 * keys are stripped by Zod's default non-strict behavior.
 */
export const patchProfileSchema = z.object({
  display_name: z
    .string()
    .trim()
    .min(1, 'display_name must be at least 1 character')
    .max(80, 'display_name must be at most 80 characters')
    .nullable(),
});

/**
 * Schema for `POST /api/integrations` — record an EXPLICIT consent grant
 * for additional (non-login) Google scopes.
 *
 * SECURITY: scopes are checked against the shared allow-list
 * (shared/auth.ts). Login scopes are implicit in signing in and can
 * never be "granted" here; unknown scopes are rejected.
 */
export const grantIntegrationSchema = z
  .object({
    integration: z.enum(['google']),
    scopes: z
      .array(z.string().trim().min(1).max(100))
      .min(1, 'at least one scope is required')
      .max(20, 'too many scopes')
      .refine(
        (scopes) => scopes.every((s) => isAllowedExtraScope(s)),
        'one or more scopes are not in the allowed list',
      )
      .refine((scopes) => new Set(scopes).size === scopes.length, 'duplicate scopes'),
  });

/** Schema for the `:integration` path parameter. */
export const integrationParamSchema = z.object({
  integration: z.enum(['google']),
});

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
// Reminder schemas (Milestone 2)
// ---------------------------------------------------------------------------

/** ISO-8601 date-time with an explicit offset or Z. */
const reminderAtSchema = z.string().datetime({ offset: true });

/**
 * Schema for `POST /api/reminders`.
 *
 * SECURITY: like `createTaskSchema`, this deliberately has NO `user_id`
 * field — unknown keys are stripped by Zod and ownership always comes
 * from the verified bearer token.
 */
export const createReminderSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'title must be at least 1 character')
      .max(500, 'title must be at most 500 characters'),
    task_id: z.string().uuid('task_id must be a valid uuid').nullable().optional(),
    reminder_at: reminderAtSchema,
    idempotency_key: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .nullable()
      .optional(),
  });

/**
 * Schema for `PUT /api/reminders/:id` — reschedule a pending reminder.
 * Only `reminder_at` is editable; status transitions go through cancel.
 */
export const updateReminderSchema = z.object({
  reminder_at: reminderAtSchema,
});

/** Schema for the reminder `:id` path parameter. */
export const reminderIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid uuid'),
});

/** Schema for `GET /api/reminders` query filters. */
export const listRemindersQuerySchema = z.object({
  status: reminderStatusSchema.optional(),
  scope: z.enum(['upcoming', 'past', 'all']).optional(),
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
  /**
   * Knowledge Base scope. UUIDs are verified against the caller's own
   * READY documents server-side; foreign/unknown ids are ignored.
   * Capped at 20 to keep the retrieval call bounded.
   */
  document_ids: z
    .array(z.string().uuid('document_ids must contain uuids'))
    .max(20, 'at most 20 documents may be selected')
    .optional(),
  /** Force document retrieval when the message has no obvious cue. */
  use_documents: z.boolean().optional(),
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
 * - `reminder_at` is optional and only set when the user explicitly asks
 *   to be reminded — a due date is NOT a reminder. The backend resolves
 *   it authoritatively (date.service.resolveReminderTime) and rejects
 *   past/invalid values before anything is persisted.
 * - `recurrence` must be explicit: recurring requests are never silently
 *   downgraded to one-time reminders.
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
  reminder_at: z
    .string()
    .trim()
    .min(1, 'reminder_at must not be empty')
    .max(96, 'reminder_at is too long')
    .optional(),
  recurrence: z
    .enum(['none', 'weekly'])
    .optional(),
});

// ---------------------------------------------------------------------------
// Memory (Milestone 4 / 4.1)
// ---------------------------------------------------------------------------

/**
 * The 9 memory categories (mirrors the `memory_category` enum in
 * 0005_memory_engine.sql). Single source of truth for API validation,
 * the `save_memory` tool schema and structured extraction.
 */
export const MEMORY_CATEGORIES = [
  'personal_fact',
  'user_preference',
  'career_goal',
  'project',
  'important_event',
  'learning_preference',
  'work_info',
  'recurring_info',
  'other',
] as const;

export const memoryCategorySchema = z.enum(MEMORY_CATEGORIES);

/**
 * Schema for creating a memory.
 *
 * SECURITY: `user_id` is deliberately absent — ownership always comes from
 * the verified bearer token. Unknown keys are stripped by Zod.
 * `sensitivity: 'credential'` is rejected here as well as in the service
 * (defense in depth): credentials are never stored as memories.
 */
export const memoryInputSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'content must be at least 1 character')
    .max(4000, 'content must be at most 4000 characters'),
  category: memoryCategorySchema.default('other'),
  source_message_id: z.string().uuid().optional().nullable(),
  source_evidence: z.string().trim().max(500).optional(),
  confidence: z.enum(['low', 'medium', 'high']).default('medium'),
  sensitivity: z
    .enum(['normal', 'sensitive'])
    .default('normal'),
});

/**
 * Arguments for the model-facing `save_memory` tool (Milestone 4.1,
 * Task C). Used only when the USER explicitly asks the assistant to
 * remember something — never for routine chat.
 *
 * SECURITY: no `user_id` field (ownership comes from the verified token),
 * content is bounded, and the server re-checks credentials before storage.
 */
export const saveMemoryToolArgsSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'content must be at least 1 character')
    .max(4000, 'content must be at most 4000 characters'),
  category: memoryCategorySchema.default('other'),
  /** Verbatim span of the user message that justifies the memory. */
  evidence: z.string().trim().max(500).optional(),
});

/** Schema for vector search requests. The embedding itself is optional. */
export const memorySearchSchema = z.object({
  query_embedding: z.array(z.number()).max(4096).optional(),
  threshold: z.number().min(0).max(1).optional(),
  max_results: z.number().int().min(1).max(50).optional(),
  category: z.string().optional(),
  /** Optional natural-language query enabling hybrid lexical retrieval. */
  query_text: z.string().trim().max(2000).optional(),
});

/** Schema for updating an existing memory (explicit user correction). */
export const memoryUpdateSchema = z.object({
  content: z.string().trim().min(1).max(4000).optional(),
  status: z.enum(['active', 'needs_review', 'expired', 'deleted']).optional(),
  sensitivity: z.enum(['normal', 'sensitive']).optional(),
});

/**
 * Schema for memory settings updates.
 *
 * Defaults are intentionally conservative: automatic extraction is OFF and
 * sensitive memories are excluded from chat context unless explicitly opted in.
 */
export const memorySettingsSchema = z.object({
  automatic_memory_extraction: z.boolean().optional(),
  similarity_threshold: z.number().min(0).max(1).optional(),
  include_memory_in_chat: z.boolean().optional(),
  include_sensitive_in_chat: z.boolean().optional(),
  max_memory_context_chars: z.number().int().min(200).max(8000).optional(),
});

// ---------------------------------------------------------------------------
// Knowledge Base (Milestone 5)
// ---------------------------------------------------------------------------

/** Mirrors the `extension` CHECK constraint in 0011. */
export const documentExtensionSchema = z.enum(['pdf', 'docx', 'txt']);

/** Mirrors the `status` CHECK constraint in 0011. */
export const documentStatusSchema = z.enum([
  'uploaded',
  'pending',
  'processing',
  'ready',
  'failed',
  'deleting',
  'deleted',
]);

/** Schema for the `:id` path parameter of document routes. */
export const documentIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid uuid'),
});

/**
 * Schema for `GET /api/documents`.
 *
 * `q` is a simple case-insensitive filename filter. The upload date is
 * never client-supplied; ordering is server-side.
 */
export const documentListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: documentExtensionSchema.optional(),
  status: documentStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

/**
 * Schema for `PATCH /api/documents/:id` (rename only).
 *
 * SECURITY: no `status`, `user_id` or storage fields — lifecycle and
 * ownership are server-controlled. Unknown keys are stripped by Zod.
 */
export const documentRenameSchema = z.object({
  original_filename: z
    .string()
    .trim()
    .min(1, 'original_filename must be at least 1 character')
    .max(255, 'original_filename must be at most 255 characters'),
});

/**
 * Schema for `POST /api/documents/search`.
 *
 * SECURITY: no `user_id` field; retrieval is always scoped to the
 * verified bearer token.
 */
export const documentSearchSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, 'query must be at least 1 character')
    .max(2000, 'query must be at most 2000 characters'),
  document_ids: z
    .array(z.string().uuid('document_ids must contain uuids'))
    .max(20, 'at most 20 documents may be selected')
    .optional(),
  threshold: z.number().min(0).max(1).optional(),
  max_results: z.number().int().min(1).max(50).optional(),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

export type CreateTaskInputValidated = z.infer<typeof createTaskSchema>;
export type UpdateTaskInputValidated = z.infer<typeof updateTaskSchema>;
export type ChatRequestValidated = z.infer<typeof chatRequestSchema>;
export type ListTasksQueryValidated = z.infer<typeof listTasksQuerySchema>;
export type CreateTaskToolArgsValidated = z.infer<typeof createTaskToolArgsSchema>;
export type CreateReminderInputValidated = z.infer<typeof createReminderSchema>;
export type UpdateReminderInputValidated = z.infer<typeof updateReminderSchema>;
export type ListRemindersQueryValidated = z.infer<typeof listRemindersQuerySchema>;
export type PatchProfileValidated = z.infer<typeof patchProfileSchema>;
export type GrantIntegrationValidated = z.infer<typeof grantIntegrationSchema>;
export type DocumentListQueryValidated = z.infer<typeof documentListQuerySchema>;
export type DocumentRenameValidated = z.infer<typeof documentRenameSchema>;
export type DocumentSearchValidated = z.infer<typeof documentSearchSchema>;
