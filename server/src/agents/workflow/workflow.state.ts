/**
 * M6 Phase 3 — workflow state machine helpers (Module D/E).
 *
 * Thin, testable wrapper over the shared transition table. Every status
 * change in the store goes through `assertTransition`, so an illegal move
 * (e.g. resurrecting a completed run) fails loudly instead of corrupting
 * durable state.
 */

import {
  AGENT_ERROR_CODES,
  AgentError,
  WORKFLOW_STATUSES,
  canTransition,
  isTerminalStatus,
  stepStatusSchema,
  workflowStatusSchema,
} from '../shared/index.js';
import type { StepStatus, WorkflowStatus } from '../shared/index.js';

export { isTerminalStatus };

/** Throw unless `from → to` is a legal workflow transition. */
export function assertTransition(from: WorkflowStatus, to: WorkflowStatus): void {
  if (!canTransition(from, to)) {
    throw new AgentError(
      AGENT_ERROR_CODES.INVALID_STATE,
      `Illegal workflow transition: ${from} → ${to}`,
    );
  }
  if (isTerminalStatus(from) && from !== to) {
    throw new AgentError(
      AGENT_ERROR_CODES.INVALID_STATE,
      `Workflow is already terminal (${from}) and cannot change to ${to}`,
    );
  }
}

/** Parse an untrusted status value (e.g. from an API request). */
export function parseWorkflowStatus(raw: unknown): WorkflowStatus {
  const parsed = workflowStatusSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentError(AGENT_ERROR_CODES.INVALID_STATE, `Unknown workflow status: ${String(raw)}`);
  }
  return parsed.data;
}

export function parseStepStatus(raw: unknown): StepStatus {
  const parsed = stepStatusSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentError(AGENT_ERROR_CODES.INVALID_STATE, `Unknown step status: ${String(raw)}`);
  }
  return parsed.data;
}

/**
 * A run is complete only when every step reached a settled state.
 * Returns the terminal status implied by the step outcomes:
 *   - any step cancelled (and none failed) → cancelled
 *   - everything completed/skipped with no failure → completed
 *   - failures with at least one verified completion → partially_failed
 *   - failures with NOTHING completed → failed (nothing worked)
 */
export function deriveRunStatus(stepStatuses: readonly StepStatus[]): WorkflowStatus {
  if (stepStatuses.length === 0) return 'failed';
  const allSettled = stepStatuses.every(
    (s) => s === 'completed' || s === 'failed' || s === 'skipped' || s === 'cancelled',
  );
  if (!allSettled) return 'running';
  const anyFailed = stepStatuses.some((s) => s === 'failed');
  const anyCompleted = stepStatuses.some((s) => s === 'completed');
  const allCompleted = stepStatuses.every((s) => s === 'completed' || s === 'skipped');
  if (allCompleted) return 'completed';
  if (anyFailed && !anyCompleted) return 'failed';
  if (stepStatuses.some((s) => s === 'cancelled')) return 'cancelled';
  return anyFailed ? 'partially_failed' : 'completed';
}

/** All workflow statuses (for API validation and UI filters). */
export const allWorkflowStatuses = WORKFLOW_STATUSES;
