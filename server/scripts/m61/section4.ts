/**
 * scripts/m61/section4.ts — Phase 6.1 §4: CONCURRENCY (LIVE).
 *
 * Eight named concurrency scenarios, each against the REAL local database
 * through REAL user-scoped clients (one client per concurrent actor —
 * mirroring one HTTP request per actor in production):
 *
 *   T1 concurrent consume            — N parallel consumptions of one APPROVED grant
 *   T2 concurrent decisions          — approve vs reject race on one PENDING grant
 *   T3 expiry race                   — consume/list/decide against an expired grant
 *   T4 cancel race                   — cancel vs consume race
 *   T5 concurrent resumes            — N parallel resumeRun() on the paused run
 *   T6 duplicate resume after success— repeats after terminal state
 *   T7 backend failure after consume — domain op fails AFTER the grant was spent
 *   T8 backend restart during execution — process killed after consumption
 *
 * For every test the EXACT database state (approval row, step states, run
 * status, audit counts) is printed as evidence and asserted on. The protected
 * operation (task.delete, non-idempotent) must never execute more than once.
 *
 * Run (from server/):  node node_modules\tsx\dist\cli.mjs scripts\m61\section4.ts
 */

import './common.js';

import { spawn } from 'node:child_process';
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
  rows as selectRows,
  runRow,
  scalarText,
  auditRows,
  approvalRow,
  approvalStatus,
  auditCount,
  taskExists,
  stepRows,
  stepStates,
  ensureTokens,
  clientFor,
  ensureStub,
  seedPausedRun,
  USER_A,
} from './common.js';
import { SERVER_DIR } from './env-boot.js';
import {
  approveApproval,
  rejectApproval,
  cancelApproval,
  consumeApprovalForExecution,
  completeApproval,
  listApprovals,
  evaluateStepApproval,
} from '../../src/agents/approvals/approval.service.js';
import { createDomainRegistry } from '../../src/agents/register.js';
import { resumeRun } from '../../src/agents/orchestrator/orchestrator.service.js';
import { AgentError } from '../../src/agents/shared/index.js';
import type { TokenPair } from './common.js';

const TSX_CLI = path.join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CRASH_CHILD = path.join(SERVER_DIR, 'scripts', 'm61', 'crash-child.ts');

function codeOf(err: unknown): string {
  return err instanceof AgentError ? err.code : `(${err instanceof Error ? err.name : typeof err})`;
}

interface ChildOutcome {
  code: number | null;
  stdout: string;
}

