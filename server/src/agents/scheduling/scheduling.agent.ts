/**
 * M6 Phase 5 — Scheduling Agent.
 *
 * Capability-scoped adapter over the EXISTING reminder service. Time
 * parsing/resolution stays in `date.service` (deterministic, future-gated,
 * zero side effects on invalid input) — this module never reimplements it.
 * Model-supplied ids are resolved owner-scoped (`getReminderById` inside
 * the service), and an optional `task_id` is verified against the caller's
 * own tasks before a reminder is attached.
 *
 * CANCELLATION is approval-gated: `scheduling.cancel` is registered with
 * `approvalRequired: true`, so the orchestrator pauses for human consent.
 */

import { z } from 'zod';
import { listRemindersQuerySchema } from '../../../../shared/schemas.js';
import type { CapabilityDefinition } from '../registry/agent.registry.js';
import {
  AGENT_ERROR_CODES,
  cancelledResult,
  failedResult,
  formatZodIssues,
  fromThrown,
  okResult,
  unresolvedResult,
} from '../shared/index.js';
import type { Agent, AgentContext, AgentInput, AgentResult } from '../shared/index.js';
import { getTaskById } from '../../services/task.service.js';
import {
  cancelReminder,
  createReminder,
  listReminders,
  updateReminder,
} from '../../services/reminder.service.js';

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const schedulingListInput = listRemindersQuerySchema;

const reminderAtField = z
  .string()
  .trim()
  .min(1, 'reminder_at must be at least 1 character')
  .max(200, 'reminder_at must be at most 200 characters');

/**
 * Create a reminder. `reminder_at` accepts a natural phrase ("tomorrow at
 * 9 AM") or an ISO timestamp: the DATE SERVICE resolves it authoritatively
 * and rejects past/invalid values (REMINDER_INVALID_TIME) BEFORE any write,
 * so the agent never re-implements time parsing — and never persists a
 * bad time.
 */
export const schedulingCreateInput = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'title must be at least 1 character')
    .max(500, 'title must be at most 500 characters'),
  task_id: z.string().uuid('task_id must be a valid uuid').nullable().optional(),
  reminder_at: reminderAtField,
  idempotency_key: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullable()
    .optional(),
});

/** Reschedule a PENDING reminder (same time rules as creation). */
export const schedulingUpdateInput = z.object({
  reminder_id: z.string().uuid('reminder_id must be a valid uuid'),
  reminder_at: reminderAtField,
});

export const schedulingCancelInput = z.object({
  reminder_id: z.string().uuid('reminder_id must be a valid uuid'),
});

const OPERATIONS: readonly string[] = ['list', 'create', 'update', 'cancel'];

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function list(rawArgs: unknown, context: AgentContext): Promise<AgentResult> {
  const parsed = schedulingListInput.safeParse(rawArgs);
  if (!parsed.success) {
    return failedResult(AGENT_ERROR_CODES.INVALID_INPUT, formatZodIssues(parsed.error));
  }
  const { status, scope } = parsed.data;

  const reminders = await listReminders(context.client, context.userId, { status, scope });
  return okResult(`Found ${reminders.length} ${reminders.length === 1 ? 'reminder' : 'reminders'}.`, {
    count: reminders.length,
    reminders: reminders.map((r) => ({
      id: r.id,
      title: r.title.slice(0, 200),
      reminder_at: r.reminder_at,
      status: r.status,
    })),
  });
}

async function create(rawArgs: unknown, context: AgentContext): Promise<AgentResult> {
  const parsed = schedulingCreateInput.safeParse(rawArgs);
  if (!parsed.success) {
    return failedResult(AGENT_ERROR_CODES.INVALID_INPUT, formatZodIssues(parsed.error));
  }
  const { title, task_id: taskId, reminder_at: reminderAt, idempotency_key: idempotencyKey } = parsed.data;

  // Never trust a model-supplied task id: it must be one of the caller's
  // own tasks before the reminder is attached to it.
  if (taskId) {
    const task = await getTaskById(context.client, context.userId, taskId);
    if (!task) return unresolvedResult('task');
  }

  const { reminder, created } = await createReminder(context.client, context.userId, {
    title,
    task_id: taskId ?? null,
    reminder_at: reminderAt,
    idempotency_key: idempotencyKey ?? null,
  });

  return okResult(
    created
      ? `Reminder scheduled for ${reminder.reminder_at}.`
      : 'A reminder with that idempotency key already exists — nothing was duplicated.',
    {
      reminder_id: reminder.id,
      reminder_at: reminder.reminder_at,
      status: reminder.status,
      created,
    },
  );
}

