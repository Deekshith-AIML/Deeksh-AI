/**
 * scripts/m61/section6.ts — Phase 6.1 §6: FAILURE HANDLING & RECOVERY (LIVE).
 *
 * Simulates the failure modes named in the verification plan against the
 * isolated local stack, recording the EXACT database state after each fault
 * and classifying what recovers SAFELY (retry / automatic recovery) versus
 * what needs OPERATOR RECONCILIATION:
 *
 *   F1a — DB unreachable while CREATING an approval
 *   F1b — DB unreachable while CONSUMING an approval
 *   F2  — process killed AFTER consumption, before execution (crash-child)
 *   F3  — process killed AFTER the domain side effect, BEFORE completion
 *         was persisted — the unavoidable duplicate-action window
 *   F4  — invalid workflow state / illegal transitions
 *   F5  — missing approval row (deleted out-of-band) / corrupted payload hash
 *
 * Every scenario asserts the invariant that matters most: the protected,
 * non-idempotent operation (task.delete) can never execute twice, and no
 * failure path silently converts into an execution.
 *
 * Run (from server/):  node node_modules\tsx\dist\cli.mjs scripts\m61\section6.ts
 */

import './common.js';

import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

import {
  section,
  check,
  evidence,
  note,
  finish,
  waitMs,
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
  SHIM_URL,
  USER_A,
} from './common.js';
import { SERVER_DIR } from './env-boot.js';
import {
  requestApproval,
  approveApproval,
  rejectApproval,
  consumeApprovalForExecution,
  completeApproval,
} from '../../src/agents/approvals/approval.service.js';
import { createDomainRegistry } from '../../src/agents/register.js';
import { resumeRun } from '../../src/agents/orchestrator/orchestrator.service.js';
import { createRun, transitionRun, updateStepStatus } from '../../src/agents/workflow/workflow.store.js';
import { createTask } from '../../src/services/task.service.js';
import { AgentError } from '../../src/agents/shared/index.js';
import type { ExecutionPlan } from '../../src/agents/shared/plan.schema.js';

const TSX_CLI = path.join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CRASH_CHILD = path.join(SERVER_DIR, 'scripts', 'm61', 'crash-child.ts');

