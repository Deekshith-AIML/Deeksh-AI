/**
 * M6 Phase 1 — shared agent interfaces and plan schemas.
 *
 * Verifies the Zod gate that every model-proposed execution plan must pass:
 * bounds, dependency integrity, acyclicity, forbidden identity fields, and
 * the workflow state machine helpers. No provider, DB or network access.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_ERROR_CODES,
  AgentError,
  MAX_PLAN_STEPS,
  WORKFLOW_STATUSES,
  WORKFLOW_TRANSITIONS,
  canTransition,
  executionPlanSchema,
  formatZodIssues,
  hasCycle,
  isAgentError,
  isTerminalStatus,
  parseExecutionPlan,
  planStepSchema,
  topologicalOrder,
  workflowStatusSchema,
} from '../src/agents/shared/index.js';
import type { Agent, AgentContext, AgentInput, AgentResult } from '../src/agents/shared/index.js';

const baseStep = {
  stepKey: 'retrieve_memories',
  agent: 'memory',
  operation: 'retrieve',
};

function rawPlan(steps: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { objective: 'Test objective', steps, ...extra };
}

describe('M6 Phase 1 — plan step schema', () => {
  it('accepts a minimal step and applies defaults', () => {
    const parsed = planStepSchema.parse(baseStep);
    expect(parsed.args).toEqual({});
    expect(parsed.dependsOn).toEqual([]);
    expect(parsed.requiresApproval).toBe(false);
    expect(parsed.timeoutMs).toBe(30_000);
    expect(parsed.maxRetries).toBe(0);
  });

  it('rejects unknown agents', () => {
    const result = planStepSchema.safeParse({ ...baseStep, agent: 'hacker' });
    expect(result.success).toBe(false);
  });

  it('rejects malformed operation names (no arbitrary functions)', () => {
    for (const operation of ['', 'DROP TABLE tasks', 'exec; rm -rf', 'Create Task', 'a'.repeat(65)]) {
      expect(planStepSchema.safeParse({ ...baseStep, operation }).success).toBe(false);
    }
  });

  it('rejects model-supplied ownership fields in args', () => {
    for (const key of ['user_id', 'userId', 'owner_id', 'ownerId']) {
      const result = planStepSchema.safeParse({ ...baseStep, args: { [key]: 'attacker' } });
      expect(result.success).toBe(false);
    }
  });

  it('rejects self-dependency', () => {
    const result = planStepSchema.safeParse({ ...baseStep, dependsOn: ['retrieve_memories'] });
    expect(result.success).toBe(false);
  });

  it('rejects out-of-bounds timeout and retries', () => {
    expect(planStepSchema.safeParse({ ...baseStep, timeoutMs: 999 }).success).toBe(false);
    expect(planStepSchema.safeParse({ ...baseStep, timeoutMs: 300_001 }).success).toBe(false);
    expect(planStepSchema.safeParse({ ...baseStep, maxRetries: 3 }).success).toBe(false);
  });

  it('rejects unknown top-level keys on a step (strict)', () => {
    expect(planStepSchema.safeParse({ ...baseStep, sql: 'select 1' }).success).toBe(false);
  });
});

describe('M6 Phase 1 — execution plan schema', () => {
  it('accepts a valid two-step plan with dependencies', () => {
    const plan = parseExecutionPlan(
      rawPlan([
        baseStep,
        { stepKey: 'create_task', agent: 'task', operation: 'create', dependsOn: ['retrieve_memories'] },
      ]),
    );
    expect(plan.steps).toHaveLength(2);
    expect(plan.requiresApproval).toBe(false);
  });

  it('rejects an empty plan', () => {
    expect(executionPlanSchema.safeParse(rawPlan([])).success).toBe(false);
  });

  it(`rejects more than MAX_PLAN_STEPS (${MAX_PLAN_STEPS}) steps`, () => {
    const steps = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => ({
      ...baseStep,
      stepKey: `step_${i}`,
    }));
    expect(executionPlanSchema.safeParse(rawPlan(steps)).success).toBe(false);
  });

  it('rejects duplicate step keys', () => {
    const result = executionPlanSchema.safeParse(rawPlan([baseStep, { ...baseStep }]));
    expect(result.success).toBe(false);
  });

  it('rejects unknown dependencies', () => {
    const result = executionPlanSchema.safeParse(
      rawPlan([{ ...baseStep, dependsOn: ['ghost_step'] }]),
    );
    expect(result.success).toBe(false);
  });

  it('rejects dependency cycles', () => {
    const result = executionPlanSchema.safeParse(
      rawPlan([
        { ...baseStep, dependsOn: ['step_b'] },
        { stepKey: 'step_b', agent: 'task', operation: 'create', dependsOn: ['retrieve_memories'] },
      ]),
    );
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level keys (model cannot invent fields)', () => {
    expect(executionPlanSchema.safeParse(rawPlan([baseStep], { user_id: 'x' })).success).toBe(false);
    expect(executionPlanSchema.safeParse(rawPlan([baseStep], { bypassAuth: true })).success).toBe(false);
  });

  it('throws a safe, path-labelled error from parseExecutionPlan', () => {
    expect(() => parseExecutionPlan(rawPlan([]))).toThrow(/Invalid execution plan/);
  });
});

describe('M6 Phase 1 — ordering helpers', () => {
  const steps = [
    { stepKey: 'c', dependsOn: ['b'] },
    { stepKey: 'a', dependsOn: [] },
    { stepKey: 'b', dependsOn: ['a'] },
  ];

  it('detects cycles', () => {
    expect(hasCycle(steps)).toBe(false);
    expect(
      hasCycle([
        { stepKey: 'a', dependsOn: ['b'] },
        { stepKey: 'b', dependsOn: ['a'] },
      ]),
    ).toBe(true);
  });

  it('orders steps by dependency, preserving declared order for ties', () => {
    const ordered = topologicalOrder(steps);
    expect(ordered.map((s) => s.stepKey)).toEqual(['a', 'b', 'c']);
  });

  it('handles independent steps deterministically', () => {
    const parallel = [
      { stepKey: 'x2', dependsOn: [] },
      { stepKey: 'x1', dependsOn: [] },
    ];
    expect(topologicalOrder(parallel).map((s) => s.stepKey)).toEqual(['x2', 'x1']);
  });
});

describe('M6 Phase 1 — workflow state machine', () => {
  it('exposes exactly the eight specified workflow states', () => {
    expect([...WORKFLOW_STATUSES].sort()).toEqual(
      [
        'cancelled',
        'completed',
        'failed',
        'partially_failed',
        'pending',
        'planning',
        'running',
        'waiting_approval',
      ].sort(),
    );
    expect(workflowStatusSchema.options).toHaveLength(8);
  });

  it('treats completed/partially_failed/failed/cancelled as terminal', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('partially_failed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('waiting_approval')).toBe(false);
  });

  it('allows only defined transitions', () => {
    expect(canTransition('pending', 'planning')).toBe(true);
    expect(canTransition('planning', 'running')).toBe(true);
    expect(canTransition('running', 'waiting_approval')).toBe(true);
    expect(canTransition('waiting_approval', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('running', 'partially_failed')).toBe(true);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('cancelled', 'running')).toBe(false);
    expect(canTransition('failed', 'pending')).toBe(false);
    expect(canTransition('pending', 'completed')).toBe(false);
  });

  it('every status defines an outbound transition list (no dead config)', () => {
    for (const status of WORKFLOW_STATUSES) {
      expect(Array.isArray(WORKFLOW_TRANSITIONS[status])).toBe(true);
    }
  });
});

describe('M6 Phase 1 — shared errors and agent interface', () => {
  it('AgentError carries a stable code and is type-guardable', () => {
    const err = new AgentError(AGENT_ERROR_CODES.CAPABILITY_UNAVAILABLE, 'nope');
    expect(isAgentError(err)).toBe(true);
    expect(isAgentError(new Error('plain'))).toBe(false);
    expect(err.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(err.expose).toBe(true);
  });

  it('formatZodIssues labels paths without echoing values', () => {
    const result = planStepSchema.safeParse({ ...baseStep, agent: 'nope' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const text = formatZodIssues(result.error);
      expect(text).toContain('agent');
    }
  });

  it('an Agent implementation satisfies the shared contract shape', async () => {
    const agent: Agent = {
      name: 'task',
      canHandle: (input: AgentInput) => Promise.resolve(input.operation === 'create'),
      execute: (_input: AgentInput, ctx: AgentContext): Promise<AgentResult> =>
        Promise.resolve({ status: 'ok', summary: `run ${ctx.runId}` }),
    };
    expect(await agent.canHandle({ operation: 'create', args: {} })).toBe(true);
    expect(await agent.canHandle({ operation: 'delete', args: {} })).toBe(false);
    const result = await agent.execute(
      { operation: 'create', args: {} },
      { userId: 'u1', client: {} as AgentContext['client'], runId: 'r1', stepId: 's1', deadline: 0 },
    );
    expect(result.status).toBe('ok');
    expect(result.summary).toBe('run r1');
  });
});
