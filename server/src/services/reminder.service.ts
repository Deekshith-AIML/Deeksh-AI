/**
 * services/reminder.service.ts
 * ----------------------------
 * All database calls related to reminders (Milestone 2).
 *
 * SECURITY — same model as task.service.ts:
 *   1. `client` — the user-scoped Supabase client created by the auth
 *      middleware (carries the verified user's JWT → RLS applies), and
 *   2. `userId` — the verified user id from `req.auth`, NEVER from the
 *      request body, query, header, or AI tool arguments.
 * Every statement carries an explicit `.eq('user_id', userId)` filter on
 * top of RLS (defense in depth).
 *
 * REMINDER POLICY enforced here:
 *   - `reminder_at` must resolve to a FUTURE instant (validated with the
 *     deterministic date service — no past reminders are persisted).
 *   - Reminders are independent of task due dates: `task_id` is optional
 *     and a task can exist with no reminder.
 *   - Creation is idempotent when an `idempotency_key` is supplied
 *     (unique per user at the database level, race-safe via 23505).
 *   - Only `pending` reminders can be rescheduled or cancelled; anything
 *     already claimed/sent/failed/cancelled returns a conflict.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Reminder,
  ReminderStatus,
  CreateReminderInput,
  UpdateReminderInput,
} from '../../../shared/types.js';
import { resolveFutureReminderTime } from './date.service.js';

// ---------------------------------------------------------------------------
// Error type so controllers can distinguish failure kinds
// ---------------------------------------------------------------------------

/**
 * Reminder-side failure. `message` is safe for clients (validation and
 * not-found messages are authored for clients; DB messages are only ever
 * surfaced through the sanitized 500 path in app.ts).
 */
export class ReminderServiceError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ReminderServiceError';
  }
}

export const REMINDER_NOT_FOUND = 'REMINDER_NOT_FOUND';
export const REMINDER_CONFLICT = 'REMINDER_CONFLICT';
export const REMINDER_INVALID_TIME = 'REMINDER_INVALID_TIME';

/** Retry budget granted to every new reminder (mirrors migration default). */
export const DEFAULT_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ListRemindersFilters {
  status?: ReminderStatus;
  /** `upcoming` = reminder_at >= now (ascending); `past` = < now (descending); `all` = descending. */
  scope?: 'upcoming' | 'past' | 'all';
}

/**
 * List reminders for the verified user (RLS + explicit filter).
 * Ordered so the UI can render upcoming first without extra sorting.
 */
export async function listReminders(
  client: SupabaseClient,
  userId: string,
  filters: ListRemindersFilters = {},
): Promise<Reminder[]> {
  let query = client
    .from('reminders')
    .select('*')
    .eq('user_id', userId);

  const scope = filters.scope ?? 'all';
  const nowIso = new Date().toISOString();

  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (scope === 'upcoming') {
    // reminder_at >= now, soonest first. PostgREST gte would need another
    // builder method; the fake + real clients both support it — but to
    // keep the shared builder surface minimal we filter in JS below for
    // the boundary and order in SQL-ish fashion via `.order`.
    query = query.order('reminder_at', { ascending: true });
  } else {
    query = query.order('reminder_at', { ascending: false });
  }

  const { data, error } = await query;
  if (error) {
    throw new ReminderServiceError(`Failed to list reminders: ${error.message}`, error.code);
  }

  let rows = (data ?? []) as Reminder[];
  if (scope === 'upcoming') {
    rows = rows.filter((r) => r.reminder_at >= nowIso);
  } else if (scope === 'past') {
    rows = rows.filter((r) => r.reminder_at < nowIso);
  }
  return rows;
}

/**
 * Fetch one reminder by id, scoped to the owning user.
 * Returns null when missing OR owned by someone else → controllers 404
 * (no id probing across accounts).
 */
export async function getReminderById(
  client: SupabaseClient,
  userId: string,
  reminderId: string,
): Promise<Reminder | null> {
  const { data, error } = await client
    .from('reminders')
    .select('*')
    .eq('id', reminderId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new ReminderServiceError(`Failed to fetch reminder: ${error.message}`, error.code);
  }
  return (data as Reminder | null) ?? null;
}

