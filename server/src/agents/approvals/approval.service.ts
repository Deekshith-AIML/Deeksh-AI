/**
 * Phase 6 — Approval service (M6 Multi-Agent Orchestration Engine).
 *
 * Implements backend-enforced human approval for side-effecting agent
 * operations. The flow:
 *
 *   1. Orchestrator reaches a step whose capability (or plan flag) marks it
 *      approval-required. If no matching ACTIVE approval exists, one is
 *      created (PENDING, time-limited, payload-hash bound) and the step
 *      waits. No side effect has happened yet.
 *   2. The authenticated user decides via the API: approve (PENDING →
 *      APPROVED) or reject (PENDING → REJECTED). Identity comes ONLY from
 *      the verified token — bodies never carry it.
 *   3. When an approved approval exists for exactly that step
 *      (same user/run/step/capability/operation/args — hash verified), the
 *      orchestrator/executing call consumes it: APPROVED → EXECUTING
 *      (atomic CAS, expiry-checked), executes via the agent, then marks
 *      the approval EXECUTED (success) or FAILED (error) and the step
 *      accordingly. CONSUMED IS TERMINAL — a replay can never re-fire.
 *   4. Rejected / expired / cancelled approvals close the step out with no
 *      side effects. Expired pending/approved rows are swept lazily on
 *      read/decision paths (a worker sweep is a Phase 7 refinement).
 *
 * Control-plane properties:
 *   - Approvals are single-use and time-limited.
 *   - Every transition is compare-and-swap; losers of a race get an error,
 *     never a silent success.
 *   - Audit events are append-only (see migration 0013 / audit store).
 *   - Model output can never create, approve or consume an approval.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { AGENT_ERROR_CODES, AgentError } from '../shared/index.js';
import * as store from '../workflow/workflow.store.js';
import { computeApprovalPayloadHash, canonicalize } from './canonical.js';
import * as approvals from './approval.store.js';
import type { AgentApproval, ApprovalStatus } from './approval.store.js';
import type { AgentRegistry } from '../registry/agent.registry.js';
import type { AgentRunStep } from '../workflow/workflow.store.js';

export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000; // 24h
export const MAX_ACTION_DESCRIPTION_CHARS = 1_000;
export const MAX_PAYLOAD_BYTES = 8_000;

// ---------------------------------------------------------------------------
// Request — create a pending approval for a step
// ---------------------------------------------------------------------------

export interface ApprovalRequestInput {
  runId: string;
  stepId: string;
  /** Registered capability name (e.g. 'task.delete'). */
  capability: string;
  operation: string;
  agent: string;
  /** Registry-validated arguments (Zod output) — EXACTLY what will run. */
  args: Record<string, unknown>;
  /** Test-only TTL override; production uses DEFAULT_APPROVAL_TTL_MS. */
  ttlMs?: number;
}

/**
 * Create (or reuse) the PENDING approval for a step. Idempotent for the
 * same action: calling it twice for the same (step, hash) returns the
 * SAME pending approval instead of stacking requests. If an active
 * approval with a DIFFERENT hash exists (persisted state differs from what
 * the model proposed later), the stale one is expired and a fresh one is
 * bound to the NEW payload — the user always approves what actually runs.
 */
