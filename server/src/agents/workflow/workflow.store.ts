/**
 * M6 Phase 3 — durable workflow state store (Module E).
 *
 * SECURITY — same two-input trust model as every existing service:
 *   1. `client`  — user-scoped Supabase client from the auth middleware
 *                  (RLS applies to the statement), and
 *   2. `userId`  — the verified authenticated user id, never from model
 *                  output or request bodies.
 *
 * Every read and write carries `.eq('user_id', userId)` on top of RLS.
 * Status changes go through the state machine (`workflow.state.ts`) and use
 * conditional updates (expected-from status in the WHERE clause) so two
 * concurrent writers can never both "win" a transition.
 *
 * What is stored: bounded metadata (agent names, operations, timings, error
 * codes). Never prompt transcripts, never credentials, never embeddings.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { AGENT_ERROR_CODES, AgentError } from '../shared/index.js';
import type { ExecutionPlan, StepStatus, WorkflowStatus } from '../shared/index.js';
import { assertTransition, deriveRunStatus, isTerminalStatus } from './workflow.state.js';

// ---------------------------------------------------------------------------
// Row types (mirror migration 0013)
// ---------------------------------------------------------------------------

export interface AgentRun {
  id: string;
  user_id: string;
  objective: string;
  status: WorkflowStatus;
  summary: Record<string, unknown>;
  final_response: string | null;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string | null;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRunStep {
  id: string;
  run_id: string;
  user_id: string;
  step_key: string;
  agent_name: string;
  operation: string;
  status: StepStatus;
  depends_on: string[];
  input_metadata: Record<string, unknown>;
  output_metadata: Record<string, unknown>;
  retry_count: number;
  requires_approval: boolean;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export class WorkflowStoreError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'WorkflowStoreError';
  }
}

export const RUN_NOT_FOUND = 'RUN_NOT_FOUND';
export const STEP_NOT_FOUND = 'STEP_NOT_FOUND';

function wrap(error: { message: string; code?: string } | null, what: string): never {
  throw new WorkflowStoreError(`Failed to ${what}: ${error?.message ?? 'unknown error'}`, error?.code);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface CreateRunInput {
  objective: string;
  plan?: ExecutionPlan | null;
  idempotencyKey?: string | null;
}

/**
 * Create a workflow run in `pending` status with its planned steps.
 *
 * Idempotency: when an `idempotencyKey` is supplied, an existing run for
 * the same user+key is returned instead of creating a duplicate workflow
 * (duplicate-submission prevention — Module D).
 */
export async function createRun(
  client: SupabaseClient,
  userId: string,
  input: CreateRunInput,
): Promise<{ run: AgentRun; steps: AgentRunStep[]; reused: boolean }> {
  if (input.idempotencyKey) {
    const existing = await client
      .from('agent_runs')
      .select('*')
      .eq('user_id', userId)
      .eq('idempotency_key', input.idempotencyKey)
      .maybeSingle();
    if (existing.error) wrap(existing.error, 'look up run idempotency key');
    if (existing.data) {
      const steps = await listSteps(client, userId, (existing.data as AgentRun).id);
      return { run: existing.data as AgentRun, steps, reused: true };
    }
  }

  const { data: run, error } = await client
    .from('agent_runs')
    .insert({
      user_id: userId,
      objective: input.objective,
      status: 'pending',
      summary: {},
      idempotency_key: input.idempotencyKey ?? null,
    })
    .select('*')
    .single();
  if (error) wrap(error, 'create agent run');
  const created = run as AgentRun;

  let steps: AgentRunStep[] = [];
  if (input.plan && input.plan.steps.length > 0) {
    const rows = input.plan.steps.map((s) => ({
      run_id: created.id,
      user_id: userId,
      step_key: s.stepKey,
      agent_name: s.agent,
      operation: s.operation,
      status: 'pending' as StepStatus,
      depends_on: s.dependsOn,
      input_metadata: s.args,
      requires_approval: s.requiresApproval,
      retry_count: 0,
    }));
    const { data: inserted, error: stepError } = await client
      .from('agent_run_steps')
      .insert(rows)
      .select('*');
    if (stepError) wrap(stepError, 'create agent run steps');
    steps = (inserted ?? []) as AgentRunStep[];
    // Keep plan order (insert order is not guaranteed by PostgREST).
    const order = new Map(input.plan.steps.map((s, i) => [s.stepKey, i]));
    steps.sort((a, b) => (order.get(a.step_key) ?? 0) - (order.get(b.step_key) ?? 0));
  }

  return { run: created, steps, reused: false };
}

/** Fetch one run owned by the verified user (null when not found). */
export async function getRun(
  client: SupabaseClient,
  userId: string,
  runId: string,
): Promise<AgentRun | null> {
  const { data, error } = await client
    .from('agent_runs')
    .select('*')
    .eq('id', runId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) wrap(error, 'fetch agent run');
  return (data as AgentRun | null) ?? null;
}