async function update(rawArgs: unknown, context: AgentContext): Promise<AgentResult> {
  const parsed = schedulingUpdateInput.safeParse(rawArgs);
  if (!parsed.success) {
    return failedResult(AGENT_ERROR_CODES.INVALID_INPUT, formatZodIssues(parsed.error));
  }

  // Owner-scoped + pending-only inside the service (REMINDER_NOT_FOUND /
  // REMINDER_CONFLICT map to UNRESOLVED_REFERENCE / honest failure).
  const updated = await updateReminder(context.client, context.userId, parsed.data.reminder_id, {
    reminder_at: parsed.data.reminder_at,
  });
  return okResult(`Reminder rescheduled to ${updated.reminder_at}.`, {
    reminder_id: updated.id,
    reminder_at: updated.reminder_at,
    status: updated.status,
  });
}

async function cancel(rawArgs: unknown, context: AgentContext): Promise<AgentResult> {
  const parsed = schedulingCancelInput.safeParse(rawArgs);
  if (!parsed.success) {
    return failedResult(AGENT_ERROR_CODES.INVALID_INPUT, formatZodIssues(parsed.error));
  }

  const cancelled = await cancelReminder(context.client, context.userId, parsed.data.reminder_id);
  return okResult('Reminder cancelled.', {
    reminder_id: cancelled.id,
    status: cancelled.status,
  });
}

// ---------------------------------------------------------------------------
// Agent + capability registration metadata
// ---------------------------------------------------------------------------

export const schedulingAgent: Agent = {
  name: 'scheduling',
  canHandle: (input: AgentInput) => Promise.resolve(OPERATIONS.includes(input.operation)),
  execute: async (input: AgentInput, context: AgentContext): Promise<AgentResult> => {
    if (context.signal?.aborted) return cancelledResult();
    try {
      switch (input.operation) {
        case 'list':
          return await list(input.args, context);
        case 'create':
          return await create(input.args, context);
        case 'update':
          return await update(input.args, context);
        case 'cancel':
          return await cancel(input.args, context);
        default:
          return failedResult(
            AGENT_ERROR_CODES.CAPABILITY_FORBIDDEN,
            `The scheduling agent does not support operation '${input.operation}'.`,
          );
      }
    } catch (err) {
      return fromThrown(err, { context, fallbackMessage: 'The scheduling operation failed.' });
    }
  },
};

export const schedulingCapabilities: CapabilityDefinition[] = [
  {
    name: 'scheduling.list',
    agent: 'scheduling',
    operations: ['list'],
    permissions: ['reminders:read'],
    approvalRequired: false,
    inputSchema: schedulingListInput,
    timeoutMs: 8_000,
    idempotent: true,
    available: true,
  },
  {
    name: 'scheduling.create',
    agent: 'scheduling',
    operations: ['create'],
    permissions: ['reminders:write'],
    approvalRequired: false,
    inputSchema: schedulingCreateInput,
    // Not idempotent without an idempotency key — the orchestrator must not
    // auto-retry this one; the service dedupes when a key is supplied.
    timeoutMs: 10_000,
    idempotent: false,
    available: true,
  },
  {
    name: 'scheduling.update',
    agent: 'scheduling',
    operations: ['update'],
    permissions: ['reminders:write'],
    approvalRequired: false,
    inputSchema: schedulingUpdateInput,
    timeoutMs: 10_000,
    idempotent: true,
    available: true,
  },
  {
    name: 'scheduling.cancel',
    agent: 'scheduling',
    operations: ['cancel'],
    permissions: ['reminders:write'],
    // Destructive: a human must approve before the reminder is cancelled.
    approvalRequired: true,
    inputSchema: schedulingCancelInput,
    timeoutMs: 10_000,
    idempotent: false,
    available: true,
  },
];
