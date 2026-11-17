/**
 * M6 Phase 5 — Task Agent.
 *
 * Capability-scoped adapter over the EXISTING task service. All queries and
 * mutations are owner-scoped inside the service (RLS + explicit WHERE), so
 * a model-supplied `task_id` for another user resolves to TASK_NOT_FOUND →
 * UNRESOLVED_REFERENCE and nothing is touched. Creation reuses the service's
 * duplicate detection (`findDuplicateTask`), which makes retries safe.
 *
 * DELETION is approval-gated: the `task.delete` capability is registered
 * with `approvalRequired: true`, so the orchestrator pauses the run for a
 * human decision before anything is removed.
 */

import { z } from 'zod';
import { createTaskSchema, listTasksQuerySchema, updateTaskSchema } from '../../../../shared/schemas.js';
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
import {
  createTask,
  deleteTask,
  findDuplicateTask,
  listTasks,
  updateTask,
} from '../../services/task.service.js';

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const taskListInput = listTasksQuerySchema;
export const taskCreateInput = createTaskSchema;

/**
 * Update: the model-supplied `task_id` plus the SHARED update schema —
 * `.and()` reuses `updateTaskSchema`'s fields and its "at least one field"
 * refinement instead of redeclaring them. Unknown keys are stripped.
 */
export const taskUpdateInput = z
  .object({ task_id: z.string().uuid('task_id must be a valid uuid') })
  .and(updateTaskSchema);

export const taskDeleteInput = z.object({
  task_id: z.string().uuid('task_id must be a valid uuid'),
});

const OPERATIONS: readonly string[] = ['list', 'create', 'update', 'delete'];

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function list(rawArgs: unknown, context: AgentContext): Promise<AgentResult> {
  const parsed = taskListInput.safeParse(rawArgs);
  if (!parsed.success) {
    return failedResult(AGENT_ERROR_CODES.INVALID_INPUT, formatZodIssues(parsed.error));
  }
  const { status, priority } = parsed.data;

  const tasks = await listTasks(context.client, context.userId, { status, priority });
  return okResult(`Found ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}.`, {
    count: tasks.length,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title.slice(0, 200),
      status: t.status,
      priority: t.priority,
      due_date: t.due_date,
    })),
  });
}

async function create(rawArgs: unknown, context: AgentContext): Promise<AgentResult> {
  const parsed = taskCreateInput.safeParse(rawArgs);
  if (!parsed.success) {
    return failedResult(AGENT_ERROR_CODES.INVALID_INPUT, formatZodIssues(parsed.error));
  }
  const input = parsed.data;

  // Idempotency: an identical retry (same normalized title + due date,
  // still-open task) returns the existing row instead of stacking
  // duplicates — same behavior as the chat `create_task` tool.
  const duplicate = await findDuplicateTask(
    context.client,
    context.userId,
    input.title,
    input.due_date ?? null,
  );
  if (duplicate) {
    return okResult(`Task already exists: ${duplicate.title.slice(0, 120)}`, {
      task_id: duplicate.id,
      created: false,
      status: duplicate.status,
    });
  }

  const task = await createTask(context.client, context.userId, input);
  return okResult(`Created task: ${task.title.slice(0, 120)}`, {
    task_id: task.id,
    created: true,
    status: task.status,
    priority: task.priority,
  });
}

async function update(rawArgs: unknown, context: AgentContext): Promise<AgentResult> {
  const parsed = taskUpdateInput.safeParse(rawArgs);
  if (!parsed.success) {
    return failedResult(AGENT_ERROR_CODES.INVALID_INPUT, formatZodIssues(parsed.error));
  }
  const { task_id: taskId, ...patch } = parsed.data;

  // Owner-scoped inside the service: a foreign/unknown id → TASK_NOT_FOUND.
  const updated = await updateTask(context.client, context.userId, taskId, patch);
  return okResult(`Updated task: ${updated.title.slice(0, 120)}`, {
    task_id: updated.id,
    status: updated.status,
    priority: updated.priority,
    due_date: updated.due_date,
  });
}

async function remove(rawArgs: unknown, context: AgentContext): Promise<AgentResult> {
  const parsed = taskDeleteInput.safeParse(rawArgs);
  if (!parsed.success) {
    return failedResult(AGENT_ERROR_CODES.INVALID_INPUT, formatZodIssues(parsed.error));
  }

  // Owner-scoped delete; false means "not found / not yours" — reported as
  // an unresolved reference, never as success.
  const deleted = await deleteTask(context.client, context.userId, parsed.data.task_id);
  if (!deleted) return unresolvedResult('task');
  return okResult('Task deleted.', { task_id: parsed.data.task_id });
}

// ---------------------------------------------------------------------------
// Agent + capability registration metadata
// ---------------------------------------------------------------------------

export const taskAgent: Agent = {
  name: 'task',
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
        case 'delete':
          return await remove(input.args, context);
        default:
          return failedResult(
            AGENT_ERROR_CODES.CAPABILITY_FORBIDDEN,
            `The task agent does not support operation '${input.operation}'.`,
          );
      }
    } catch (err) {
      return fromThrown(err, { context, fallbackMessage: 'The task operation failed.' });
    }
  },
};

export const taskCapabilities: CapabilityDefinition[] = [
  {
    name: 'task.list',
    agent: 'task',
    operations: ['list'],
    permissions: ['tasks:read'],
    approvalRequired: false,
    inputSchema: taskListInput,
    timeoutMs: 8_000,
    idempotent: true,
    available: true,
  },
  {
    name: 'task.create',
    agent: 'task',
    operations: ['create'],
    permissions: ['tasks:write'],
    approvalRequired: false,
    inputSchema: taskCreateInput,
    // Safe to retry: `findDuplicateTask` returns the existing row instead
    // of creating a second one.
    timeoutMs: 10_000,
    idempotent: true,
    available: true,
  },
  {
    name: 'task.update',
    agent: 'task',
    operations: ['update'],
    permissions: ['tasks:write'],
    approvalRequired: false,
    inputSchema: taskUpdateInput,
    timeoutMs: 10_000,
    idempotent: true,
    available: true,
  },
  {
    name: 'task.delete',
    agent: 'task',
    operations: ['delete'],
    permissions: ['tasks:delete'],
    // Destructive: a human must approve before anything is removed.
    approvalRequired: true,
    inputSchema: taskDeleteInput,
    timeoutMs: 10_000,
    idempotent: false,
    available: true,
  },
];