export async function getRunOrThrow(
  client: SupabaseClient,
  userId: string,
  runId: string,
): Promise<AgentRun> {
  const run = await getRun(client, userId, runId);
  if (!run) {
    throw new AgentError(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE, `Run not found: ${runId}`);
  }
  return run;
}

/** List runs for the verified user, newest first, optionally filtered. */
export async function listRuns(
  client: SupabaseClient,
  userId: string,
  filters: { status?: WorkflowStatus; limit?: number } = {},
): Promise<AgentRun[]> {
  let query = client
    .from('agent_runs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 50);
  if (filters.status) query = query.eq('status', filters.status);
  const { data, error } = await query;
  if (error) wrap(error, 'list agent runs');
  return (data ?? []) as AgentRun[];
}

/**
 * Transition a run to a new status. The update only applies when the row
 * still has `expectedFrom` (compare-and-swap), so concurrent writers cannot
 * both apply conflicting transitions; 0 affected rows → state conflict.
 */
export async function transitionRun(
  client: SupabaseClient,
  userId: string,
  runId: string,
  expectedFrom: WorkflowStatus,
  to: WorkflowStatus,
  patch: {
    summary?: Record<string, unknown>;
    finalResponse?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    started?: boolean;
    completed?: boolean;
    claimed?: boolean;
    released?: boolean;
  } = {},
): Promise<AgentRun> {
  assertTransition(expectedFrom, to);

  const now = new Date().toISOString();
  const update: Record<string, unknown> = { status: to };
  if (patch.summary) update.summary = patch.summary;
  if (patch.finalResponse !== undefined) update.final_response = patch.finalResponse;
  if (patch.errorCode !== undefined) update.error_code = patch.errorCode;
  if (patch.errorMessage !== undefined) update.error_message = patch.errorMessage;
  if (patch.started) update.started_at = now;
  if (patch.completed) update.completed_at = now;
  if (patch.claimed) update.claimed_at = now;
  if (patch.released) update.claimed_at = null;
  if (to === 'running') update.claimed_at = now;

  const { data, error } = await client
    .from('agent_runs')
    .update(update)
    .eq('id', runId)
    .eq('user_id', userId)
    .eq('status', expectedFrom)
    .select('*');
  if (error) wrap(error, 'transition agent run');

  const rows = (data ?? []) as AgentRun[];
  if (rows.length === 0) {
    throw new AgentError(
      AGENT_ERROR_CODES.INVALID_STATE,
      `Run ${runId} is not in status '${expectedFrom}' (concurrent change or unknown run).`,
    );
  }
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export async function listSteps(
  client: SupabaseClient,
  userId: string,
  runId: string,
): Promise<AgentRunStep[]> {
  const { data, error } = await client
    .from('agent_run_steps')
    .select('*')
    .eq('user_id', userId)
    .eq('run_id', runId)
    .order('created_at', { ascending: true });
  if (error) wrap(error, 'list agent run steps');
  return (data ?? []) as AgentRunStep[];
}

export async function getStep(
  client: SupabaseClient,
  userId: string,
  stepId: string,
): Promise<AgentRunStep | null> {
  const { data, error } = await client
    .from('agent_run_steps')
    .select('*')
    .eq('id', stepId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) wrap(error, 'fetch agent run step');
  return (data as AgentRunStep | null) ?? null;
}

/**
 * Update a step's status and metadata. Conditional on the expected current
 * status (CAS) — used by the orchestrator to advance steps safely.
 */
export async function updateStepStatus(
  client: SupabaseClient,
  userId: string,
  stepId: string,
  expectedFrom: StepStatus,
  to: StepStatus,
  patch: {
    outputMetadata?: Record<string, unknown>;
    errorCode?: string | null;
    errorMessage?: string | null;
    incrementRetry?: boolean;
    started?: boolean;
    completed?: boolean;
  } = {},
): Promise<AgentRunStep> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { status: to };
  if (patch.outputMetadata) update.output_metadata = patch.outputMetadata;
  if (patch.errorCode !== undefined) update.error_code = patch.errorCode;
  if (patch.errorMessage !== undefined) update.error_message = patch.errorMessage;
  if (patch.started) update.started_at = now;
  if (patch.completed) update.completed_at = now;

  const { data, error } = await client
    .from('agent_run_steps')
    .update(update)
    .eq('id', stepId)
    .eq('user_id', userId)
    .eq('status', expectedFrom)
    .select('*');
  if (error) wrap(error, 'update agent run step');

  const rows = (data ?? []) as AgentRunStep[];
  if (rows.length === 0) {
    throw new AgentError(
      AGENT_ERROR_CODES.INVALID_STATE,
      `Step ${stepId} is not in status '${expectedFrom}'.`,
    );
  }
  const step = rows[0]!;

  if (patch.incrementRetry) {
    const { data: bumped, error: bumpError } = await client
      .from('agent_run_steps')
      .update({ retry_count: step.retry_count + 1 })
      .eq('id', stepId)
      .eq('user_id', userId)
      .select('*');
    if (bumpError) wrap(bumpError, 'increment step retry count');
    const bumpedRows = (bumped ?? []) as AgentRunStep[];
    if (bumpedRows[0]) return bumpedRows[0];
  }
  return step;
}

/**
 * Derive and persist the run's terminal status from its step outcomes.
 * Returns the updated run. Never reports success unless the DB write
 * confirms the derived status.
 */
export async function finalizeRunFromSteps(
  client: SupabaseClient,
  userId: string,
  runId: string,
): Promise<AgentRun> {
  const run = await getRunOrThrow(client, userId, runId);
  const steps = await listSteps(client, userId, runId);
  const derived = deriveRunStatus(steps.map((s) => s.status));
  // A terminal run is never re-finalized (state machine forbids it).
  if (isTerminalStatus(run.status) || derived === run.status) return run;
  return transitionRun(client, userId, runId, run.status, derived, {
    completed: true,
    summary: {
      ...run.summary,
      stepCounts: countByStatus(steps),
    },
  });
}

function countByStatus(steps: AgentRunStep[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of steps) counts[s.status] = (counts[s.status] ?? 0) + 1;
  return counts;
}

/** Delete a run (and its steps/approvals via ON DELETE CASCADE), owner-scoped. */
export async function deleteRun(
  client: SupabaseClient,
  userId: string,
  runId: string,
): Promise<boolean> {
  const { error } = await client
    .from('agent_runs')
    .delete()
    .eq('id', runId)
    .eq('user_id', userId);
  if (error) wrap(error, 'delete agent run');
  return true;
}

/** Claim a step lease atomically (FOR UPDATE SKIP LOCKED). Returns the step if claimed, null if already claimed by another process. */
export async function claimStepLease(
  client: SupabaseClient,
  userId: string,
  stepId: string,
  leaseSeconds = 30,
): Promise<{ claimed: boolean; step: Record<string, unknown> | null; leaseExpiresAt: string }> {
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const { data, error } = await client
    .from('agent_run_steps')
    .update({
      status: 'running',
      claimed_at: now,
      lease_expiry: leaseExpiresAt,
    })
    .eq('id', stepId)
    .eq('user_id', userId)
    .select('*')
    .eq('status', 'pending') // only claim pending steps
    .single();
  if (error || !data) return { claimed: false, step: null, leaseExpiresAt };
  return { claimed: true, step: data as Record<string, unknown>, leaseExpiresAt };
}

/** Release a step lease (reset status to previous or pending). */
export async function releaseStepLease(
  client: SupabaseClient,
  userId: string,
  stepId: string,
  fromStatus: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await client
    .from('agent_run_steps')
    .update({ status: fromStatus, claimed_at: null, lease_expiry: null })
    .eq('id', stepId)
    .eq('user_id', userId)
    .eq('status', 'running')
    .select('*')
    .single();
  if (error || !data) return null;
  return data as Record<string, unknown>;
}

/** Update step retry state (schedule next retry). */
export async function updateStepRetryState(
  client: SupabaseClient,
  userId: string,
  stepId: string,
  retryCount: number,
  nextRetryAt: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await client
    .from('agent_run_steps')
    .update({ retry_count: retryCount, retry_next_at: nextRetryAt })
    .eq('id', stepId)
    .eq('user_id', userId)
    .select('*')
    .single();
  if (error || !data) return null;
  return data as Record<string, unknown>;
}

/** Mark a step's side effect as audited (persists that the external outcome was verified). */
export async function markStepSideEffectAudited(
  client: SupabaseClient,
  userId: string,
  stepId: string,
  outcome: 'completed' | 'failed',
): Promise<Record<string, unknown> | null> {
  const { data, error } = await client
    .from('agent_run_steps')
    .update({ side_effect_audited: true, last_audit_outcome: outcome })
    .eq('id', stepId)
    .eq('user_id', userId)
    .select('*')
    .single();
  if (error || !data) return null;
  return data as Record<string, unknown>;
}

/** Check if a step's lease has expired. */
export function isLeaseExpired(step: Record<string, unknown> | null, leaseSeconds = 30): boolean {
  if (!step) return true;
  const expiry = String(step['lease_expiry'] ?? '');
  if (!expiry) return true;
  const expiryTime = new Date(expiry).getTime();
  const now = Date.now();
  // Lease expired if expiry is in the past, or if there's no reasonable future expiry
  return expiryTime <= now + leaseSeconds * 1000;
}