function codeOf(err: unknown): string {
  return err instanceof AgentError ? err.code : `(${err instanceof Error ? err.name : typeof err})`;
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

async function waitForRest(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${SHIM_URL}/rest/v1/agent_runs?select=id&limit=1`,
        {
          headers: {
            Authorization: `Bearer ${process.env['SUPABASE_ANON_KEY'] ?? ''}`,
            apikey: process.env['SUPABASE_ANON_KEY'] ?? '',
          },
        },
      );
      if (res.status === 200) return true;
    } catch {
      /* keep polling */
    }
    await waitMs(300);
  }
  return false;
}

function runCrashChild(mode: string, ids: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX_CLI, CRASH_CHILD, mode, ...ids], {
      cwd: SERVER_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.on('exit', (code) => resolve({ code, stdout }));
  });
}

async function main(): Promise<void> {
  section('§6 environment');
  await ensureStub();
  const tokens = await ensureTokens();
  const clientA = clientFor(tokens.a);

  // =========================================================================
  // F1a — DB down while CREATING an approval
  // =========================================================================
  section('§6.1 F1a — DB unreachable during approval CREATE');
  {
    const task = await createTask(clientA, USER_A, {
      title: 'M61 §6 F1a create-failure task',
      priority: 'medium',
      status: 'todo',
    });
    const plan: ExecutionPlan = {
      objective: 'F1a',
      steps: [
        {
          stepKey: 'delete_task',
          agent: 'task',
          operation: 'delete',
          args: { task_id: task.id },
          dependsOn: [],
          requiresApproval: true,
          timeoutMs: 30_000,
          maxRetries: 0,
        },
      ],
      requiresApproval: false,
    };
    const { run, steps } = await createRun(clientA, USER_A, { objective: 'F1a create-failure', plan });
    const step = steps[0];
    if (!step) throw new Error('F1a: no step created');

    docker(['stop', 'm61-pgrst']);
    await waitMs(700);
    const failed = await attempt(() =>
      requestApproval(clientA, USER_A, {
        runId: run.id,
        stepId: step.id,
        capability: 'task.delete',
        operation: 'delete',
        agent: 'task',
        args: { task_id: task.id },
      }),
    );
    check('F1a approval CREATE fails while the DB path is down', !failed.ok, errorText(failed.error));

    docker(['start', 'm61-pgrst']);
    const back = await waitForRest(15_000);
    check('F1a DB path restored', back);

    const partialRows = count(`SELECT * FROM agent_approvals WHERE run_id = '${run.id}'`);
    const partialAudit = count(`SELECT * FROM agent_audit_events WHERE run_id = '${run.id}'`);
    check('F1a failed create left NO partial approval row', partialRows === 0, `rows=${partialRows}`);
    check('F1a failed create left NO partial audit event', partialAudit === 0, `audit=${partialAudit}`);

    const retry = await attempt(() =>
      requestApproval(clientA, USER_A, {
        runId: run.id,
        stepId: step.id,
        capability: 'task.delete',
        operation: 'delete',
        agent: 'task',
        args: { task_id: task.id },
      }),
    );
    const retryApproval = (retry.value as { approval?: { id: string; status: string } } | undefined)?.approval;
    check('F1a SAFE RECOVERY: plain retry after restore creates the approval',
      retry.ok && retryApproval?.status === 'pending',
      retry.ok ? `status=${retryApproval?.status}` : errorText(retry.error));
    check('F1a task untouched throughout', taskExists(task.id));
    note('F1a classification', 'safe recovery by retry — no partial state, no reconciliation needed');
  }

  // =========================================================================
  // F1b — DB down while CONSUMING an approval
  // =========================================================================
  section('§6.2 F1b — DB unreachable during approval CONSUME');
  {
    const seed = await seedPausedRun(clientA, 'M61 §6 F1b consume-failure task');
    await approveApproval(clientA, USER_A, seed.approvalId);

    docker(['stop', 'm61-pgrst']);
    await waitMs(700);
    const failed = await attempt(() =>
      consumeApprovalForExecution(clientFor(tokens.a), USER_A, createDomainRegistry(), seed.approvalId),
    );
    check('F1b consumption fails while the DB path is down', !failed.ok, errorText(failed.error));

    docker(['start', 'm61-pgrst']);
    const back = await waitForRest(15_000);
    check('F1b DB path restored', back);

    check('F1b grant NOT consumed by the failed attempt (still approved)',
      approvalStatus(seed.approvalId) === 'approved', `status=${approvalStatus(seed.approvalId)}`);
    check('F1b zero approval.consumed audit events', auditCount(seed.runId, 'approval.consumed') === 0,
      `consumed=${auditCount(seed.runId, 'approval.consumed')}`);

    // Safe recovery: retry consumption, execute the REAL domain op, settle.
    const verified = await consumeApprovalForExecution(clientFor(tokens.a), USER_A, createDomainRegistry(), seed.approvalId);
    const stepRow = stepRows(seed.runId).find((s) => s['operation'] === 'delete');
    const taskId = String((stepRow?.['input_metadata'] as { task_id?: string } | null)?.task_id ?? '');
    const { taskAgent } = await import('../../src/agents/task/task.agent.js');
    const exec = await taskAgent.execute(
      { operation: 'delete', args: { task_id: taskId } },
      { userId: USER_A, client: clientFor(tokens.a), runId: seed.runId, stepId: seed.stepId, deadline: Date.now() + 5_000 },
    );
    await completeApproval(clientA, USER_A, seed.approvalId, { ok: exec.status === 'ok' });
    check('F1b SAFE RECOVERY: retried consume + execution completes normally',
      verified.approval.id === seed.approvalId &&
        exec.status === 'ok' &&
        approvalStatus(seed.approvalId) === 'executed',
      `exec=${exec.status} approval=${approvalStatus(seed.approvalId)}`);
    check('F1b task deleted exactly once on the successful retry', !taskExists(taskId));
    check('F1b exactly one consumption recorded', auditCount(seed.runId, 'approval.consumed') === 1,
      `consumed=${auditCount(seed.runId, 'approval.consumed')}`);
    note('F1b classification', 'safe recovery by retry — the CAS gate is transactional, no stuck state');
  }

  // =========================================================================
  // F2 — killed after consumption, before execution
  // =========================================================================
  section('§6.3 F2 — process killed AFTER consumption, BEFORE execution');
  {
    const seed = await seedPausedRun(clientA, 'M61 §6 F2 kill-after-consume task');
    await approveApproval(clientA, USER_A, seed.approvalId);

    const child = await runCrashChild('consume-crash', [seed.runId, seed.stepId, seed.approvalId]);
    check('F2 child died at the cut point (non-zero exit)', child.code !== 0, `exit=${child.code}`);
    evidence('F2 child output', child.stdout.trim().split('\n').slice(-4));

    const atCrash = {
      approval: approvalStatus(seed.approvalId),
      steps: stepStates(seed.runId),
      runStatus: String(runRow(seed.runId)?.['status']),
      taskExists: taskExists(seed.taskId),
      consumed: auditCount(seed.runId, 'approval.consumed'),
    };
    evidence('F2 exact DB state at crash', atCrash);
    check('F2 grant stuck EXECUTING, step running, run running at crash',
      atCrash.approval === 'executing' &&
        atCrash.steps['delete_task'] === 'running' &&
        atCrash.runStatus === 'running',
      JSON.stringify(atCrash));
    check('F2 protected op never ran at the crash point', atCrash.taskExists);

    await waitMs(1_600);
    const recovered = Number(docker(['exec', 'm61-pg', 'psql', '-U', 'postgres', '-d', 'task_assistant', '-At', '-c', 'SELECT recover_stale_agent_runs(1);']));
    check('F2 automatic recovery recovered the stale run', recovered === 1, `recovered=${recovered}`);

    const afterRecovery = {
      approval: approvalStatus(seed.approvalId),
      steps: stepStates(seed.runId),
      runStatus: String(runRow(seed.runId)?.['status']),
      runError: String(runRow(seed.runId)?.['error_code'] ?? ''),
      taskExists: taskExists(seed.taskId),
    };
    evidence('F2 exact DB state after recovery', afterRecovery);
    check('F2 run honestly failed RUNNER_INTERRUPTED (no zombie running run)',
      afterRecovery.runStatus === 'failed' && afterRecovery.runError === 'RUNNER_INTERRUPTED',
      `${afterRecovery.runStatus}/${afterRecovery.runError}`);
    check('F2 interrupted step reset to pending, completed steps preserved',
      afterRecovery.steps['delete_task'] === 'pending' &&
        afterRecovery.steps['lookup_tasks'] === 'completed',
      JSON.stringify(afterRecovery.steps));

    const resume = await attempt(() => resumeRun(clientFor(tokens.a), USER_A, seed.runId, createDomainRegistry()));
    check('F2 resume after restart does NOT execute the protected op',
      resume.ok && taskExists(seed.taskId) && auditCount(seed.runId, 'approval.executed') === 0,
      `taskExists=${taskExists(seed.taskId)} executed=${auditCount(seed.runId, 'approval.executed')}`);
    check('F2 consumption stays at exactly one', auditCount(seed.runId, 'approval.consumed') === 1);
    note('F2 classification',
      'automatic recovery restores honest run state; the stuck EXECUTING grant is reported spent to every dispatcher, so execution CANNOT re-fire — operator reconciliation (resolve the EXECUTING grant / re-plan) is needed to continue the run');
    evidence('F2 audit trail', auditRows(seed.runId).map((e) => e['event']));
  }

  // =========================================================================
  // F3 — killed AFTER domain success, BEFORE completion persisted
  // =========================================================================
  section('§6.4 F3 — process killed AFTER the side effect, BEFORE completion persisted');
  {
    const seed = await seedPausedRun(clientA, 'M61 §6 F3 kill-after-side-effect task');
    await approveApproval(clientA, USER_A, seed.approvalId);

    const child = await runCrashChild('domain-crash', [seed.runId, seed.stepId, seed.approvalId]);
    check('F3 child died after the side effect (non-zero exit)', child.code !== 0, `exit=${child.code}`);
    evidence('F3 child output', child.stdout.trim().split('\n').slice(-4));

    const atCrash = {
      approval: approvalStatus(seed.approvalId),
      steps: stepStates(seed.runId),
      runStatus: String(runRow(seed.runId)?.['status']),
      taskExists: taskExists(seed.taskId),
      consumed: auditCount(seed.runId, 'approval.consumed'),
      executed: auditCount(seed.runId, 'approval.executed'),
    };
    evidence('F3 exact DB state at crash (side effect done, completion missing)', atCrash);
    check('F3 side effect PERSISTED (task gone) but completion NOT persisted',
      !atCrash.taskExists &&
        atCrash.consumed === 1 &&
        atCrash.executed === 0 &&
        atCrash.approval === 'executing',
      JSON.stringify(atCrash));

    await waitMs(1_600);
    const recovered = Number(docker(['exec', 'm61-pg', 'psql', '-U', 'postgres', '-d', 'task_assistant', '-At', '-c', 'SELECT recover_stale_agent_runs(1);']));
    check('F3 automatic recovery recovered the stale run', recovered === 1, `recovered=${recovered}`);

    const after = {
      approval: approvalStatus(seed.approvalId),
      steps: stepStates(seed.runId),
      runStatus: String(runRow(seed.runId)?.['status']),
      taskExists: taskExists(seed.taskId),
      consumed: auditCount(seed.runId, 'approval.consumed'),
      executed: auditCount(seed.runId, 'approval.executed'),
    };
    evidence('F3 exact DB state after recovery', after);
    check('F3 recovery does not resurrect any execution (still 1 consumed, 0 executed)',
      after.consumed === 1 && after.executed === 0, JSON.stringify(after));
    check('F3 task stays deleted (effect persists exactly once)', !after.taskExists);

    // Even a forced resume/refusal path must not re-fire.
    const resume = await attempt(() => resumeRun(clientFor(tokens.a), USER_A, seed.runId, createDomainRegistry()));
    const decideAgain = await attempt(() => approveApproval(clientFor(tokens.a), USER_A, seed.approvalId));
    check('F3 resume after restart performs no new consumption',
      resume.ok && auditCount(seed.runId, 'approval.consumed') === 1,
      `consumed=${auditCount(seed.runId, 'approval.consumed')}`);
    check('F3 the stuck EXECUTING grant cannot be re-approved', !decideAgain.ok,
      codeOf(decideAgain.error));
    const attemptConsume = await attempt(() =>
      consumeApprovalForExecution(clientFor(tokens.a), USER_A, createDomainRegistry(), seed.approvalId),
    );
    check('F3 direct re-consume of the stuck grant is refused (APPROVAL_REQUIRED)',
      !attemptConsume.ok && codeOf(attemptConsume.error) === 'APPROVAL_REQUIRED',
      codeOf(attemptConsume.error));
    check('F3 protected op fired EXACTLY ONCE overall',
      auditCount(seed.runId, 'approval.consumed') === 1 && !taskExists(seed.taskId));

    note('F3 classification',
      'the unavoidable duplicate-action window: the side effect happened but its completion write never did. The system fails AT-MOST-ONCE — the EXECUTING grant blocks every re-fire path (resume, re-approve, re-consume all refuse) — but operator reconciliation is required to record the truth (mark grant/step settled) and no automatic path can prove the external effect happened.');
    evidence('F3 audit trail', auditRows(seed.runId).map((e) => e['event']));
  }

  // =========================================================================
  // F4 — invalid workflow state
  // =========================================================================
  section('§6.5 F4 — invalid workflow state is rejected without mutation');
  {
    const seed = await seedPausedRun(clientA, 'M61 §6 F4 invalid-state task');

    const illegalEdge = await attempt(() =>
      transitionRun(clientA, USER_A, seed.runId, 'completed', 'running'),
    );
    check('F4 illegal transition edge (completed → running) rejected INVALID_STATE',
      !illegalEdge.ok && codeOf(illegalEdge.error) === 'INVALID_STATE',
      codeOf(illegalEdge.error));

    const wrongFrom = await attempt(() =>
      transitionRun(clientA, USER_A, seed.runId, 'running', 'completed'),
    );
    check('F4 CAS with wrong expected-from (running ≠ actual waiting_approval) rejected',
      !wrongFrom.ok && codeOf(wrongFrom.error) === 'INVALID_STATE', codeOf(wrongFrom.error));

    const wrongStepFrom = await attempt(() =>
      updateStepStatus(clientA, USER_A, seed.stepId, 'completed', 'failed'),
    );
    check('F4 step CAS with wrong expected-from rejected INVALID_STATE',
      !wrongStepFrom.ok && codeOf(wrongStepFrom.error) === 'INVALID_STATE',
      codeOf(wrongStepFrom.error));

    check('F4 run/step unchanged after the failed transitions',
      String(runRow(seed.runId)?.['status']) === 'waiting_approval' &&
        stepStates(seed.runId)['delete_task'] === 'waiting_approval',
      JSON.stringify(stepStates(seed.runId)));

    // Decision-after-decision: reject then approve.
    await rejectApproval(clientA, USER_A, seed.approvalId);
    const lateApprove = await attempt(() => approveApproval(clientA, USER_A, seed.approvalId));
    check('F4 deciding twice (approve after reject) rejected INVALID_STATE',
      !lateApprove.ok && codeOf(lateApprove.error) === 'INVALID_STATE', codeOf(lateApprove.error));
    const consumeRejected = await attempt(() =>
      consumeApprovalForExecution(clientA, USER_A, createDomainRegistry(), seed.approvalId),
    );
    check('F4 consuming a REJECTED grant refused APPROVAL_REQUIRED',
      !consumeRejected.ok && codeOf(consumeRejected.error) === 'APPROVAL_REQUIRED',
      codeOf(consumeRejected.error));
    check('F4 rejected state intact after all invalid attempts',
      approvalStatus(seed.approvalId) === 'rejected' && taskExists(seed.taskId),
      `status=${approvalStatus(seed.approvalId)}`);
    note('F4 classification', 'every invalid state fails closed with a state conflict — no partial mutation');
  }

  // =========================================================================
  // F5 — missing / corrupted approval
  // =========================================================================
  section('§6.6 F5a — approval row missing (deleted out-of-band)');
  {
    const seed = await seedPausedRun(clientA, 'M61 §6 F5a missing-approval task');
    const oldId = seed.approvalId;
    docker(['exec', 'm61-pg', 'psql', '-U', 'postgres', '-d', 'task_assistant', '-At', '-c',
      `DELETE FROM agent_approvals WHERE id = '${oldId}';`]);
    check('F5a approval row removed (superuser fault injection)',
      approvalStatus(oldId) === '<missing>', approvalStatus(oldId));

    const resume1 = await attempt(() => resumeRun(clientA, USER_A, seed.runId, createDomainRegistry()));
    check('F5a resume with a missing approval does NOT execute anything',
      resume1.ok && taskExists(seed.taskId) && auditCount(seed.runId, 'approval.consumed') === 0,
      `taskExists=${taskExists(seed.taskId)} consumed=${auditCount(seed.runId, 'approval.consumed')}`);
    const stillPaused = {
      runStatus: String(runRow(seed.runId)?.['status']),
      steps: stepStates(seed.runId),
    };
    evidence('F5a state after resume with missing approval', stillPaused);
    check('F5a run stays paused (waiting_approval) — no silent progression',
      stillPaused.runStatus === 'waiting_approval', stillPaused.runStatus);

    // A promoted (dispatch-ready) step with a missing approval re-asks safely.
    await updateStepStatus(clientA, USER_A, seed.stepId, 'waiting_approval', 'pending');
    const resume2 = await attempt(() => resumeRun(clientA, USER_A, seed.runId, createDomainRegistry()));
    const fresh = rows<{ id: string; status: string }>(
      `SELECT id, status FROM agent_approvals WHERE run_id = '${seed.runId}' ORDER BY created_at DESC`,
    );
    check('F5a dispatch with a missing approval creates a FRESH pending approval',
      resume2.ok && fresh[0]?.status === 'pending' && fresh[0]?.id !== oldId,
      JSON.stringify(fresh));
    check('F5a still no execution — the gate re-asked instead of firing',
      taskExists(seed.taskId) && auditCount(seed.runId, 'approval.consumed') === 0,
      `consumed=${auditCount(seed.runId, 'approval.consumed')}`);
    note('F5a classification',
      'safe: absence of an approval can never substitute for one; the step either stays paused or asks again (fresh row, new decision required)');
  }

  section('§6.7 F5b — corrupted approval payload hash');
  {
    const seed = await seedPausedRun(clientA, 'M61 §6 F5b corrupted-approval task');
    await approveApproval(clientA, USER_A, seed.approvalId);
    docker(['exec', 'm61-pg', 'psql', '-U', 'postgres', '-d', 'task_assistant', '-At', '-c',
      // The column has a CHECK constraint (64 hex chars) — corrupt with a
      // well-formed hash that does NOT match the recomputed payload hash.
      `UPDATE agent_approvals SET payload_hash = repeat('0', 64) WHERE id = '${seed.approvalId}';`]);
    check('F5b hash corrupted on an APPROVED grant (superuser fault injection)',
      approvalStatus(seed.approvalId) === 'approved');

    const resume = await attempt(() => resumeRun(clientA, USER_A, seed.runId, createDomainRegistry()));
    const state = stepStates(seed.runId);
    evidence('F5b exact step states after corrupted grant', state);
    evidence('F5b run status', String(runRow(seed.runId)?.['status']));
    check('F5b integrity failure settles the step FAILED (refused, not executed)',
      state['delete_task'] === 'failed', JSON.stringify(state));
    check('F5b task intact — corrupted approval never reached the domain',
      taskExists(seed.taskId));
    check('F5b zero consumption despite the approved+corrupted row',
      auditCount(seed.runId, 'approval.consumed') === 0,
      `consumed=${auditCount(seed.runId, 'approval.consumed')}`);
    check('F5b approval row itself untouched (still approved, no execution metadata)',
      approvalStatus(seed.approvalId) === 'approved' &&
        approvalRow(seed.approvalId)?.['executed_at'] == null,
      `status=${approvalStatus(seed.approvalId)}`);

    const forced = await attempt(() =>
      consumeApprovalForExecution(clientA, USER_A, createDomainRegistry(), seed.approvalId),
    );
    check('F5b forced consumption of the corrupted grant refused INVALID_STATE',
      !forced.ok && codeOf(forced.error) === 'INVALID_STATE', codeOf(forced.error));
    check('F5b still zero consumption after the forced attempt',
      auditCount(seed.runId, 'approval.consumed') === 0);
    note('F5b classification',
      'safe: the binding hash is recomputed from the stored payload at evaluation AND at consumption — tampering fails closed, never executes');
    evidence('F5b audit trail', auditRows(seed.runId).map((e) => e['event']));
  }

  // -------------------------------------------------------------------------
  section('§6 final');
  // -------------------------------------------------------------------------
  note('duplicate-action window',
    'F3 documents the only unavoidable window: between the external side effect and the completion write the process can die; the design is at-most-once (execution never re-fires) and the residual gap is reconciled manually, never by silent re-execution');
}

main()
  .then(() => finish())
  .catch((err: unknown) => {
    console.error('[section6] fatal:', err);
    process.exitCode = 1;
    finish();
  });
