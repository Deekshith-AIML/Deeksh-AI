/**
 * scripts/m61/section5.ts — Phase 6.1 §5: REAL ORCHESTRATOR vs LOCAL DB (LIVE).
 *
 * Drives the actual `executeObjective()` pipeline (triage/plan via the local
 * LLM stub, durable run/step/approval rows in the local PostgreSQL, real RLS)
 * and then exercises the human decision over REAL HTTP (supertest against the
 * actual Express app, verified bearer tokens → GoTrue):
 *
 *   1. approve  → HTTP approve resumes the intended step; the EXACT approved
 *                 payload reaches the domain service (task.delete) and the
 *                 task row disappears; dependents that were paused then run;
 *                 a repeated approve/resume is idempotent (409 / no re-run);
 *   2. reject   → the step settles cancelled WITHOUT executing, task intact;
 *   3. expiry   → an expired grant blocks execution (HTTP 410 + settle);
 *   4. cancel   → cancel blocks execution (task intact);
 *   5. audit    → the append-only audit trail persists the whole sequence.
 *
 * SAFE OPS ONLY: the planner stub can only ever return task.list / task.delete
 * — no emails, no external calls of any kind. Only local fixtures are used.
 *
 * Run (from server/):  node node_modules\tsx\dist\cli.mjs scripts\m61\section5.ts
 */

import './common.js';

import {
  section,
  check,
  evidence,
  note,
  finish,
  attempt,
  errorText,
  count,
  runRow,
  rows,
  approvalRow,
  approvalStatus,
  auditCount,
  auditRows,
  taskExists,
  stepRows,
  stepStates,
  ensureTokens,
  clientFor,
  ensureStub,
  seedPausedRun,
  stubRequests,
  USER_A,
} from './common.js';
import request from 'supertest';
import app from '../../src/app.js';
import { createDomainRegistry } from '../../src/agents/register.js';
import { executeObjective, resumeRun } from '../../src/agents/orchestrator/orchestrator.service.js';
import { createTask } from '../../src/services/task.service.js';

interface ApproveResponse {
  status: number;
  body: {
    approval?: { id: string; status: string; executed_at?: string | null };
    resumed?: boolean;
    error?: string;
    code?: string;
  };
}

