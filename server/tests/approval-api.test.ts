/**
 * tests/approval-api.test.ts
 * --------------------------
 * M6 Phase 6 — HTTP surface of the approval lifecycle (/api/approvals).
 *
 * Covers, over the real Express app via supertest:
 *   - authentication on every endpoint (401 without a verified token),
 *   - ownership isolation (other users' ids → same 404 as missing ids),
 *   - S9 (cross-user over HTTP) and S10 (forged identity vectors:
 *     body-borne user_id rejected with 400, header-borne identity ignored,
 *     no token → 401),
 *   - S1/S2 full loop: pause → HTTP decision → resume integration
 *     (approve executes + settles; reject settles without executing),
 *   - S11 replay over HTTP (409), expiry (410), validation (400),
 *   - list/detail filters and owner scoping.
 *
 * OpenAI (Gemini-compatible endpoint) is mocked — no API calls or charges.
 * Supabase is the in-memory fake (service-layer ownership filters are what
 * these tests verify; RLS is enforced by the live DB via migration 0013).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

const { openaiCreate } = vi.hoisted(() => ({ openaiCreate: vi.fn() }));

vi.mock('openai', () => {
  class APIConnectionTimeoutError extends Error {}
  class APIError extends Error {}
  class FakeOpenAI {
    chat = { completions: { create: openaiCreate } };
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    static APIError = APIError;
    constructor(_options?: Record<string, unknown>) {}
  }
  return { default: FakeOpenAI };
});

vi.mock('../src/services/supabase.service.js', async () => {
  const { fakeCreateUserScopedClient } = await import('./helpers/fakeSupabase.js');
  return {
    createUserScopedClient: fakeCreateUserScopedClient,
    createAdminClient: () => {
      throw new Error('admin client unavailable in tests');
    },
  };
});

import app from '../src/app.js';
import { executeObjective } from '../src/agents/orchestrator/orchestrator.service.js';
import { createDomainRegistry } from '../src/agents/register.js';
import * as store from '../src/agents/workflow/workflow.store.js';
import { requestApproval } from '../src/agents/approvals/index.js';
import { createTask } from '../src/services/task.service.js';
import {
  fakeCreateUserScopedClient,
  fakeDb,
  registerUser,
  resetFakeSupabase,
} from './helpers/fakeSupabase.js';
import type { FakeAgentApproval } from './helpers/fakeSupabase.js';
import { assistantReply } from './helpers/geminiMocks.js';

const TOKEN_A = 'headerA.payloadA.signatureA';
const TOKEN_B = 'headerB.payloadB.signatureB';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

let clientA: ReturnType<typeof fakeCreateUserScopedClient>;

function jsonReply(obj: unknown) {
  return assistantReply(JSON.stringify(obj));
}

/** Directly seeded approval row (reads/decisions without a live workflow). */
function seedApprovalRow(userId: string, overrides: Partial<FakeAgentApproval> = {}): FakeAgentApproval {
  const now = new Date().toISOString();
  const row: FakeAgentApproval = {
    id: randomUUID(),
    run_id: randomUUID(),
    step_id: randomUUID(),
    user_id: userId,
    action_description: 'task agent: delete (task.delete) — arguments {"task_id":"…"}',
    proposed_payload: { agent: 'task', args: {}, capability: 'task.delete', operation: 'delete' },
    payload_hash: 'f'.repeat(64),
    status: 'pending',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    decided_at: null,
    executed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  fakeDb.agent_approvals.push(row);
  return row;
}

/**
 * A REAL paused workflow (run → waiting_approval, step → waiting_approval,
 * durable PENDING approval) built through the store + approval service —
 * no LLM involved, exactly the state an orchestrated pause produces.
 */
async function seedPausedWorkflow(userId: string, userClient: typeof clientA) {
  const task = await createTask(userClient, userId, { title: 'Doomed task' });
  const objective = 'delete the doomed task';
  const { run, steps } = await store.createRun(userClient, userId, {
    objective,
    plan: {
      objective,
      requiresApproval: true,
      steps: [
        {
          stepKey: 'remove',
          agent: 'task',
          operation: 'delete',
          requiresApproval: true,
          dependsOn: [],
          args: { task_id: task.id },
          timeoutMs: 30_000,
          maxRetries: 0,
        },
      ],
    },
  });
  await store.transitionRun(userClient, userId, run.id, 'pending', 'planning');
  await store.transitionRun(userClient, userId, run.id, 'planning', 'running');
  await store.updateStepStatus(userClient, userId, steps[0]!.id, 'pending', 'waiting_approval');
  await store.transitionRun(userClient, userId, run.id, 'running', 'waiting_approval');

  const { approval } = await requestApproval(userClient, userId, {
    runId: run.id,
    stepId: steps[0]!.id,
    capability: 'task.delete',
    operation: 'delete',
    agent: 'task',
    args: { task_id: task.id },
  });
  return { runId: run.id, stepId: steps[0]!.id, taskId: task.id, approvalId: approval.id };
}

function approvalRow(id: string): FakeAgentApproval {
  const row = fakeDb.agent_approvals.find((a) => a.id === id);
  expect(row, `approval ${id} not found`).toBeDefined();
  return row!;
}

beforeEach(() => {
  resetFakeSupabase();
  registerUser(TOKEN_A, USER_A, 'alice@example.com');
  registerUser(TOKEN_B, USER_B, 'bob@example.com');
  clientA = fakeCreateUserScopedClient(TOKEN_A);
  openaiCreate.mockReset();
});

// ---------------------------------------------------------------------------
// Authentication (router-level requireAuth)
// ---------------------------------------------------------------------------

describe('/api/approvals requires authentication', () => {
  it('every endpoint answers 401 without a verified bearer token', async () => {
    const id = randomUUID();
    const endpoints: Array<[string, string]> = [
      ['get', '/api/approvals'],
      ['get', `/api/approvals/${id}`],
      ['post', `/api/approvals/${id}/approve`],
      ['post', `/api/approvals/${id}/reject`],
      ['post', `/api/approvals/${id}/cancel`],
    ];
    for (const [method, path] of endpoints) {
      const res = await (request(app) as any)[method](path);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
    // Nothing changed: an unauthenticated caller can't even list.
    expect(fakeDb.agent_approvals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// List / details — owner scoping, filters, validation
// ---------------------------------------------------------------------------

describe('GET /api/approvals (list & details)', () => {
  it('lists only the caller’s approvals, newest first, with status filter', async () => {
    const minePending = seedApprovalRow(USER_A, { created_at: '2026-11-01T10:00:00.000Z' });
    const mineExecuted = seedApprovalRow(USER_A, {
      status: 'executed',
      created_at: '2026-11-02T10:00:00.000Z',
    });
    seedApprovalRow(USER_B, { created_at: '2026-11-03T10:00:00.000Z' });

    const res = await request(app)
      .get('/api/approvals')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(200);
    const ids = res.body.approvals.map((a: { id: string }) => a.id);
    expect(ids).toHaveLength(2); // USER_B's row is invisible
    expect(ids).toEqual([mineExecuted.id, minePending.id]); // newest first

    const filtered = await request(app)
      .get('/api/approvals?status=pending')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.approvals.map((a: { id: string }) => a.id)).toEqual([minePending.id]);
  });

  it('S9: another user’s approval id is the SAME 404 as a missing id (non-leaking)', async () => {
    const foreign = seedApprovalRow(USER_B);

    const detail = await request(app)
      .get(`/api/approvals/${foreign.id}`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(detail.status).toBe(404);

    const missing = await request(app)
      .get(`/api/approvals/${randomUUID()}`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(detail.body); // indistinguishable

    // And the foreign approval is untouched (still pending for USER_B).
    expect(approvalRow(foreign.id).status).toBe('pending');
  });

  it('rejects malformed ids and query filters with 400', async () => {
    const badId = await request(app)
      .get('/api/approvals/not-a-uuid')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(badId.status).toBe(400);

    const badStatus = await request(app)
      .get('/api/approvals?status=banana')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(badStatus.status).toBe(400);

    const badLimit = await request(app)
      .get('/api/approvals?limit=0')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(badLimit.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// S10 — forged identity vectors
// ---------------------------------------------------------------------------

describe('S10: forged identity vectors are rejected or ignored', () => {
  it('a body-borne user_id is rejected with 400 and changes nothing', async () => {
    const row = seedApprovalRow(USER_A);

    const res = await request(app)
      .post(`/api/approvals/${row.id}/approve`)
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ user_id: USER_B, decision: 'approved' });

    expect(res.status).toBe(400);
    expect(approvalRow(row.id).status).toBe('pending'); // no decision happened
  });

  it('an x-user-id header is ignored — the verified token decides who acts', async () => {
    const mine = seedApprovalRow(USER_A);

    // Forged header claims USER_B; the request still acts as USER_A (the
    // token), so USER_A's approval is decided — NOT a cross-user action.
    const res = await request(app)
      .post(`/api/approvals/${mine.id}/approve`)
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .set('x-user-id', USER_B);

    expect(res.status).toBe(200);
    expect(res.body.approval.status).toBe('approved');
    // Resume could not find the seeded run — the decision still stands and
    // the failure is reported honestly instead of failing the request.
    expect(res.body.resumed).toBe(false);
    expect(approvalRow(mine.id).user_id).toBe(USER_A);
    expect(approvalRow(mine.id).status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Decisions over HTTP — lifecycle + replay + expiry
// ---------------------------------------------------------------------------

describe('POST /api/approvals/:id/{approve,reject,cancel}', () => {
  it('S1: approve resumes the run, executes the action once, and reports the settled grant', async () => {
    const { runId, stepId, approvalId } = await seedPausedWorkflow(USER_A, clientA);
    expect(fakeDb.tasks).toHaveLength(1);

    const res = await request(app)
      .post(`/api/approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(res.status).toBe(200);
    expect(res.body.resumed).toBe(true);
    expect(res.body.approval.status).toBe('executed'); // post-resume truth
    expect(fakeDb.tasks).toHaveLength(0); // approved side effect happened
    expect(approvalRow(approvalId).executed_at).not.toBeNull();

    const steps = await store.listSteps(clientA, USER_A, runId);
    expect(steps.find((s) => s.id === stepId)?.status).toBe('completed');
    const run = await store.getRunOrThrow(clientA, USER_A, runId);
    expect(run.status).toBe('completed');
  });

  it('S2: reject settles the step and run without executing anything', async () => {
    const { runId, stepId, approvalId } = await seedPausedWorkflow(USER_A, clientA);

    const res = await request(app)
      .post(`/api/approvals/${approvalId}/reject`)
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(res.status).toBe(200);
    expect(res.body.approval.status).toBe('rejected');
    expect(res.body.resumed).toBe(true);
    expect(fakeDb.tasks).toHaveLength(1); // intact
    const steps = await store.listSteps(clientA, USER_A, runId);
    expect(steps.find((s) => s.id === stepId)?.status).toBe('cancelled');
    const run = await store.getRunOrThrow(clientA, USER_A, runId);
    expect(run.status).toBe('cancelled');
  });

  it('S11: replaying a decision over HTTP is a 409, never a second action', async () => {
    const { approvalId } = await seedPausedWorkflow(USER_A, clientA);

    const first = await request(app)
      .post(`/api/approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(first.status).toBe(200);
    expect(fakeDb.tasks).toHaveLength(0);

    const replay = await request(app)
      .post(`/api/approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('INVALID_STATE');
    expect(fakeDb.tasks).toHaveLength(0); // still exactly one execution
    const executed = fakeDb.agent_audit_events.filter(
      (e) => e.approval_id === approvalId && e.event === 'approval.executed',
    );
    expect(executed).toHaveLength(1);
  });

  it('deciding after a rejection is a 409 (a rejected grant cannot flip to approved)', async () => {
    const { approvalId } = await seedPausedWorkflow(USER_A, clientA);

    const rejected = await request(app)
      .post(`/api/approvals/${approvalId}/reject`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(rejected.status).toBe(200);

    const flip = await request(app)
      .post(`/api/approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(flip.status).toBe(409);
    expect(approvalRow(approvalId).status).toBe('rejected');
    expect(fakeDb.tasks).toHaveLength(1);
  });

  it('an expired approval answers 410 and settles via the lazy sweep', async () => {
    const { runId, approvalId } = await seedPausedWorkflow(USER_A, clientA);
    approvalRow(approvalId).expires_at = new Date(Date.now() - 1_000).toISOString();

    const res = await request(app)
      .post(`/api/approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('TIMEOUT');
    expect(approvalRow(approvalId).status).toBe('expired'); // swept, audited
    expect(fakeDb.tasks).toHaveLength(1); // never executed

    // The run was NOT resumed by a failed decision — it stays paused until
    // the next resume trigger settles it (expiry detected at evaluation).
    const run = await store.getRunOrThrow(clientA, USER_A, runId);
    expect(run.status).toBe('waiting_approval');
  });

  it('cancel works over HTTP and cannot be repeated', async () => {
    const { approvalId, runId } = await seedPausedWorkflow(USER_A, clientA);

    const cancel = await request(app)
      .post(`/api/approvals/${approvalId}/cancel`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.approval.status).toBe('cancelled');
    expect(cancel.body.resumed).toBe(true);
    expect(fakeDb.tasks).toHaveLength(1);

    const again = await request(app)
      .post(`/api/approvals/${approvalId}/cancel`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(again.status).toBe(409);

    const steps = await store.listSteps(clientA, USER_A, runId);
    expect(steps[0]?.status).toBe('cancelled');
  });

  it('S9: deciding on another user’s approval is 404 and changes nothing', async () => {
    const foreign = await seedPausedWorkflow(USER_B, fakeCreateUserScopedClient(TOKEN_B));

    const res = await request(app)
      .post(`/api/approvals/${foreign.approvalId}/approve`)
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(res.status).toBe(404);
    expect(approvalRow(foreign.approvalId).status).toBe('pending'); // untouched
    expect(fakeDb.tasks).toHaveLength(1); // task intact
    const run = await store.getRunOrThrow(fakeCreateUserScopedClient(TOKEN_B), USER_B, foreign.runId);
    expect(run.status).toBe('waiting_approval'); // B's workflow unaffected
  });

  it('rejects malformed approval ids with 400', async () => {
    const res = await request(app)
      .post('/api/approvals/not-a-uuid/approve')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Full loop through the real orchestrator + HTTP decision
// ---------------------------------------------------------------------------

describe('orchestrated pause → HTTP decision → resume', () => {
  it('pauses via executeObjective, then approves over HTTP and the action executes', async () => {
    const task = await createTask(clientA, USER_A, { title: 'Stale task' });
    openaiCreate.mockResolvedValueOnce(
      jsonReply({
        objective: 'delete the stale task',
        steps: [
          { stepKey: 'remove', agent: 'task', operation: 'delete', args: { task_id: task.id } },
        ],
      }),
    );

    const paused = await executeObjective(
      clientA,
      USER_A,
      'delete the stale task',
      createDomainRegistry(),
    );
    expect(paused.status).toBe('waiting_approval');
    expect(fakeDb.tasks).toHaveLength(1);
    const approval = fakeDb.agent_approvals.find((a) => a.user_id === USER_A)!;
    expect(approval.status).toBe('pending');

    const res = await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(200);
    expect(res.body.resumed).toBe(true);
    expect(res.body.approval.status).toBe('executed');
    expect(fakeDb.tasks).toHaveLength(0); // approved action happened once
    expect(openaiCreate).toHaveBeenCalledTimes(1); // resume itself needs no LLM
  });
});
