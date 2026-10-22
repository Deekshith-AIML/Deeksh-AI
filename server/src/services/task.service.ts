/**
 * services/task.service.ts
 * ------------------------
 * All database calls related to tasks.
 *
 * SECURITY — every function takes TWO trust inputs:
 *   1. `client`  — the user-scoped Supabase client created by the auth
 *                  middleware (carries the verified user's JWT, so RLS
 *                  policies apply to the statement), and
 *   2. `userId`  — the verified user id from `req.auth`, never from the
 *                  request body/query/header or from AI tool arguments.
 *
 * Both layers are applied deliberately: RLS is the database backstop, the
 * explicit `.eq('user_id', userId)` filters are the service-layer check.
 * Neither is sufficient alone for this architecture (RLS could be mis-
 * configured; a forgotten `.eq` could be patched without notice if RLS
 * were off) — keep both.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Task,
  TaskStatus,
  TaskPriority,
  CreateTaskInput,
  UpdateTaskInput,
} from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Custom error type so controllers can distinguish DB failures
// ---------------------------------------------------------------------------

/**
 * Database/service failure.
 *
 * NOTE: `message` is for server logs only. Controllers must not send raw
 * messages from this class to clients for 5xx responses — the app-level
 * error handler sanitizes them (see app.ts).
 */
export class TaskServiceError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'TaskServiceError';
  }
}

/** Well-known code for "row not found / not owned by this user". */
export const TASK_NOT_FOUND = 'TASK_NOT_FOUND';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ListTasksFilters {
  status?: TaskStatus;
  priority?: TaskPriority;
}

/**
 * List all tasks for the verified user, newest first, optionally filtered.
 * Returns only rows owned by `userId` (RLS + explicit filter).
 */
export async function listTasks(
  client: SupabaseClient,
  userId: string,
  filters: ListTasksFilters = {},
): Promise<Task[]> {
  let query = client
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (filters.priority) {
    query = query.eq('priority', filters.priority);
  }

  const { data, error } = await query;

  if (error) {
    throw new TaskServiceError(`Failed to list tasks: ${error.message}`, error.code);
  }

  return (data ?? []) as Task[];
}

/**
 * Fetch a single task by id, scoped to the owning user.
 * Returns null when the task does not exist OR belongs to someone else —
 * callers translate this to 404, which avoids disclosing other users' ids.
 */
export async function getTaskById(
  client: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<Task | null> {
  const { data, error } = await client
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new TaskServiceError(`Failed to fetch task: ${error.message}`, error.code);
  }

  return (data as Task | null) ?? null;
}

/**
 * Find an existing, still-open task with the same normalized title and due
 * date for this user. Used to make the AI `create_task` tool idempotent:
 * a model that retries a tool call (or a user who repeats themselves)
 * should not silently accumulate duplicate tasks.
 *
 * Matching is done on normalized strings in JS rather than SQL `ILIKE` to
 * avoid wildcard-injection surprises. Only non-`done` tasks match, so a
 * user can legitimately re-create a task they have already completed.
 */
export async function findDuplicateTask(
  client: SupabaseClient,
  userId: string,
  title: string,
  dueDate: string | null,
): Promise<Task | null> {
  const { data, error } = await client
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'done')
    .limit(500);

  if (error) {
    throw new TaskServiceError(`Failed to check for duplicates: ${error.message}`, error.code);
  }

  const normalized = normalizeTitle(title);
  const existing = (data as Task[]).find(
    (task) => normalizeTitle(task.title) === normalized && (task.due_date ?? null) === dueDate,
  );

  return existing ?? null;
}

/** Lowercase + collapse internal whitespace for duplicate comparison. */
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create a new task for the verified user.
 * Used both by the REST controller and by the AI `create_task` tool.
 * `userId` is always the authenticated identity — never request/AI input.
 */
export async function createTask(
  client: SupabaseClient,
  userId: string,
  input: CreateTaskInput,
): Promise<Task> {
  const { data, error } = await client
    .from('tasks')
    .insert({
      user_id: userId,
      title: input.title,
      status: input.status ?? 'todo',
      priority: input.priority ?? 'medium',
      due_date: input.due_date ?? null,
    })
    .select()
    .single();

  if (error) {
    throw new TaskServiceError(`Failed to create task: ${error.message}`, error.code);
  }

  if (!data) {
    // A silent no-row "success" would let callers claim a task exists when
    // it does not — treat it as failure.
    throw new TaskServiceError('Task creation returned no row.', 'INSERT_NO_ROW');
  }

  return data as Task;
}

/**
 * Update an existing task owned by the verified user.
 * Only fields present in `input` are changed; ownership is part of the
 * WHERE clause, so another user's id yields TASK_NOT_FOUND (→ 404).
 */
export async function updateTask(
  client: SupabaseClient,
  userId: string,
  taskId: string,
  input: UpdateTaskInput,
): Promise<Task> {
  // Build the patch object, skipping undefined values so we don't
  // accidentally overwrite columns with NULL.
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.status !== undefined) patch.status = input.status;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.due_date !== undefined) patch.due_date = input.due_date;

  if (Object.keys(patch).length === 0) {
    throw new TaskServiceError('No fields provided to update.', 'EMPTY_PATCH');
  }

  const { data, error } = await client
    .from('tasks')
    .update(patch)
    .eq('id', taskId)
    .eq('user_id', userId)
    .select()
    .maybeSingle();

  if (error) {
    throw new TaskServiceError(`Failed to update task: ${error.message}`, error.code);
  }

  if (!data) {
    throw new TaskServiceError('Task not found.', TASK_NOT_FOUND);
  }

  return data as Task;
}

/**
 * Delete a task owned by the verified user.
 * Returns true only when a row was actually removed (ownership-scoped).
 */
export async function deleteTask(
  client: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from('tasks')
    .delete()
    .eq('id', taskId)
    .eq('user_id', userId)
    .select('id');

  if (error) {
    throw new TaskServiceError(`Failed to delete task: ${error.message}`, error.code);
  }

  return (data?.length ?? 0) > 0;
}
