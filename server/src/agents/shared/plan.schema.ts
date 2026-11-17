/**
 * Phase 1 — Zod schemas for structured execution plans and workflow state
 * (M6 Module A / Module E).
 *
 * The LLM proposes a plan; this schema is the gate. Anything that does not
 * parse is rejected before a single backend call happens. Agent names must be
 * registered, operations must be allowlisted by the registry (Phase 2), and
 * model-supplied identity fields are stripped by `.strict()` + explicit
 * rejection — ownership always comes from the authenticated request.
 */

import { z } from 'zod';
import type { AgentName } from './agent.types.js';

// ---------------------------------------------------------------------------
// Workflow / step status (mirrors migration 0013 enums)
// ---------------------------------------------------------------------------

export const WORKFLOW_STATUSES = [
  'pending',
  'planning',
  'running',
  'waiting_approval',
  'completed',
  'partially_failed',
  'failed',
  'cancelled',
] as const;
export const workflowStatusSchema = z.enum(WORKFLOW_STATUSES);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

export const STEP_STATUSES = [
  'pending',
  'ready',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'skipped',
  'cancelled',
] as const;
export const stepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof stepStatusSchema>;

/** Terminal statuses — a step/run in one of these never advances again. */
export const TERMINAL_STATUSES: readonly WorkflowStatus[] = [
  'completed',
  'partially_failed',
  'failed',
  'cancelled',
];

/** Legal workflow-state transitions (Phase 3 state machine enforces these). */
export const WORKFLOW_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  pending: ['planning', 'cancelled', 'failed'],
  planning: ['running', 'waiting_approval', 'failed', 'cancelled'],
  running: ['running', 'waiting_approval', 'completed', 'partially_failed', 'failed', 'cancelled'],
  waiting_approval: ['running', 'failed', 'cancelled'],
  completed: [],
  partially_failed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalStatus(status: WorkflowStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Agent / operation identification
// ---------------------------------------------------------------------------

export const agentNameSchema = z.enum([
  'memory',
  'knowledge',
  'task',
  'scheduling',
  'research',
  'communication',
]);

/** Operation names are short, snake_case identifiers — never free text. */
export const operationNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'operation must be snake_case');

// ---------------------------------------------------------------------------
// Plan step
// ---------------------------------------------------------------------------

/**
 * One unit of delegated work. Bounded by design: no arbitrary function names,
 * no SQL, no URLs, no credentials, no user identity fields.
 */
export const planStepSchema = z
  .object({
    /** Stable, unique-within-plan key (client/model-generated, not a DB id). */
    stepKey: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, 'stepKey must be snake_case'),
    agent: agentNameSchema,
    operation: operationNameSchema,
    /** Step arguments. Validated AGAINST THE CAPABILITY SCHEMA at dispatch. */
    args: z.record(z.unknown()).default({}),
    /** stepKeys this step depends on (must exist elsewhere in the plan). */
    dependsOn: z.array(z.string().min(1).max(64)).max(8).default([]),
    /** Whether this operation requires human approval before executing. */
    requiresApproval: z.boolean().default(false),
    /** Per-step timeout in ms (bounded 1s..5min). */
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    /** Retry budget for idempotent steps (0..2). */
    maxRetries: z.number().int().min(0).max(2).default(0),
    /** Short human label shown in the Agent Activity UI. */
    label: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    if (step.dependsOn.includes(step.stepKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dependsOn'],
        message: 'a step cannot depend on itself',
      });
    }
    // Defense in depth: identity fields never belong in model-supplied args.
    for (const forbidden of ['user_id', 'userId', 'owner_id', 'ownerId']) {
      if (forbidden in step.args) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['args', forbidden],
          message: `${forbidden} is not allowed; ownership comes from authentication`,
        });
      }
    }
  });

export type PlanStep = z.infer<typeof planStepSchema>;

// ---------------------------------------------------------------------------
// Full execution plan
// ---------------------------------------------------------------------------

/** Hard bound on plan size — prevents unbounded agent fan-out. */
export const MAX_PLAN_STEPS = 12;

export const executionPlanSchema = z
  .object({
    /** The user's objective, restated. Never executes anything itself. */
    objective: z.string().min(1).max(1_000),
    steps: z.array(planStepSchema).min(1).max(MAX_PLAN_STEPS),
    /**
     * Whether the whole workflow needs approval up front (e.g. a batch of
     * sensitive actions). Individual steps may also require approval.
     */
    requiresApproval: z.boolean().default(false),
  })
  .strict()
  .superRefine((plan, ctx) => {
    // Unique step keys.
    const seen = new Set<string>();
    plan.steps.forEach((step, i) => {
      if (seen.has(step.stepKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', i, 'stepKey'],
          message: `duplicate stepKey: ${step.stepKey}`,
        });
      }
      seen.add(step.stepKey);
    });

    // Dependencies must reference existing steps.
    plan.steps.forEach((step, i) => {
      step.dependsOn.forEach((dep, j) => {
        if (!seen.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['steps', i, 'dependsOn', j],
            message: `unknown dependency: ${dep}`,
          });
        }
      });
    });

    // Acyclicity (guards against dependency loops → uncontrolled execution).
    if (hasCycle(plan.steps)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: 'plan contains a dependency cycle',
      });
    }
  });

export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

/** Kahn-style cycle detection over step dependencies. */
export function hasCycle(steps: Pick<PlanStep, 'stepKey' | 'dependsOn'>[]): boolean {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of steps) {
    indegree.set(s.stepKey, indegree.get(s.stepKey) ?? 0);
    for (const dep of s.dependsOn) {
      indegree.set(s.stepKey, (indegree.get(s.stepKey) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), s.stepKey]);
    }
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  let visited = 0;
  while (queue.length > 0) {
    const key = queue.shift()!;
    visited += 1;
    for (const next of dependents.get(key) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return visited !== steps.length;
}

/**
 * Deterministic topological order (ties broken by declared order) — the
 * orchestrator executes in this sequence.
 */
export function topologicalOrder<T extends Pick<PlanStep, 'stepKey' | 'dependsOn'>>(steps: T[]): T[] {
  const byKey = new Map(steps.map((s) => [s.stepKey, s]));
  const remaining = new Set(steps.map((s) => s.stepKey));
  const done = new Set<string>();
  const ordered: T[] = [];
  while (remaining.size > 0) {
    const next = steps.find(
      (s) => remaining.has(s.stepKey) && s.dependsOn.every((d) => done.has(d) || !byKey.has(d)),
    );
    if (!next) break; // cycle — caller must have rejected via schema
    remaining.delete(next.stepKey);
    done.add(next.stepKey);
    ordered.push(next);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Format Zod issues into a single safe message (no input echo of secrets). */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** Parse a proposed plan; returns the validated plan or throws with reasons. */
export function parseExecutionPlan(raw: unknown): ExecutionPlan {
  const parsed = executionPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid execution plan: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}
