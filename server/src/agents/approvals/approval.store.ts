/**
 * Phase 6 — Approval + audit persistence store (M6).
 *
 * SECURITY — same two-input trust model as workflow.store.ts:
 *   1. `client`  — user-scoped Supabase client (RLS applies), and
 *   2. `userId`  — verified authenticated owner.
 *
 * Every statement carries `.eq('user_id', userId)`; state transitions are
 * compare-and-swap updates (expected status in the WHERE clause) so two
 * concurrent requests can never both approve/consume the same approval.
 *
 * Append-only audit events are moving through this store too: inserts are
 * owner-scoped; there is deliberately no update/delete helper.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { AGENT_ERROR_CODES, AgentError } from '../shared/index.js';

// ---------------------------------------------------------------------------
// Row types (mirror migration 0013)
// ---------------------------------------------------------------------------

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'executing',
  'executed',
  'rejected',
  'expired',
  'cancelled',
  'failed',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface AgentApproval {
  id: string;
  run_id: string;
  step_id: string;
  user_id: string;
  action_description: string;
  proposed_payload: Record<string, unknown>;
  payload_hash: string;
  status: ApprovalStatus;
  expires_at: string;
  decided_at: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentAuditEvent {
  id?: string;
  user_id: string;
  run_id?: string | null;
  step_id?: string | null;
  approval_id?: string | null;
  event: string;
  outcome?: 'ok' | 'denied' | 'error';
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export const APPROVAL_NOT_FOUND = 'APPROVAL_NOT_FOUND';
export const APPROVAL_CONFLICT = 'APPROVAL_CONFLICT';
export const APPROVAL_EXPIRED = 'APPROVAL_EXPIRED';

function wrap(error: { message: string; code?: string } | null, what: string): never {
  throw new AgentError(
    AGENT_ERROR_CODES.EXECUTION_FAILED,
    `Failed to ${what}: ${error?.message ?? 'unknown error'}`,
  );
}

function toConflict(message: string): AgentError {
  return new AgentError(AGENT_ERROR_CODES.INVALID_STATE, message);
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface CreateApprovalInput {
  runId: string;
  stepId: string;
  actionDescription: string;
  proposedPayload: Record<string, unknown>;
  payloadHash: string;
  expiresAt: string;
}

export async function insertApproval(
  client: SupabaseClient,
  userId: string,
  input: CreateApprovalInput,
): Promise<AgentApproval> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('agent_approvals')
    .insert({
      run_id: input.runId,
      step_id: input.stepId,
      user_id: userId,
      action_description: input.actionDescription,
      proposed_payload: input.proposedPayload,
      payload_hash: input.payloadHash,
      status: 'pending',
      expires_at: input.expiresAt,
      created_at: now,
      updated_at: now,
    })
    .select('*')
    .single();
  if (error) wrap(error, 'create approval');
  return data as AgentApproval;
}

export async function getApprovalById(
  client: SupabaseClient,
  userId: string,
  approvalId: string,
): Promise<AgentApproval | null> {
  const { data, error } = await client
    .from('agent_approvals')
    .select('*')
    .eq('id', approvalId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) wrap(error, 'fetch approval');
  return (data as AgentApproval | null) ?? null;
}

/**
 * Find the single ACTIVE approval for a step (pending or approved).
 * At most one can exist (unique pending index + immediate hand-off to
 * executing before execution). Own-user only.
 */
export async function findActiveApprovalForStep(
  client: SupabaseClient,
  userId: string,
  stepId: string,
): Promise<AgentApproval | null> {
  const { data, error } = await client
    .from('agent_approvals')
    .select('*')
    .eq('user_id', userId)
    .eq('step_id', stepId)
    .in('status', ['pending', 'approved'])
    .order('created_at', { ascending: false });
  if (error) wrap(error, 'look up active approval');
  const rows = (data ?? []) as AgentApproval[];
  return rows[0] ?? null;
}

/**
 * The MOST RECENT approval for a step regardless of status. Used to detect
 * a prior human decision (rejected/expired/cancelled) or a spent grant
 * (executed/executing/failed) so the orchestrator can settle the step
 * instead of silently re-asking or re-executing.
 */