/** Look up a reminder by the caller-supplied idempotency key (owner-scoped). */
async function findByIdempotencyKey(
  client: SupabaseClient,
  userId: string,
  key: string,
): Promise<Reminder | null> {
  const { data, error } = await client
    .from('reminders')
    .select('*')
    .eq('user_id', userId)
    .eq('idempotency_key', key)
    .maybeSingle();

  if (error) {
    throw new ReminderServiceError(
      `Failed to check idempotency key: ${error.message}`,
      error.code,
    );
  }
  return (data as Reminder | null) ?? null;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create a reminder for the verified user.
 *
 * @returns the persisted reminder plus `created: false` when an existing
 *          reminder with the same idempotency key was returned instead.
 *
 * Validation happens BEFORE any write: an invalid or past reminder time
 * throws REMINDER_INVALID_TIME and nothing is persisted (the AI tool can
 * then honestly report the failure without side effects).
 */
export async function createReminder(
  client: SupabaseClient,
  userId: string,
  input: CreateReminderInput,
): Promise<{ reminder: Reminder; created: boolean }> {
  // 1. Deterministic time resolution + future-time gate.
  const resolved = resolveFutureReminderTime(input.reminder_at);
  if (!resolved.ok) {
    throw new ReminderServiceError(resolved.message, REMINDER_INVALID_TIME);
  }

  // 2. Idempotency: return the existing row when the key matches.
  if (input.idempotency_key) {
    const existing = await findByIdempotencyKey(client, userId, input.idempotency_key);
    if (existing) return { reminder: existing, created: false };
  }

  // 3. Insert with ownership from the verified userId (never request input).
  const { data, error } = await client
    .from('reminders')
    .insert({
      user_id: userId,
      task_id: input.task_id ?? null,
      title: input.title,
      reminder_at: resolved.iso,
      status: 'pending',
      attempts: 0,
      max_attempts: DEFAULT_MAX_ATTEMPTS,
      next_attempt_at: resolved.iso,
      idempotency_key: input.idempotency_key ?? null,
    })
    .select()
    .single();

  if (error) {
    // Race-safe idempotency: another request won the unique-index race.
    if (error.code === '23505' && input.idempotency_key) {
      const existing = await findByIdempotencyKey(client, userId, input.idempotency_key);
      if (existing) return { reminder: existing, created: false };
    }
    throw new ReminderServiceError(`Failed to create reminder: ${error.message}`, error.code);
  }

  if (!data) {
    throw new ReminderServiceError('Reminder creation returned no row.', 'INSERT_NO_ROW');
  }
  return { reminder: data as Reminder, created: true };
}

/**
 * Reschedule a PENDING reminder owned by the verified user.
 * Only `reminder_at` is editable; the new time must be in the future.
 * Anything not pending → REMINDER_CONFLICT (409).
 */
export async function updateReminder(
  client: SupabaseClient,
  userId: string,
  reminderId: string,
  input: UpdateReminderInput,
): Promise<Reminder> {
  const resolved = resolveFutureReminderTime(input.reminder_at);
  if (!resolved.ok) {
    throw new ReminderServiceError(resolved.message, REMINDER_INVALID_TIME);
  }

  const existing = await getReminderById(client, userId, reminderId);
  if (!existing) {
    throw new ReminderServiceError('Reminder not found.', REMINDER_NOT_FOUND);
  }
  if (existing.status !== 'pending') {
    throw new ReminderServiceError(
      `A ${existing.status} reminder cannot be rescheduled — only pending reminders can be edited.`,
      REMINDER_CONFLICT,
    );
  }

  const { data, error } = await client
    .from('reminders')
    .update({
      reminder_at: resolved.iso,
      // Re-schedule the claim window to the new time (retry backoff reset).
      next_attempt_at: resolved.iso,
    })
    .eq('id', reminderId)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (error) {
    throw new ReminderServiceError(`Failed to update reminder: ${error.message}`, error.code);
  }
  if (!data) {
    // Status changed between the read and the update → conflict.
    throw new ReminderServiceError(
      'The reminder is no longer pending and cannot be rescheduled.',
      REMINDER_CONFLICT,
    );
  }
  return data as Reminder;
}

/**
 * Cancel a PENDING reminder owned by the verified user (soft delete —
 * delivery status history is preserved for the UI).
 * Already sent/failed/claimed/cancelled → REMINDER_CONFLICT (409).
 */
export async function cancelReminder(
  client: SupabaseClient,
  userId: string,
  reminderId: string,
): Promise<Reminder> {
  const existing = await getReminderById(client, userId, reminderId);
  if (!existing) {
    throw new ReminderServiceError('Reminder not found.', REMINDER_NOT_FOUND);
  }
  if (existing.status !== 'pending') {
    throw new ReminderServiceError(
      `A ${existing.status} reminder cannot be cancelled — only pending reminders can be cancelled.`,
      REMINDER_CONFLICT,
    );
  }

  const { data, error } = await client
    .from('reminders')
    .update({ status: 'cancelled' })
    .eq('id', reminderId)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (error) {
    throw new ReminderServiceError(`Failed to cancel reminder: ${error.message}`, error.code);
  }
  if (!data) {
    throw new ReminderServiceError(
      'The reminder is no longer pending and cannot be cancelled.',
      REMINDER_CONFLICT,
    );
  }
  return data as Reminder;
}