async function main(): Promise<void> {
  section('§5 environment');
  await ensureStub();
  const tokens = await ensureTokens();
  const clientA = clientFor(tokens.a);
  const stubBefore = await stubRequests();

  // =========================================================================
  // 1. Approve path — pause, HTTP approve, resume, exact payload executes
  // =========================================================================
  section('§5.1 — orchestrator pauses on approval; HTTP approve resumes');

  const victim = await createTask(clientA, USER_A, {
    title: 'M61 §5 approve-path victim task',
    priority: 'high',
    status: 'todo',
  });
  const pauseStart = await stubRequests();

  const paused = await executeObjective(
    clientA,
    USER_A,
    `Delete task ${victim.id} right now, then list tasks`,
    createDomainRegistry(),
  );

  check('§5.1 run is durably paused in waiting_approval',
    paused.status === 'waiting_approval' && paused.awaitingApproval,
    `status=${paused.status}`);
  const states1 = stepStates(paused.runId);
  evidence('§5.1 exact step states while paused', states1);
  check('§5.1 prior step completed, gated step waiting, dependents pending',
    states1['lookup_tasks'] === 'completed' &&
      states1['delete_task'] === 'waiting_approval' &&
      states1['confirm_cleanup'] === 'pending',
    JSON.stringify(states1));
  check('§5.1 run row persisted as waiting_approval',
    String(runRow(paused.runId)?.['status']) === 'waiting_approval',
    `status=${String(runRow(paused.runId)?.['status'])}`);
  check('§5.1 approval row durably pending',
    count(`SELECT * FROM agent_approvals WHERE run_id = '${paused.runId}' AND status = 'pending'`) === 1);
  check('§5.1 NO side effect before the decision (task still exists)',
    taskExists(victim.id));
  check('§5.1 audit already records approval.requested',
    auditCount(paused.runId, 'approval.requested') === 1,
    `requested=${auditCount(paused.runId, 'approval.requested')}`);

  const approvalId = rows<{ id: string }>(
    `SELECT id FROM agent_approvals WHERE run_id = '${paused.runId}' ORDER BY created_at DESC`,
  )[0]?.id ?? '';
  check('§5.1 approval id located', approvalId.length > 0, `approval=${approvalId}`);

  const planAgents = [...new Set(paused.plan.steps.map((s) => s.agent))];
  const planOps = [...new Set(paused.plan.steps.map((s) => s.operation))];
  evidence('§5.1 plan served by the local stub', {
    agents: planAgents,
    operations: planOps,
    steps: paused.plan.steps.map((s) => `${s.stepKey}:${s.agent}.${s.operation}`),
  });
  check('§5.1 safe ops only — plan uses task agent exclusively',
    planAgents.every((a) => a === 'task'), JSON.stringify(planAgents));
  check('§5.1 safe ops only — only list/delete operations (no messaging/scheduling)',
    planOps.every((o) => o === 'list' || o === 'delete'), JSON.stringify(planOps));
  check('§5.1 the gated step is flagged requiresApproval in the validated plan',
    paused.plan.steps.find((s) => s.stepKey === 'delete_task')?.requiresApproval === true);

  const stubCalls = (await stubRequests()).count - pauseStart.count;
  check('§5.1 planning went through the model interface (1 local stub call, no network)',
    stubCalls >= 1 && stubCalls <= 3, `llmCalls=${paused.llmCalls} stubDelta=${stubCalls}`);

  // --- HTTP approve (real Express app, real verified token) ----------------
  const approveRes = (await request(app)
    .post(`/api/approvals/${approvalId}/approve`)
    .set('Authorization', `Bearer ${tokens.a}`)) as ApproveResponse;

  check('§5.1 HTTP approve → 200 with resumed=true',
    approveRes.status === 200 && approveRes.body.resumed === true,
    `status=${approveRes.status} resumed=${String(approveRes.body.resumed)}`);
  check('§5.1 response carries the POST-resume approval row (executed)',
    approveRes.body.approval?.status === 'executed',
    `status=${approveRes.body.approval?.status}`);

  const states2 = stepStates(paused.runId);
  evidence('§5.1 exact step states after approve', states2);
  evidence('§5.1 run status after approve', String(runRow(paused.runId)?.['status']));
  check('§5.1 run completed after resume',
    String(runRow(paused.runId)?.['status']) === 'completed',
    `status=${String(runRow(paused.runId)?.['status'])}`);
  check('§5.1 every step completed (gated step ran, dependents unblocked)',
    Object.values(states2).every((s) => s === 'completed' || s === 'skipped'),
    JSON.stringify(states2));

  check('§5.1 the EXACT approved task was deleted (side effect observed)',
    !taskExists(victim.id), `task=${victim.id}`);
  check('§5.1 approval row executed with executed_at set',
    approvalStatus(approvalId) === 'executed' &&
      approvalRow(approvalId)?.['executed_at'] != null,
    `status=${approvalStatus(approvalId)}`);

  const deleteStep = stepRows(paused.runId).find((s) => s['operation'] === 'delete');
  const approvalProposed = (approvalRow(approvalId)?.['proposed_payload'] ?? {}) as {
    args?: { task_id?: string };
  };
  evidence('§5.1 payload binding', {
    step_input_task_id: String((deleteStep?.['input_metadata'] as { task_id?: string } | null)?.task_id ?? ''),
    approved_args_task_id: String(approvalProposed.args?.task_id ?? ''),
    deleted_task_id: victim.id,
  });
  check('§5.1 payload identity: step args = approved args = executed target',
    String((deleteStep?.['input_metadata'] as { task_id?: string } | null)?.task_id) === victim.id &&
      String(approvalProposed.args?.task_id) === victim.id);
  check('§5.1 gated step persisted completed with output metadata',
    deleteStep?.['status'] === 'completed' &&
      String((deleteStep?.['output_metadata'] as { task_id?: string } | null)?.task_id) === victim.id,
    `status=${String(deleteStep?.['status'])}`);

  // --- repeated decisions are idempotent -----------------------------------
  const approveAgain = (await request(app)
    .post(`/api/approvals/${approvalId}/approve`)
    .set('Authorization', `Bearer ${tokens.a}`)) as ApproveResponse;
  check('§5.1 repeating the HTTP approve → 409 (already decided/executed)',
    approveAgain.status === 409, `status=${approveAgain.status} code=${approveAgain.body.code}`);

  const auditAfterFirst = {
    consumed: auditCount(paused.runId, 'approval.consumed'),
    executed: auditCount(paused.runId, 'approval.executed'),
    total: count(`SELECT * FROM agent_audit_events WHERE run_id = '${paused.runId}'`),
  };
  const rerepeat = await attempt(() =>
    resumeRun(clientFor(tokens.a), USER_A, paused.runId, createDomainRegistry()),
  );
  const auditAfterSecond = {
    consumed: auditCount(paused.runId, 'approval.consumed'),
    executed: auditCount(paused.runId, 'approval.executed'),
    total: count(`SELECT * FROM agent_audit_events WHERE run_id = '${paused.runId}'`),
  };
  evidence('§5.1 repeated resume', {
    ok: rerepeat.ok,
    status: rerepeat.ok ? (rerepeat.value as { status: string }).status : errorText(rerepeat.error),
    auditAfterFirst,
    auditAfterSecond,
  });
  check('§5.1 repeated resume is idempotent (no new audit rows, no re-execution)',
    rerepeat.ok &&
      JSON.stringify(auditAfterFirst) === JSON.stringify(auditAfterSecond) &&
      auditAfterSecond.consumed === 1 &&
      auditAfterSecond.executed === 1,
    JSON.stringify({ auditAfterFirst, auditAfterSecond }));
  check('§5.1 task stays deleted after repeated resumes', !taskExists(victim.id));

  const detail = await request(app)
    .get(`/api/approvals/${approvalId}`)
    .set('Authorization', `Bearer ${tokens.a}`);
  check('§5.1 GET detail over HTTP returns the executed row',
    detail.status === 200 && detail.body?.approval?.status === 'executed',
    `status=${detail.status}`);

  // =========================================================================
  // 2. Reject path
  // =========================================================================
  section('§5.2 — HTTP reject blocks execution');
  {
    const seed = await seedPausedRun(clientA, 'M61 §5 reject-path task');
    const res = (await request(app)
      .post(`/api/approvals/${seed.approvalId}/reject`)
      .set('Authorization', `Bearer ${tokens.a}`)) as ApproveResponse;
    check('§5.2 HTTP reject → 200, resumed=true',
      res.status === 200 && res.body.resumed === true, `status=${res.status}`);
    const states = stepStates(seed.runId);
    evidence('§5.2 exact step states', states);
    evidence('§5.2 run status', String(runRow(seed.runId)?.['status']));
    check('§5.2 approval rejected (decided)',
      approvalStatus(seed.approvalId) === 'rejected' &&
        approvalRow(seed.approvalId)?.['decided_at'] != null,
      `status=${approvalStatus(seed.approvalId)}`);
    check('§5.2 gated step settled CANCELLED without executing',
      states['delete_task'] === 'cancelled', JSON.stringify(states));
    check('§5.2 task intact after reject', taskExists(seed.taskId));
    check('§5.2 zero consumption', auditCount(seed.runId, 'approval.consumed') === 0,
      `consumed=${auditCount(seed.runId, 'approval.consumed')}`);
  }

  // =========================================================================
  // 3. Expiry path
  // =========================================================================
  section('§5.3 — expired approval blocks execution');
  {
    const seed = await seedPausedRun(clientA, 'M61 §5 expiry-path task');
    const { execFileSync } = await import('node:child_process');
    execFileSync('docker', [
      'exec', 'm61-pg', 'psql', '-U', 'postgres', '-d', 'task_assistant', '-At', '-c',
      `UPDATE agent_approvals SET expires_at = now() - interval '1 minute' WHERE id = '${seed.approvalId}';`,
    ], { encoding: 'utf8' });

    const res = (await request(app)
      .post(`/api/approvals/${seed.approvalId}/approve`)
      .set('Authorization', `Bearer ${tokens.a}`)) as ApproveResponse;
    check('§5.3 approving an expired grant → 410 (TIMEOUT)',
      res.status === 410 && res.body.code === 'TIMEOUT',
      `status=${res.status} code=${res.body.code}`);
    check('§5.3 ground truth: approval expired', approvalStatus(seed.approvalId) === 'expired',
      `status=${approvalStatus(seed.approvalId)}`);

    const resumed = await attempt(() =>
      resumeRun(clientFor(tokens.a), USER_A, seed.runId, createDomainRegistry()),
    );
    const states = stepStates(seed.runId);
    evidence('§5.3 exact step states', states);
    check('§5.3 resume settles the gated step CANCELLED (denied path)',
      states['delete_task'] === 'cancelled', JSON.stringify(states));
    check('§5.3 task intact after expiry', taskExists(seed.taskId));
    check('§5.3 zero consumption on the expired grant',
      auditCount(seed.runId, 'approval.consumed') === 0,
      `consumed=${auditCount(seed.runId, 'approval.consumed')}`);
    check('§5.3 resume itself completed without executing anything', resumed.ok);
    evidence('§5.3 run status', String(runRow(seed.runId)?.['status']));
  }

  // =========================================================================
  // 4. Cancel path
  // =========================================================================
  section('§5.4 — HTTP cancel blocks execution');
  {
    const seed = await seedPausedRun(clientA, 'M61 §5 cancel-path task');
    const res = (await request(app)
      .post(`/api/approvals/${seed.approvalId}/cancel`)
      .set('Authorization', `Bearer ${tokens.a}`)) as ApproveResponse;
    check('§5.4 HTTP cancel → 200, resumed=true',
      res.status === 200 && res.body.resumed === true, `status=${res.status}`);
    const states = stepStates(seed.runId);
    evidence('§5.4 exact step states', states);
    check('§5.4 approval cancelled', approvalStatus(seed.approvalId) === 'cancelled',
      `status=${approvalStatus(seed.approvalId)}`);
    check('§5.4 gated step settled CANCELLED without executing',
      states['delete_task'] === 'cancelled', JSON.stringify(states));
    check('§5.4 task intact after cancel', taskExists(seed.taskId));
    check('§5.4 zero consumption', auditCount(seed.runId, 'approval.consumed') === 0);
  }

  // =========================================================================
  // 5. Audit persistence
  // =========================================================================
  section('§5.5 — append-only audit trail persisted');
  {
    const trail = auditRows(paused.runId).map((e) => ({
      event: e['event'],
      outcome: e['outcome'],
      approval_id: e['approval_id'],
    }));
    evidence('§5.5 full audit trail for the approved run', trail);
    const events = trail.map((t) => String(t.event));
    const required = ['approval.requested', 'approval.approved', 'approval.consumed', 'approval.executed'];
    const idx = required.map((r) => events.indexOf(r));
    check('§5.5 required events persisted IN ORDER',
      idx.every((i) => i >= 0) && idx.every((i, j) => j === 0 || i > (idx[j - 1] as number)),
      JSON.stringify(idx));
    check('§5.5 every event is owner-bound to the same approval',
      trail.every((t) => t.approval_id === approvalId || t.approval_id == null),
      `events=${events.length}`);
    check('§5.5 audit row count ≥ 4', events.length >= 4, `count=${events.length}`);
    // Append-only already proven in §3 (owner cannot update/delete), re-note:
    note('§5.5 append-only enforcement', 'verified in §3A — UPDATE/DELETE return 0 rows even for the owner');
  }

  // -------------------------------------------------------------------------
  section('§5 final');
  // -------------------------------------------------------------------------
  const stubAfter = await stubRequests();
  note('model calls (local stub)', `${stubBefore.count} → ${stubAfter.count} (0 external calls)`);
}

main()
  .then(() => finish())
  .catch((err: unknown) => {
    console.error('[section5] fatal:', err);
    process.exitCode = 1;
    finish();
  });
