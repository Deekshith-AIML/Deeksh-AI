/**
 * scripts/m61/crash-child.ts — Phase 6.1 §4.8 / §6 crash simulation child.
 *
 * Spawned as a SEPARATE PROCESS by section4.ts / section6.ts. It mirrors
 * exactly what the real orchestrator does (resumeRun → promote step →
 * consume grant → step running → [domain op]) and then EXITS NON-ZERO at a
 * chosen cut point — modelling a backend crash/restart at that instant:
 *
 *   mode = consume-crash  → killed AFTER approval consumption, BEFORE any
 *                           domain execution (crash mid-execution).
 *   mode = domain-crash   → killed AFTER the domain side effect succeeded,
 *                           BEFORE the completion was persisted
 *                           (the duplicate-action window).
 *
 * Usage: tsx crash-child.ts <mode> <runId> <stepId> <approvalId>
 *
 * It prints the exact DB state it observed before dying so the parent can
 * assert on it.
 */

import './common.js';

import {
  clientFor,
  ensureTokens,
  approvalStatus,
  stepStates,
  taskExists,
  USER_A,
} from './common.js';
import { consumeApprovalForExecution } from '../../src/agents/approvals/approval.service.js';
import { updateStepStatus, transitionRun } from '../../src/agents/workflow/workflow.store.js';
import { createDomainRegistry } from '../../src/agents/register.js';
import { taskAgent } from '../../src/agents/task/task.agent.js';

async function main(): Promise<void> {
  const [, , mode, runId, stepId, approvalId] = process.argv;
  if (!mode || !runId || !stepId || !approvalId) {
    console.error('usage: crash-child.ts <consume-crash|domain-crash> <runId> <stepId> <approvalId>');
    process.exit(2);
  }

  const tokens = await ensureTokens();
  const client = clientFor(tokens.a);
  const registry = createDomainRegistry();

  // Mirror resumeRun + executeStep's real sequence:
  // 1. run waiting_approval → running (CAS, sets claimed_at)
  await transitionRun(client, USER_A, runId, 'waiting_approval', 'running');
  // 2. promoted waiting step → pending (seed loop of dispatchRun)
  await updateStepStatus(client, USER_A, stepId, 'waiting_approval', 'pending');
  // 3. consume the grant (APPROVED → EXECUTING) — the fail-closed gate
  const verified = await consumeApprovalForExecution(client, USER_A, registry, approvalId);
  // 4. step pending → running (the CAS executeStep performs after consuming)
  await updateStepStatus(client, USER_A, stepId, 'pending', 'running', { started: true });

  console.log(
    `[child] after consume: approval=${approvalStatus(approvalId)} steps=${JSON.stringify(stepStates(runId))}`,
  );

  if (mode === 'domain-crash') {
    // 5. the domain side effect REALLY happens (task.delete on the seeded task)
    const stepJson = await client
      .from('agent_run_steps')
      .select('input_metadata')
      .eq('id', stepId)
      .single();
    const taskId = String(
      (stepJson.data?.input_metadata as { task_id?: string } | null)?.task_id ?? '',
    );
    const result = await taskAgent.execute(
      { operation: 'delete', args: { task_id: taskId } },
      { userId: USER_A, client, runId, stepId, deadline: Date.now() + 5_000 },
    );
    console.log(
      `[child] domain executed: status=${result.status} taskExists=${taskExists(taskId)} approval=${approvalStatus(approvalId)}`,
    );
    console.log('[child] DYING before completeApproval (completion never persisted)');
    process.exit(1);
  }

  // mode === 'consume-crash'
  console.log('[child] DYING after consumption, before any domain execution');
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[child] setup failed before the crash point:', err);
  process.exit(3);
});