export async function findLatestApprovalForStep(
  client: SupabaseClient,
  userId: string,
  stepId: string,
): Promise<AgentApproval | null> {
  const { data, error } = await client
    .from('agent_approvals')
    .select('*')
    .eq('user_id', userId)
    .eq('step_id', stepId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) wrap(error, 'look up approval history for step');
  const rows = (data ?? []) as AgentApproval[];
  return rows[0] ?? null;
}

export async function listApprovalsForUser(
  client: SupabaseClient,
  userId: string,
  filters: { status?: ApprovalStatus; limit?: number } = {},
): Promise<AgentApproval[]> {
  let query = client
    .from('agent_approvals')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 50);
  if (filters.status) query = query.eq('status', filters.status);
  const { data, error } = await query;
  if (error) wrap(error, 'list approvals');
  return (data ?? []) as AgentApproval[];
}

/**
 * Transition an approval with compare-and-swap semantics. Fails LOUDLY on
 * 0 affected rows (concurrent winner / replay / wrong status), never
 * silently. Optionally requires the approval to be unexpired for the
 * transition — used for decisions and consumption, where acting on an
 * expired approval must fail closed.
 */
export async function transitionApproval(
  client: SupabaseClient,
  userId: string,
  approvalId: string,
  expectedFrom: readonly ApprovalStatus[],
  to: ApprovalStatus,
  patch: { decided?: boolean; executed?: boolean; failIfExpired?: boolean } = {},
): Promise<AgentApproval> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { status: to, updated_at: now };
  if (patch.decided) update.decided_at = now;
  if (patch.executed) update.executed_at = now;

  let query = client
    .from('agent_approvals')
    .update(update)
    .eq('id', approvalId)
    .eq('user_id', userId)
    .in('status', expectedFrom);
  if (patch.failIfExpired) query = query.gt('expires_at', now);

  const { data, error } = await query.select('*');
  if (error) wrap(error, 'transition approval');

  const rows = (data ?? []) as AgentApproval[];
  if (rows.length === 0) {
    throw toConflict(
      `Approval ${approvalId} is no longer in a state this transition allows (concurrent change, replay or expiry).`,
    );
  }
  return rows[0]!;
}

/**
 * Expiry sweep: pending/approved approvals whose TTL has lapsed become
 * `expired` (audited). Owner-scoped; called on decision/list paths so no
 * external worker is required for correctness (a worker sweep is a Phase 7
 * refinement).
 */
export async function expireStaleApprovals(
  client: SupabaseClient,
  userId: string,
): Promise<AgentApproval[]> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('agent_approvals')
    .select('*')
    .eq('user_id', userId)
    .in('status', ['pending', 'approved'])
    .lt('expires_at', now);
  if (error) wrap(error, 'scan for expired approvals');
  const stale = (data ?? []) as AgentApproval[];
  const expired: AgentApproval[] = [];
  for (const row of stale) {
    let done: AgentApproval;
    try {
      done = await transitionApproval(client, userId, row.id, ['pending', 'approved'], 'expired');
    } catch {
      // Another writer already expired/decided it — leave it.
      continue;
    }
    expired.push(done);
    // Auditing a sweep expiry is mandatory (append-only, loud on failure);
    // only the transition conflict above may be swallowed.
    await insertAuditEvent(client, userId, {
      event: 'approval.expired',
      approval_id: done.id,
      run_id: done.run_id,
      step_id: done.step_id,
      outcome: 'denied',
      metadata: { capability: String((done.proposed_payload as Record<string, unknown>).capability ?? '') },
    });
  }
  return expired;
}

// ---------------------------------------------------------------------------
// Audit events (append-only)
// ---------------------------------------------------------------------------

export async function insertAuditEvent(
  client: SupabaseClient,
  userId: string,
  event: Omit<AgentAuditEvent, 'user_id' | 'created_at'>,
): Promise<void> {
  const { error } = await client.from('agent_audit_events').insert({
    user_id: userId,
    run_id: event.run_id ?? null,
    step_id: event.step_id ?? null,
    approval_id: event.approval_id ?? null,
    event: event.event,
    outcome: event.outcome ?? 'ok',
    metadata: event.metadata ?? {},
    created_at: new Date().toISOString(),
  });
  // Audit failure must not corrupt the control flow decision that already
  // happened — but it must be LOUD. Throw like any store failure.
  if (error) wrap(error, 'write audit event');
}
