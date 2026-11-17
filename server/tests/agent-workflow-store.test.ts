/**
 * M6 Phase 3 — workflow persistence and state machine (Module E).
 *
 * Verifies: run/step creation, owner scoping (cross-user reads return
 * nothing), CAS transitions, illegal transition rejection, idempotent
 * duplicate submission, terminal-state immutability, derived run finalization
 * and cascade deletion — all through the user-scoped fake Supabase client.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetFakeSupabase, registerUser, fakeCreateUserScopedClient } from './helpers/fakeSupabase.js';
import {
  createRun,
  deleteRun,
  finalizeRunFromSteps,
  getRun,
  getRunOrThrow,
  getStep,
  listRuns,
  listSteps,
  transitionRun,
  updateStepStatus,
} from '../src/agents/workflow/workflow.store.js';
import {
  assertTransition,
  deriveRunStatus,
  parseStepStatus,
  parseWorkflowStatus,
} from '../src/agents/workflow/workflow.state.js';
import { AgentError, parseExecutionPlan } from '../src/agents/shared/index.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const USER_A = 'user-a';
const USER_B = 'user-b';

const plan = parseExecutionPlan({
  objective: 'Review internship doc and schedule preparation',
  steps: [
    { stepKey: 'retrieve_skills', agent: 'memory', operation: 'retrieve' },
    { stepKey: 'search_doc', agent: 'knowledge', operation: 'search' },
    { stepKey: 'create_prep_task', agent: 'task', operation: 'create', dependsOn: ['retrieve_skills'] },
    {
      stepKey: 'create_reminder',
      agent: 'scheduling',
      operation: 'create_reminder',
      dependsOn: ['create_prep_task'],
      requiresApproval: false,
    },
  ],
});

// The fake client is cast to `never` at its factory (structural surface);
// re-widen it to the Supabase client type our services accept.
let client: SupabaseClient;

beforeEach(() => {
  resetFakeSupabase();
  registerUser('token-a', USER_A, 'a@example.com');
  registerUser('token-b', USER_B, 'b@example.com');
  client = fakeCreateUserScopedClient('token-a') as unknown as SupabaseClient;
});

describe('M6 Phase 3 — run and step creation', () => {
  it('creates a run with plan-ordered steps', async () => {
    const { run, steps, reused } = await createRun(client, USER_A, {
      objective: plan.objective,
      plan,
    });
    expect(reused).toBe(false);
    expect(run.user_id).toBe(USER_A);
    expect(run.status).toBe('pending');
    expect(steps.map((s) => s.step_key)).toEqual([
      'retrieve_skills',
      'search_doc',
      'create_prep_task',
      'create_reminder',
    ]);
    expect(steps[2]?.depends_on).toEqual(['retrieve_skills']);
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
    expect(steps.every((s) => s.user_id === USER_A)).toBe(true);
  });

  it('rejects a cross-user step write (owner must match run owner)', async () => {
    const { run, steps } = await createRun(client, USER_A, { objective: 'x', plan });
    // The fake has no RLS, so simulate the wrong owner explicitly: the
    // migration trigger/RLS is the backstop; here we verify the service
    // never writes another user's id because it only ever receives userId
    // from auth. Direct check: updating with USER_B's filter finds nothing.
    const foreign = await client
      .from('agent_run_steps')
      .update({ status: 'completed' })
      .eq('id', steps[0]!.id)
      .eq('user_id', USER_B)
      .select('*');
    expect(foreign.error).toBeNull();
    expect((foreign.data ?? []).length).toBe(0);

    const untouched = await getStep(client, USER_A, steps[0]!.id);
    expect(untouched?.status).toBe('pending');
    expect(run.user_id).toBe(USER_A);
  });

  it('returns the SAME run for a duplicate idempotency key (no duplicate workflow)', async () => {
    const first = await createRun(client, USER_A, {
      objective: 'same request',
      plan,
      idempotencyKey: 'req-123',
    });
    const second = await createRun(client, USER_A, {
      objective: 'same request (retry)',
      plan,
      idempotencyKey: 'req-123',
    });
    expect(second.reused).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(second.steps.map((s) => s.id)).toEqual(first.steps.map((s) => s.id));

    const runs = await listRuns(client, USER_A);
    expect(runs).toHaveLength(1);
  });

  it('idempotency keys are scoped per user (other user can reuse the key)', async () => {
    const clientB = fakeCreateUserScopedClient('token-b');
    const a = await createRun(client, USER_A, { objective: 'A', idempotencyKey: 'k' });
    const b = await createRun(clientB, USER_B, { objective: 'B', idempotencyKey: 'k' });
    expect(b.reused).toBe(false);
    expect(b.run.id).not.toBe(a.run.id);
    expect((await listRuns(client, USER_A))).toHaveLength(1);
    expect((await listRuns(clientB, USER_B))).toHaveLength(1);
  });
});

describe('M6 Phase 3 — ownership isolation', () => {
  it('never returns another user’s runs or steps', async () => {
    const { run, steps } = await createRun(client, USER_A, { objective: 'secret plan', plan });
    const clientB = fakeCreateUserScopedClient('token-b');

    expect(await getRun(clientB, USER_B, run.id)).toBeNull();
    expect(await listRuns(clientB, USER_B)).toHaveLength(0);
    expect(await listSteps(clientB, USER_B, run.id)).toHaveLength(0);
    expect(await getStep(clientB, USER_B, steps[0]!.id)).toBeNull();
    await expect(getRunOrThrow(clientB, USER_B, run.id)).rejects.toThrow(AgentError);
  });

  it('cross-user transition attempts are rejected without changing state', async () => {
    const { run } = await createRun(client, USER_A, { objective: 'x' });
    const clientB = fakeCreateUserScopedClient('token-b');
    await expect(
      transitionRun(clientB, USER_B, run.id, 'pending', 'planning'),
    ).rejects.toThrow(/not in status/);
    const unchanged = await getRun(client, USER_A, run.id);
    expect(unchanged?.status).toBe('pending');
  });
});

describe('M6 Phase 3 — state machine transitions', () => {
  it('walks pending → planning → running → completed legally', async () => {
    const { run, steps } = await createRun(client, USER_A, { objective: 'x', plan });

    const planned = await transitionRun(client, USER_A, run.id, 'pending', 'planning');
    expect(planned.status).toBe('planning');

    const started = await transitionRun(client, USER_A, run.id, 'planning', 'running', {
      started: true,
    });
    expect(started.status).toBe('running');
    expect(started.started_at).not.toBeNull();
    expect(started.claimed_at).not.toBeNull();

    for (const step of steps) {
      await updateStepStatus(client, USER_A, step.id, 'pending', 'running', { started: true });
      await updateStepStatus(client, USER_A, step.id, 'running', 'completed', {
        completed: true,
        outputMetadata: { ok: true },
      });
    }

    const final = await finalizeRunFromSteps(client, USER_A, run.id);
    expect(final.status).toBe('completed');
    expect(final.completed_at).not.toBeNull();
    expect(final.summary.stepCounts).toMatchObject({ completed: 4 });
  });

  it('rejects illegal transitions (state machine enforced)', async () => {
    const { run } = await createRun(client, USER_A, { objective: 'x' });
    await expect(transitionRun(client, USER_A, run.id, 'pending', 'running')).rejects.toThrow(
      /Illegal workflow transition/,
    );
    await expect(transitionRun(client, USER_A, run.id, 'pending', 'completed')).rejects.toThrow(
      /Illegal workflow transition/,
    );
    expect((await getRun(client, USER_A, run.id))?.status).toBe('pending');
  });

  it('terminal runs are immutable (no resurrection)', async () => {
    const { run } = await createRun(client, USER_A, { objective: 'x' });
    await transitionRun(client, USER_A, run.id, 'pending', 'planning');
    await transitionRun(client, USER_A, run.id, 'planning', 'failed', {
      completed: true,
      errorCode: 'EXECUTION_FAILED',
      errorMessage: 'boom',
    });
    await expect(
      transitionRun(client, USER_A, run.id, 'failed', 'running'),
    ).rejects.toThrow(/terminal|Illegal/);
    expect((await getRun(client, USER_A, run.id))?.status).toBe('failed');
    expect(() => assertTransition('completed', 'running')).toThrow(AgentError);
  });

  it('CAS prevents double transitions (two writers, one winner)', async () => {
    const { run } = await createRun(client, USER_A, { objective: 'x' });
    await transitionRun(client, USER_A, run.id, 'pending', 'planning');
    // Both writers believe the run is still 'planning'.
    const first = await transitionRun(client, USER_A, run.id, 'planning', 'running');
    expect(first.status).toBe('running');
    await expect(
      transitionRun(client, USER_A, run.id, 'planning', 'running'),
    ).rejects.toThrow(/not in status/);
    expect((await getRun(client, USER_A, run.id))?.status).toBe('running');
  });

  it('supports waiting_approval → running after approval', async () => {
    const { run } = await createRun(client, USER_A, { objective: 'x' });
    await transitionRun(client, USER_A, run.id, 'pending', 'planning');
    await transitionRun(client, USER_A, run.id, 'planning', 'waiting_approval');
    const resumed = await transitionRun(client, USER_A, run.id, 'waiting_approval', 'running');
    expect(resumed.status).toBe('running');
  });

  it('cancellation works from running and is terminal', async () => {
    const { run } = await createRun(client, USER_A, { objective: 'x' });
    await transitionRun(client, USER_A, run.id, 'pending', 'planning');
    await transitionRun(client, USER_A, run.id, 'planning', 'running');
    const cancelled = await transitionRun(client, USER_A, run.id, 'running', 'cancelled', {
      completed: true,
      errorCode: 'CANCELLED',
    });
    expect(cancelled.status).toBe('cancelled');
    await expect(
      transitionRun(client, USER_A, run.id, 'cancelled', 'running'),
    ).rejects.toThrow();
  });
});

describe('M6 Phase 3 — step updates and derived status', () => {
  it('step CAS rejects wrong expected status', async () => {
    const { steps } = await createRun(client, USER_A, { objective: 'x', plan });
    const step = steps[0]!;
    await expect(
      updateStepStatus(client, USER_A, step.id, 'running', 'completed'),
    ).rejects.toThrow(/not in status/);
  });

  it('retry count increments on demand', async () => {
    const { steps } = await createRun(client, USER_A, { objective: 'x', plan });
    const step = steps[0]!;
    await updateStepStatus(client, USER_A, step.id, 'pending', 'running', { started: true });
    const failed = await updateStepStatus(client, USER_A, step.id, 'running', 'pending', {
      errorCode: 'TIMEOUT',
      errorMessage: 'step timed out',
      incrementRetry: true,
    });
    expect(failed.retry_count).toBe(1);
    expect(failed.error_code).toBe('TIMEOUT');
  });

  it('derives partially_failed when some steps fail', async () => {
    const { steps } = await createRun(client, USER_A, { objective: 'x', plan });
    const statuses = ['completed', 'failed', 'completed', 'skipped'] as const;
    for (const [i, step] of steps.entries()) {
      await updateStepStatus(client, USER_A, step.id, 'pending', 'running');
      await updateStepStatus(client, USER_A, step.id, 'running', statuses[i]!);
    }

    const run = await getRunOrThrow(client, USER_A, steps[0]!.run_id);
    await transitionRun(client, USER_A, run.id, 'pending', 'planning');
    await transitionRun(client, USER_A, run.id, 'planning', 'running');
    const final = await finalizeRunFromSteps(client, USER_A, run.id);
    expect(final.status).toBe('partially_failed');
  });

  it('deriveRunStatus covers the documented outcomes', () => {
    expect(deriveRunStatus([])).toBe('failed');
    expect(deriveRunStatus(['completed', 'skipped'])).toBe('completed');
    expect(deriveRunStatus(['completed', 'failed'])).toBe('partially_failed');
    expect(deriveRunStatus(['cancelled', 'completed'])).toBe('cancelled');
    expect(deriveRunStatus(['running', 'completed'])).toBe('running');
  });
});

describe('M6 Phase 3 — status parsing helpers', () => {
  it('parses valid statuses and rejects junk', () => {
    expect(parseWorkflowStatus('waiting_approval')).toBe('waiting_approval');
    expect(parseStepStatus('ready')).toBe('ready');
    expect(() => parseWorkflowStatus('self_destruct')).toThrow(AgentError);
    expect(() => parseStepStatus('exploded')).toThrow(AgentError);
  });
});

describe('M6 Phase 3 — deletion', () => {
  it('deletes only owned runs and cascades steps', async () => {
    const { run, steps } = await createRun(client, USER_A, { objective: 'x', plan });
    const clientB = fakeCreateUserScopedClient('token-b');

    // B cannot delete A's run.
    await deleteRun(clientB, USER_B, run.id);
    expect(await getRun(client, USER_A, run.id)).not.toBeNull();

    // A can; steps cascade.
    await deleteRun(client, USER_A, run.id);
    expect(await getRun(client, USER_A, run.id)).toBeNull();
    expect(await listSteps(client, USER_A, run.id)).toHaveLength(0);
    expect(steps).toHaveLength(4);
  });
});