function runCrashChild(mode: string, ids: string[]): Promise<ChildOutcome> {
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
  section('§4 environment');
  await ensureStub();
  const tokens: TokenPair = await ensureTokens();
  const newRegistry = createDomainRegistry;
  note('actors', 'each concurrent actor uses its own user-scoped client');

  // =========================================================================
  // T1 — concurrent consume
  // =========================================================================
  section('§4.1 T1 — concurrent consume of one APPROVED grant');
  {
    const c = clientFor(tokens.a);
    const seed = await seedPausedRun(c, 'M61 §4.1 consume-race task');
    check('T1 seed paused', seed.paused, `approval=${seed.approvalId}`);
    await approveApproval(c, USER_A, seed.approvalId);

    const actors = Array.from({ length: 8 }, () => clientFor(tokens.a));
    const settled = await Promise.allSettled(
      actors.map((cl) => consumeApprovalForExecution(cl, USER_A, newRegistry(), seed.approvalId)),
    );
    const wins = settled.filter((s) => s.status === 'fulfilled').length;
    const lossCodes = settled
      .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      .map((s) => codeOf(s.reason));

    check('T1 exactly ONE of 8 consumers wins the CAS', wins === 1, `wins=${wins}`);
    check('T1 every loser is rejected (APPROVAL_REQUIRED or CAS conflict INVALID_STATE)',
      lossCodes.length === 7 &&
        lossCodes.every((c2) => c2 === 'APPROVAL_REQUIRED' || c2 === 'INVALID_STATE'),
      JSON.stringify(lossCodes));
    check('T1 ground truth: approval is EXECUTING (single hand-off)',
      approvalStatus(seed.approvalId) === 'executing', `status=${approvalStatus(seed.approvalId)}`);
    check('T1 ground truth: exactly ONE approval.consumed audit event',
      auditCount(seed.runId, 'approval.consumed') === 1,
      `consumed=${auditCount(seed.runId, 'approval.consumed')}`);
    evidence('T1 approval row', approvalRow(seed.approvalId));

    // This test exercises the GATE only (no domain call was attempted).
    // Settle honestly with an explicit harness error code.
    await completeApproval(c, USER_A, seed.approvalId, {
      ok: false,
      errorCode: 'TEST_ONLY_NO_DOMAIN_CALL',
    });
    check('T1 consumed grant settles to a terminal state (failed)',
      approvalStatus(seed.approvalId) === 'failed', `status=${approvalStatus(seed.approvalId)}`);
    check('T1 task untouched (this test never executed the domain op)',
      taskExists(seed.taskId));
  }

  // =========================================================================
  // T2 — concurrent decisions
  // =========================================================================
  section('§4.2 T2 — concurrent approve/reject decisions on one PENDING grant');
  {
    const c = clientFor(tokens.a);
    const seed = await seedPausedRun(c, 'M61 §4.2 decision-race task');
    check('T2 seed pending', approvalStatus(seed.approvalId) === 'pending',
      `status=${approvalStatus(seed.approvalId)}`);

    const actors = Array.from({ length: 8 }, (_, i) => ({
      client: clientFor(tokens.a),
      decide: i % 2 === 0 ? 'approve' : 'reject',
    }));
    const settled = await Promise.allSettled(
      actors.map((a) =>
        a.decide === 'approve'
          ? approveApproval(a.client, USER_A, seed.approvalId)
          : rejectApproval(a.client, USER_A, seed.approvalId),
      ),
    );
    const wins = settled.filter((s) => s.status === 'fulfilled').length;
    const lossCodes = settled
      .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      .map((s) => codeOf(s.reason));

    check('T2 exactly ONE decision wins (4 approve vs 4 reject)', wins === 1, `wins=${wins}`);
    check('T2 losers are all rejected INVALID_STATE',
      lossCodes.length === 7 && lossCodes.every((c2) => c2 === 'INVALID_STATE'),
      JSON.stringify(lossCodes));
    const finalStatus = approvalStatus(seed.approvalId);
    check('T2 final status is one of approved/rejected',
      finalStatus === 'approved' || finalStatus === 'rejected', `status=${finalStatus}`);
    const decidedEvents =
      auditCount(seed.runId, 'approval.approved') + auditCount(seed.runId, 'approval.rejected');
    check('T2 exactly ONE decided audit event', decidedEvents === 1, `decided=${decidedEvents}`);
    evidence('T2 approval row', approvalRow(seed.approvalId));
    check('T2 no side effect from a decision race (task intact)', taskExists(seed.taskId));
  }

  // =========================================================================
  // T3 — expiry race
  // =========================================================================
  section('§4.3 T3 — expiry race (consume/list/decide on an expired grant)');
  {
    const c = clientFor(tokens.a);
    const seed = await seedPausedRun(c, 'M61 §4.3 expiry-race task');
    await approveApproval(c, USER_A, seed.approvalId);
    // Simulate the TTL elapsing (ground truth, superuser clock shift).
    const { execFileSync } = await import('node:child_process');
    execFileSync('docker', [
      'exec', 'm61-pg', 'psql', '-U', 'postgres', '-d', 'task_assistant', '-At', '-c',
      `UPDATE agent_approvals SET expires_at = now() - interval '1 second' WHERE id = '${seed.approvalId}';`,
    ], { encoding: 'utf8' });
    check('T3 approval backdated past its TTL', approvalStatus(seed.approvalId) === 'approved',
      `expires_at=${String(approvalRow(seed.approvalId)?.['expires_at'])}`);

    const actors = Array.from({ length: 4 }, () => clientFor(tokens.a));
    const settled = await Promise.allSettled([
      ...actors.map((cl) => consumeApprovalForExecution(cl, USER_A, newRegistry(), seed.approvalId)),
      approveApproval(clientFor(tokens.a), USER_A, seed.approvalId),
      listApprovals(clientFor(tokens.a), USER_A), // lazy expiry sweep
    ]);
    const wins = settled.filter((s) => s.status === 'fulfilled' && !isListResult(s.value)).length;
    const codes = settled
      .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      .map((s) => codeOf(s.reason));

    check('T3 NO consumption or decision can win after expiry', wins === 0, `wins=${wins}`);
    check('T3 every loser is TIMEOUT, APPROVAL_REQUIRED or CAS conflict INVALID_STATE',
      codes.every((x) => x === 'TIMEOUT' || x === 'APPROVAL_REQUIRED' || x === 'INVALID_STATE'),
      JSON.stringify(codes));
    check('T3 ground truth: approval swept to EXPIRED', approvalStatus(seed.approvalId) === 'expired',
      `status=${approvalStatus(seed.approvalId)}`);
    check('T3 zero approval.consumed audit events', auditCount(seed.runId, 'approval.consumed') === 0,
      `consumed=${auditCount(seed.runId, 'approval.consumed')}`);
    check('T3 expiry is audited', auditCount(seed.runId, 'approval.expired') >= 1,
      `expired=${auditCount(seed.runId, 'approval.expired')}`);
    check('T3 task untouched', taskExists(seed.taskId));
    evidence('T3 approval row', approvalRow(seed.approvalId));
  }

  // =========================================================================
  // T4 — cancel race vs consume
  // =========================================================================
  section('§4.4 T4 — cancel race against consumption');
  {
    const c = clientFor(tokens.a);
    const seed = await seedPausedRun(c, 'M61 §4.4 cancel-race task');
    await approveApproval(c, USER_A, seed.approvalId);

    const consumers = Array.from({ length: 4 }, () => clientFor(tokens.a));
    const settled = await Promise.allSettled([
      cancelApproval(clientFor(tokens.a), USER_A, seed.approvalId),
      ...consumers.map((cl) => consumeApprovalForExecution(cl, USER_A, newRegistry(), seed.approvalId)),
    ]);
    const outcomes = settled.map((s) => (s.status === 'fulfilled' ? 'win' : codeOf(s.reason)));
    const cancelWins = outcomes[0] === 'win';
    const consumeWins = outcomes.slice(1).filter((o) => o === 'win').length;

    check('T4 exactly one side of the race wins (cancel XOR consume)',
      Number(cancelWins) + consumeWins === 1,
      `cancel=${cancelWins} consume=${consumeWins} outcomes=${JSON.stringify(outcomes)}`);
    check('T4 at most ONE consumption ever', consumeWins <= 1, `consume=${consumeWins}`);
    const status = approvalStatus(seed.approvalId);
    const consumed = auditCount(seed.runId, 'approval.consumed');
    if (cancelWins) {
      check('T4 cancel won → approval CANCELLED', status === 'cancelled', `status=${status}`);
      check('T4 cancel won → zero consumption', consumed === 0, `consumed=${consumed}`);
      check('T4 cancel won → task intact (protected op never ran)', taskExists(seed.taskId));
    } else {
      check('T4 consume won → approval EXECUTING', status === 'executing', `status=${status}`);
      check('T4 consume won → exactly one consumption', consumed === 1, `consumed=${consumed}`);
      check('T4 consume won → cancel rejected INVALID_STATE',
        outcomes[0] === 'INVALID_STATE', `outcome=${outcomes[0]}`);
      await completeApproval(c, USER_A, seed.approvalId, {
        ok: false,
        errorCode: 'TEST_ONLY_NO_DOMAIN_CALL',
      });
    }
    evidence('T4 approval row', approvalRow(seed.approvalId));
    evidence('T4 race outcomes', outcomes);
  }

  // =========================================================================
  // T5 — concurrent resumes
  // =========================================================================
  section('§4.5 T5 — concurrent resumeRun() after approval');
  {
    const c = clientFor(tokens.a);
    const seed = await seedPausedRun(c, 'M61 §4.5 concurrent-resume task');
    await approveApproval(c, USER_A, seed.approvalId);

    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () => resumeRun(clientFor(tokens.a), USER_A, seed.runId, newRegistry())),
    );
    const results = settled.map((s) =>
      s.status === 'fulfilled'
        ? { ok: true, status: s.value.status }
        : { ok: false, error: errorText(s.reason) },
    );
    evidence('T5 resumeRun outcomes', results);

    const consumed = auditCount(seed.runId, 'approval.consumed');
    const executed = auditCount(seed.runId, 'approval.executed');
    const taskGone = !taskExists(seed.taskId);
    const delStep = stepRows(seed.runId).find((s) => s['operation'] === 'delete');

    check('T5 at-most-once: approval.consumed ≤ 1', consumed <= 1, `consumed=${consumed}`);
    check('T5 at-most-once: approval.executed ≤ 1', executed <= 1, `executed=${executed}`);
    check('T5 side effect happens IFF the grant reached EXECUTED',
      taskGone === (executed === 1), `taskGone=${taskGone} executed=${executed}`);
    check('T5 non-idempotent step never retried (retry_count = 0)',
      Number(delStep?.['retry_count'] ?? -1) === 0, `retry_count=${String(delStep?.['retry_count'])}`);
    check('T5 approval is in a terminal/consistent hand-off state',
      ['executed', 'failed', 'executing'].includes(approvalStatus(seed.approvalId)),
      `status=${approvalStatus(seed.approvalId)}`);
    evidence('T5 step states (exact DB)', stepStates(seed.runId));
    evidence('T5 run status', String(runRow(seed.runId)?.['status']));
    note('T5 analysis', `consumed=${consumed} executed=${executed} task_deleted=${taskGone}`);
  }

  // =========================================================================
  // T6 — duplicate resume after success
  // =========================================================================
  section('§4.6 T6 — duplicate resume after the run already succeeded');
  {
    const c = clientFor(tokens.a);
    const seed = await seedPausedRun(c, 'M61 §4.6 duplicate-resume task');
    await approveApproval(c, USER_A, seed.approvalId);
    const first = await resumeRun(c, USER_A, seed.runId, newRegistry());
    check('T6 baseline resume completes the run', first.status === 'completed', `status=${first.status}`);
    check('T6 baseline: task deleted exactly once', !taskExists(seed.taskId));

    const before = {
      consumed: auditCount(seed.runId, 'approval.consumed'),
      executed: auditCount(seed.runId, 'approval.executed'),
      auditTotal: count(`SELECT * FROM agent_audit_events WHERE run_id = '${seed.runId}'`),
      stepStates: stepStates(seed.runId),
    };

    const repeats = [];
    for (let i = 0; i < 3; i++) {
      const r = await attempt(() => resumeRun(clientFor(tokens.a), USER_A, seed.runId, newRegistry()));
      repeats.push(r.ok ? { ok: true, status: (r.value as { status: string }).status } : { ok: false, error: errorText(r.error) });
    }
    const after = {
      consumed: auditCount(seed.runId, 'approval.consumed'),
      executed: auditCount(seed.runId, 'approval.executed'),
      auditTotal: count(`SELECT * FROM agent_audit_events WHERE run_id = '${seed.runId}'`),
      stepStates: stepStates(seed.runId),
    };
    evidence('T6 before/after repeats', { before, after, repeats });

    check('T6 repeated resumes all return the terminal result without error',
      repeats.every((r) => r.ok === true && r.status === 'completed'),
      JSON.stringify(repeats));
    check('T6 NO new consumption on repeats', after.consumed === before.consumed,
      `consumed ${before.consumed} → ${after.consumed}`);
    check('T6 NO new execution on repeats', after.executed === before.executed,
      `executed ${before.executed} → ${after.executed}`);
    check('T6 NO new audit rows on repeats', after.auditTotal === before.auditTotal,
      `audit ${before.auditTotal} → ${after.auditTotal}`);
    check('T6 step states unchanged after repeats',
      JSON.stringify(after.stepStates) === JSON.stringify(before.stepStates));
    check('T6 task stays deleted (never resurrected)', !taskExists(seed.taskId));

    const decideAgain = await attempt(() => approveApproval(clientFor(tokens.a), USER_A, seed.approvalId));
    check('T6 deciding again on the executed grant → INVALID_STATE',
      !decideAgain.ok && codeOf(decideAgain.error) === 'INVALID_STATE', codeOf(decideAgain.error));
  }

  // =========================================================================
  // T7 — backend failure AFTER consumption
  // =========================================================================
  section('§4.7 T7 — backend failure after the grant was consumed');
  {
    const c = clientFor(tokens.a);
    const seed = await seedPausedRun(c, 'M61 §4.7 backend-failure task');
    await approveApproval(c, USER_A, seed.approvalId);

    // Simulate the world changing between approval and execution: the target
    // task disappears (deleted by the owner through another request).
    const del = await c.from('tasks').delete().eq('id', seed.taskId).eq('user_id', USER_A);
    check('T7 precondition: task removed externally after approval', !del.error && !taskExists(seed.taskId),
      del.error ? del.error.message : 'deleted externally');

    const r = await attempt(() => resumeRun(clientFor(tokens.a), USER_A, seed.runId, newRegistry()));
    evidence('T7 resume outcome', r.ok ? (r.value as { status: string }).status : errorText(r.error));

    const step = stepRows(seed.runId).find((s) => s['operation'] === 'delete');
    evidence('T7 delete step row', step);

    check('T7 grant consumed exactly once', auditCount(seed.runId, 'approval.consumed') === 1,
      `consumed=${auditCount(seed.runId, 'approval.consumed')}`);
    check('T7 grant settled FAILED (terminal — spent either way)',
      approvalStatus(seed.approvalId) === 'failed', `status=${approvalStatus(seed.approvalId)}`);
    check('T7 execution failure audited', auditCount(seed.runId, 'approval.execution_failed') === 1,
      `events=${auditCount(seed.runId, 'approval.execution_failed')}`);
    check('T7 zero executions recorded', auditCount(seed.runId, 'approval.executed') === 0);
    check('T7 step failed with the domain error code',
      step?.['status'] === 'failed' && step['error_code'] === 'UNRESOLVED_REFERENCE',
      `status=${String(step?.['status'])} code=${String(step?.['error_code'])}`);

    // Replays must not re-fire the protected operation.
    const replay = await attempt(() => resumeRun(clientFor(tokens.a), USER_A, seed.runId, newRegistry()));
    const consumedAfter = auditCount(seed.runId, 'approval.consumed');
    check('T7 replay after failure performs NO new consumption',
      replay.ok && consumedAfter === 1, `consumed=${consumedAfter} replay=${replay.ok}`);
    const decideAfter = await attempt(() => approveApproval(clientFor(tokens.a), USER_A, seed.approvalId));
    check('T7 the failed grant cannot be re-approved', !decideAfter.ok,
      codeOf(decideAfter.error));
    evidence('T7 step states (exact DB)', stepStates(seed.runId));
    evidence('T7 run status', String(runRow(seed.runId)?.['status']));
  }

  // =========================================================================
  // T8 — backend restart during execution
  // =========================================================================
  section('§4.8 T8 — backend process killed after consumption (restart mid-execution)');
  {
    const c = clientFor(tokens.a);
    const seed = await seedPausedRun(c, 'M61 §4.8 restart-mid-execution task');
    await approveApproval(c, USER_A, seed.approvalId);

    const child = await runCrashChild('consume-crash', [seed.runId, seed.stepId, seed.approvalId]);
    check('T8 child process died mid-execution (non-zero exit)', child.code !== 0, `exit=${child.code}`);
    evidence('T8 child stdout', child.stdout.trim().split('\n').slice(-6));

    const pre = {
      approval: approvalStatus(seed.approvalId),
      steps: stepStates(seed.runId),
      runStatus: String(runRow(seed.runId)?.['status']),
      taskExists: taskExists(seed.taskId),
    };
    evidence('T8 state after crash / before recovery', pre);
    check('T8 crash left the grant stuck in EXECUTING', pre.approval === 'executing', `status=${pre.approval}`);
    check('T8 crash left the step RUNNING', pre.steps['delete_task'] === 'running',
      `steps=${JSON.stringify(pre.steps)}`);
    check('T8 the protected operation never ran (task still exists)', pre.taskExists);

    await waitMs(1_600); // claimed_at must be older than the staleness window
    const recovered = scalarText('SELECT recover_stale_agent_runs(1);');
    check('T8 recovery function recovered exactly one run', recovered === '1', `recovered=${recovered}`);

    const post = {
      approval: approvalStatus(seed.approvalId),
      steps: stepStates(seed.runId),
      runStatus: String(runRow(seed.runId)?.['status']),
      runError: String(runRow(seed.runId)?.['error_code'] ?? ''),
      taskExists: taskExists(seed.taskId),
    };
    evidence('T8 state after recovery', post);
    check('T8 run marked failed RUNNER_INTERRUPTED (honest, no zombie running run)',
      post.runStatus === 'failed' && post.runError === 'RUNNER_INTERRUPTED',
      `status=${post.runStatus} error=${post.runError}`);
    check('T8 interrupted step reset to pending (completed steps are preserved)',
      post.steps['delete_task'] === 'pending' && post.steps['lookup_tasks'] === 'completed',
      `steps=${JSON.stringify(post.steps)}`);

    const r = await attempt(() => resumeRun(clientFor(tokens.a), USER_A, seed.runId, newRegistry()));
    const consumed = auditCount(seed.runId, 'approval.consumed');
    const executed = auditCount(seed.runId, 'approval.executed');
    evidence('T8 resume-after-recovery', r.ok ? (r.value as { status: string }).status : errorText(r.error));
    check('T8 resume after restart does NOT re-execute (consumed still 1, executed 0)',
      r.ok && consumed === 1 && executed === 0, `consumed=${consumed} executed=${executed}`);
    check('T8 task still exists — protected op ran at most once', taskExists(seed.taskId));
    check('T8 stuck EXECUTING grant is reported as SPENT to any later dispatcher',
      approvalStatus(seed.approvalId) === 'executing', `status=${approvalStatus(seed.approvalId)}`);
    const evalState = await evaluateStepApproval(clientFor(tokens.a), USER_A, seed.stepId);
    check('T8 evaluateStepApproval classifies the stuck grant as spent',
      evalState.kind === 'spent', `kind=${evalState.kind}`);
    note('T8 reconciliation need', 'stuck EXECUTING grant + pending step under a failed run require operator reconciliation; no automated path re-fires the protected operation');
    evidence('T8 audit trail', auditRows(seed.runId).map((e) => e['event']));
  }

  // -------------------------------------------------------------------------
  section('§4 final');
  // -------------------------------------------------------------------------
  note('protected operation', 'task.delete (non-idempotent) — executed at most once across all races');
}

function isListResult(value: unknown): boolean {
  return Array.isArray(value);
}

main()
  .then(() => finish())
  .catch((err: unknown) => {
    console.error('[section4] fatal:', err);
    process.exitCode = 1;
    finish();
  });