export async function requestApproval(
  client: SupabaseClient,
  userId: string,
  input: ApprovalRequestInput,
): Promise<{ approval: AgentApproval; reused: boolean }> {
  const step = await store.getStep(client, userId, input.stepId);
  if (!step) {
    throw new AgentError(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE, 'The approval target step was not found.');
  }
  const run = await store.getRunOrThrow(client, userId, input.runId);
  if (step.run_id !== run.id) {
    throw new AgentError(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE, 'The approval target step does not belong to this run.');
  }

  const payload = {
    agent: input.agent,
    args: input.args,
    capability: input.capability,
    operation: input.operation,
  };
  const payloadHash = computeApprovalPayloadHash({
    userId,
    runId: input.runId,
    stepId: input.stepId,
    capability: input.capability,
    operation: input.operation,
    args: input.args,
  });

  const existing = await approvals.findActiveApprovalForStep(client, userId, input.stepId);
  if (existing && existing.payload_hash === payloadHash) {
    if (existing.status === 'approved') return { approval: existing, reused: true };
    return { approval: existing, reused: true };
  }
  if (existing && existing.payload_hash !== payloadHash) {
    // Persisted state drifted — expire the stale request and bind fresh.
    await approvals.transitionApproval(client, userId, existing.id, [existing.status as ApprovalStatus], 'expired');
    await approvals.insertAuditEvent(client, userId, {
      event: 'approval.superseded',
      approval_id: existing.id,
      run_id: run.id,
      step_id: step.id,
      metadata: { capability: input.capability, operation: input.operation },
    });
  }

  const approval = await approvals.insertApproval(client, userId, {
    runId: input.runId,
    stepId: input.stepId,
    actionDescription: buildActionDescription(input),
    proposedPayload: payload,
    payloadHash,
    expiresAt: new Date(Date.now() + (input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS)).toISOString(),
  });
  await approvals.insertAuditEvent(client, userId, {
    event: 'approval.requested',
    approval_id: approval.id,
    run_id: run.id,
    step_id: step.id,
    metadata: {
      capability: input.capability,
      operation: input.operation,
      args_hash: payloadHash,
      expires_at: approval.expires_at,
    },
  });
  return { approval, reused: false };
}

