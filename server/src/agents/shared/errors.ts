/**
 * Phase 1 — Shared agent error codes (M6).
 *
 * Stable, machine-readable codes so the orchestrator, API and UI can react
 * deterministically. Messages are client-safe by contract: no provider
 * internals, no credentials, no raw prompt content.
 */

export const AGENT_ERROR_CODES = {
  /** Requested capability is not registered / has no live provider. */
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  /** Capability exists but the caller's permissions disallow it. */
  CAPABILITY_FORBIDDEN: 'CAPABILITY_FORBIDDEN',
  /** Input failed the capability's Zod schema. */
  INVALID_INPUT: 'INVALID_INPUT',
  /** Model-supplied id could not be resolved for the authenticated owner. */
  UNRESOLVED_REFERENCE: 'UNRESOLVED_REFERENCE',
  /** Human approval missing, rejected, expired or already consumed. */
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  /** Step exceeded its deadline. */
  TIMEOUT: 'TIMEOUT',
  /** Underlying provider/service failure after bounded retries. */
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  /** Run was cancelled by the user. */
  CANCELLED: 'CANCELLED',
  /** Run state machine rejected the transition. */
  INVALID_STATE: 'INVALID_STATE',
  /** Proposed plan failed validation. */
  INVALID_PLAN: 'INVALID_PLAN',
} as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[keyof typeof AGENT_ERROR_CODES];

/** Client-safe error with a stable code. */
export class AgentError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    message: string,
    public readonly expose = true,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export function isAgentError(err: unknown): err is AgentError {
  return err instanceof AgentError;
}