function buildActionDescription(input: ApprovalRequestInput): string {
  const argsPreview = canonicalize(input.args).slice(0, 200);
  return truncate(
    `${input.agent} agent: ${input.operation} (${input.capability}) — arguments ${argsPreview}`,
    MAX_ACTION_DESCRIPTION_CHARS,
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function sanitizeArgsForPayload(args: Record<string, unknown>): Record<string, unknown> {
  // Defensive bound: the persisted payload must stay small and text-only.
  const json = canonicalize(args);
  if (json.length > MAX_PAYLOAD_BYTES) {
    throw new AgentError(AGENT_ERROR_CODES.INVALID_INPUT, 'Approval payload exceeds the size limit.');
  }
  return JSON.parse(json) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Decision — approve / reject / cancel (authenticated user action only)
// ---------------------------------------------------------------------------

async function assertDecidable(
  client: SupabaseClient,
  userId: string,
  approvalId: string,
  expected: readonly ApprovalStatus[],
): Promise<AgentApproval> {
  await approvals.expireStaleApprovals(client, userId);
  const approval = await approvals.getApprovalById(client, userId, approvalId);
  if (!approval) {
    throw new AgentError(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE, 'Approval not found.');
  }
  if (!expected.includes(approval.status)) {
    const code = approval.status === 'expired' ? AGENT_ERROR_CODES.TIMEOUT : AGENT_ERROR_CODES.INVALID_STATE;
    throw new AgentError(code, `Approval is not actionable in status '${approval.status}'.`);
  }
  return approval;
}

export async function approveApproval(
  client: SupabaseClient,
  userId: string,
  approvalId: string,
): Promise<AgentApproval> {
  const approval = await assertDecidable(client, userId, approvalId, ['pending']);
  const updated = await approvals.transitionApproval(client, userId, approval.id, ['pending'], 'approved', {
    decided: true,
    failIfExpired: true,
  });
  await approvals.insertAuditEvent(client, userId, {
    event: 'approval.approved',
    approval_id: updated.id,
    run_id: updated.run_id,
    step_id: updated.step_id,
    metadata: { capability: String(updated.proposed_payload.capability ?? '') },
  });
  return updated;
}

export async function rejectApproval(
  client: SupabaseClient,
  userId: string,
  approvalId: string,
): Promise<AgentApproval> {
  const approval = await assertDecidable(client, userId, approvalId, ['pending']);
  const updated = await approvals.transitionApproval(client, userId, approval.id, ['pending'], 'rejected', {
    decided: true,
  });
  await approvals.insertAuditEvent(client, userId, {
    event: 'approval.rejected',
    approval_id: updated.id,
    run_id: updated.run_id,
    step_id: updated.step_id,
    metadata: { capability: String(updated.proposed_payload.capability ?? '') },
  });
  return updated;
}

export type CancelApprovalResult = AgentApproval;

export async function cancelApproval(
  client: SupabaseClient,
  userId: string,
  approvalId: string,
): Promise<AgentApproval> {
  const approval = await assertDecidable(client, userId, approvalId, ['pending', 'approved']);
  const updated = await approvals.transitionApproval(client, userId, approval.id, ['pending', 'approved'], 'cancelled', {
    decided: true,
  });
  await approvals.insertAuditEvent(client, userId, {
    event: 'approval.cancelled',
    approval_id: updated.id,
    run_id: updated.run_id,
    step_id: updated.step_id,
    metadata: { capability: String(updated.proposed_payload.capability ?? '') },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Consumption — the exact, fail-closed verification gate before execution
// ---------------------------------------------------------------------------

export interface VerifiedApproval {
  approval: AgentApproval;
  capability: import('../registry/agent.registry.js').CapabilityDefinition;
  /** Registry-validated args — the ONLY values the agent will receive. */
  args: Record<string, unknown>;
}

/**
 * The nine verification checks that MUST all pass before an approved
 * operation executes. Fail closed on every drift between the approval
 * record and the persisted/registry state.
 *
 *  1. Approval exists and belongs to this user (owner-scoped lookup).
 *  2. Run exists, belongs to this user, and matches the approval.
 *  3. Step exists, belongs to this user AND the same run.
 *  4. Capability is registered, available, and serves the step's
 *     (agent, operation) pair exactly.
 *  5. Operation is allowlisted on that capability.
 *  6. Persisted step args pass the capability's Zod schema.
 *  7. The stored payload's hash matches the recomputed hash (no mutation
 *     since approval), and stored payload matches the persisted step.
 *  8. Approval is not expired/rejected/cancelled/executed/consuming.
 *  9. The step has not already executed (status gate) — idempotent ops may
 *     re-run safely; non-idempotent ops can never double-fire.
 *
 * If all checks pass, the approval is atomically moved APPROVED → EXECUTING.
 * The caller MUST NOT execute before receiving the result of this function,
 * and MUST call completeOutcome() afterwards to flip EXECUTING → EXECUTED
 * or FAILED.
 */
export async function consumeApprovalForExecution(
  client: SupabaseClient,
  userId: string,
  registry: AgentRegistry,
  approvalId: string,
): Promise<VerifiedApproval> {
  const approval = await approvals.getApprovalById(client, userId, approvalId);
  if (!approval) {
    // Indistinguishable from "never existed" — do not leak.
    throw new AgentError(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE, 'Approval not found.');
  }

  // 8 (pre-check): only an approved, unexpired grant may start executing.
  if (approval.status !== 'approved') {
    throw new AgentError(
      AGENT_ERROR_CODES.APPROVAL_REQUIRED,
      `Approval is not usable in status '${approval.status}'.`,
    );
  }
  if (Date.now() >= Date.parse(approval.expires_at)) {
    // Lazy expiry: close it out instead of letting it sit approved-then-stale.
    await approvals
      .transitionApproval(client, userId, approval.id, ['approved'], 'expired')
      .catch(() => undefined);
    await approvals.insertAuditEvent(client, userId, {
      event: 'approval.expired',
      approval_id: approval.id,
      run_id: approval.run_id,
      step_id: approval.step_id,
      outcome: 'denied',
      metadata: { capability: String(approval.proposed_payload.capability ?? '') },
    });
    throw new AgentError(AGENT_ERROR_CODES.TIMEOUT, 'The approval expired before execution.');
  }

  // 2: run belongs to the user and matches the approval.
  const run = await store.getRun(client, userId, approval.run_id);
  if (!run) {
    throw new AgentError(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE, 'The approval workflow was not found.');
  }

  // 3: step belongs to the user and to the SAME run as the approval.
  const step = await store.getStep(client, userId, approval.step_id);
  if (!step || step.run_id !== run.id) {
    throw new AgentError(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE, 'The approval step was not found for this run.');
  }

  // 9 (pre-check): never re-execute a settled step through an approval.
  if (step.status === 'completed' || step.status === 'cancelled') {
    throw new AgentError(
      AGENT_ERROR_CODES.INVALID_STATE,
      `The step is already '${step.status}'; the approval cannot be used to execute it again.`,
    );
  }

  // 4: capability must be registered, available, and serve THIS (agent, operation).
  const byStep = registry.findCapabilityFor(step.agent_name, step.operation);
  if (!byStep) {
    throw new AgentError(
      AGENT_ERROR_CODES.CAPABILITY_UNAVAILABLE,
      'No registered capability matches the approved step.',
    );
  }
  const capability = registry.resolve(byStep.name); // throws when not registered
  if (capability.agent !== step.agent_name || !capability.operations.includes(step.operation)) {
    throw new AgentError(AGENT_ERROR_CODES.CAPABILITY_FORBIDDEN, 'The approved capability does not serve this step.');
  }
  if (!capability.available) {
    throw new AgentError(
      AGENT_ERROR_CODES.CAPABILITY_UNAVAILABLE,
      capability.unavailableReason ?? 'That capability is not available.',
    );
  }

  // Stored payload claims must match the persisted step exactly.
  const stored = approval.proposed_payload as Record<string, unknown>;
  if (
    String(stored.capability) !== capability.name ||
    String(stored.operation) !== step.operation ||
    String(stored.agent) !== step.agent_name
  ) {
    throw new AgentError(AGENT_ERROR_CODES.INVALID_STATE, 'The approval payload does not match this step.');
  }

  // 6: revalidate the args against the registered input schema.
  const parsed = capability.inputSchema.safeParse(stored.args ?? {});
  if (!parsed.success) {
    throw new AgentError(
      AGENT_ERROR_CODES.INVALID_INPUT,
      'The approved arguments no longer satisfy the capability schema.',
    );
  }
  const validatedArgs = parsed.data as Record<string, unknown>;

  // 7: the persisted step args must normalize to EXACTLY the approved
  // args (both sides go through the capability schema, so schema-level
  // defaults/strips cannot cause a false mismatch — but any real drift
  // between what was approved and what would run is refused).
  const stepParsed = capability.inputSchema.safeParse(step.input_metadata ?? {});
  if (!stepParsed.success) {
    throw new AgentError(
      AGENT_ERROR_CODES.INVALID_STATE,
      'The persisted step arguments no longer satisfy the capability schema; execution is refused.',
    );
  }
  if (canonicalize(stepParsed.data) !== canonicalize(validatedArgs)) {
    throw new AgentError(
      AGENT_ERROR_CODES.INVALID_STATE,
      'The step arguments changed after approval; execution is refused.',
    );
  }
  const recomputed = computeApprovalPayloadHash({
    userId,
    runId: run.id,
    stepId: step.id,
    capability: capability.name,
    operation: step.operation,
    args: validatedArgs,
  });
  if (recomputed !== approval.payload_hash) {
    throw new AgentError(
      AGENT_ERROR_CODES.INVALID_STATE,
      'The approval payload hash does not match this action; execution is refused.',
    );
  }

  // 1+8 (atomic): move approved → executing with the CAS in a single
  // statement. Losers of the race (concurrent consumption / replay) fail.
  await approvals.transitionApproval(client, userId, approval.id, ['approved'], 'executing', {
    failIfExpired: true,
  });
  await approvals.insertAuditEvent(client, userId, {
    event: 'approval.consumed',
    approval_id: approval.id,
    run_id: approval.run_id,
    step_id: approval.step_id,
    metadata: { capability: capability.name, operation: step.operation },
  });

  return { approval, capability, args: validatedArgs };
}

/**
 * Flip a consumed approval to its terminal state after execution and record
 * the outcome. EXECUTED = side effect succeeded; FAILED = it did not, and the
 * grant is spent either way (a new approval is required to act again — this
 * is the duplicate-execution guard).
 */
export async function completeApproval(
  client: SupabaseClient,
  userId: string,
  approvalId: string,
  outcome: { ok: boolean; errorCode?: string },
): Promise<AgentApproval> {
  const updated = await approvals.transitionApproval(
    client,
    userId,
    approvalId,
    ['executing'],
    outcome.ok ? 'executed' : 'failed',
    { executed: true },
  );
  await approvals.insertAuditEvent(client, userId, {
    event: outcome.ok ? 'approval.executed' : 'approval.execution_failed',
    approval_id: approvalId,
    run_id: updated.run_id,
    step_id: updated.step_id,
    outcome: outcome.ok ? 'ok' : 'error',
    metadata: {
      capability: String(updated.proposed_payload.capability ?? ''),
      ...(outcome.errorCode ? { error_code: outcome.errorCode } : {}),
    },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Listing / viewing (public API surface — owner-scoped)
// ---------------------------------------------------------------------------

export async function listApprovals(
  client: SupabaseClient,
  userId: string,
  filters: { status?: ApprovalStatus; limit?: number } = {},
): Promise<AgentApproval[]> {
  await approvals.expireStaleApprovals(client, userId);
  return approvals.listApprovalsForUser(client, userId, filters);
}

export async function getApproval(
  client: SupabaseClient,
  userId: string,
  approvalId: string,
): Promise<AgentApproval | null> {
  await approvals.expireStaleApprovals(client, userId);
  return approvals.getApprovalById(client, userId, approvalId);
}

// ---------------------------------------------------------------------------
// Step-level evaluation — one read that tells the orchestrator exactly what
// may happen next for an approval-gated step (pause / execute / settle).
// ---------------------------------------------------------------------------

export type StepApprovalState =
  /** No approval has ever been requested for this step. */
  | { kind: 'none' }
  /** A human decision is outstanding — execution must stay paused. */
  | { kind: 'pending'; approval: AgentApproval }
  /** A valid, unexpired grant bound to this exact action — may execute. */
  | { kind: 'approved'; approval: AgentApproval }
  /** Decided against the action (rejected/expired/cancelled) — settle, never execute. */
  | { kind: 'denied'; approval: AgentApproval }
  /** Grant already spent or broken (executed/executing/failed/tampered) — settle, never execute. */
  | { kind: 'spent'; approval: AgentApproval };

/**
 * Recompute the binding hash from the approval's OWN stored payload and
 * compare with the recorded hash. Returns false on any tampering
 * (payload mutated after the decision, ids swapped, hash rewritten).
 */
export function approvalBindingIsValid(
  approval: AgentApproval,
  ids: { userId: string; runId: string; stepId: string },
): boolean {
  const stored = (approval.proposed_payload ?? {}) as Record<string, unknown>;
  try {
    const recomputed = computeApprovalPayloadHash({
      userId: ids.userId,
      runId: ids.runId,
      stepId: ids.stepId,
      capability: String(stored.capability ?? ''),
      operation: String(stored.operation ?? ''),
      args: (stored.args ?? {}) as Record<string, unknown>,
    });
    return recomputed === approval.payload_hash;
  } catch {
    return false; // unhashable payload → fail closed
  }
}

/**
 * Evaluate the approval state for one step. Sweeps lazy expiry first, so an
 * approval whose TTL lapsed is reported as `denied` (expired), never as
 * `pending`/`approved`. An approved row whose binding hash no longer
 * verifies is reported as `spent` (integrity failure → settle, refuse).
 */
export async function evaluateStepApproval(
  client: SupabaseClient,
  userId: string,
  stepId: string,
): Promise<StepApprovalState> {
  await approvals.expireStaleApprovals(client, userId);

  const active = await approvals.findActiveApprovalForStep(client, userId, stepId);
  if (active && active.status === 'pending') {
    return { kind: 'pending', approval: active };
  }
  if (active && active.status === 'approved') {
    const step = await store.getStep(client, userId, stepId);
    if (!step) return { kind: 'none' }; // step vanished (cascade) — caller's CAS fails
    const valid = approvalBindingIsValid(active, {
      userId,
      runId: step.run_id,
      stepId: step.id,
    });
    return valid ? { kind: 'approved', approval: active } : { kind: 'spent', approval: active };
  }

  const latest = await approvals.findLatestApprovalForStep(client, userId, stepId);
  if (!latest) return { kind: 'none' };
  if (latest.status === 'rejected' || latest.status === 'expired' || latest.status === 'cancelled') {
    return { kind: 'denied', approval: latest };
  }
  // executed / executing / failed — the grant is spent; never reusable.
  return { kind: 'spent', approval: latest };
}

/**
 * Locate the approved approval for a step being dispatched by the
 * orchestrator's resume path. Returns null when there is no approved
 * grant — callers must NOT execute the step in that case.
 */
export async function findApprovedApprovalForStep(
  client: SupabaseClient,
  userId: string,
  step: AgentRunStep,
): Promise<AgentApproval | null> {
  const state = await evaluateStepApproval(client, userId, step.id);
  if (state.kind !== 'approved') return null;
  // Defense in depth: the binding must also cover THIS step's identity.
  if (state.approval.step_id !== step.id || state.approval.run_id !== step.run_id) return null;
  return state.approval;
}
