/**
 * Phase 5 — Shared agent result helpers (M6).
 *
 * Normalizes service-layer outcomes into the `AgentResult` contract WITHOUT
 * duplicating any business logic: the existing services remain the single
 * source of truth for behavior; this module only maps error CODES to the
 * agent error vocabulary and decides which messages are safe to surface.
 *
 * Message-safety rules (mirrors app.ts error handling):
 * - codes whose messages are authored for clients (documented in each
 *   service) surface their own message,
 * - `DocumentError` messages are safe by contract (documents/errors.ts),
 * - everything else (raw DB/provider messages) surfaces a generic fallback;
 *   the real detail goes only to the optional structured log.
 */

import type { AgentContext, AgentResult } from './agent.types.js';
import { AGENT_ERROR_CODES, AgentError } from './errors.js';

/** Client-safe messages that map to INVALID_INPUT (validation/policy). */
const INVALID_INPUT_MESSAGES = new Set([
  'EMPTY_PATCH',
  'REMINDER_INVALID_TIME',
  'CREDENTIAL_BLOCKED',
  'INVALID_INPUT',
]);

/** Client-safe messages that map to EXECUTION_FAILED (conflict states). */
const SAFE_CONFLICT_CODES = new Set(['REMINDER_CONFLICT', 'MEMORY_DUPLICATE']);

/**
 * "The model-supplied reference does not exist / is not owned by this
 * user" → UNRESOLVED_REFERENCE with a message that cannot be used to probe
 * other accounts (missing and foreign ids are indistinguishable).
 */
const NOT_FOUND_MESSAGES: Record<string, string> = {
  TASK_NOT_FOUND: 'The referenced task was not found.',
  REMINDER_NOT_FOUND: 'The referenced reminder was not found.',
  MEMORY_NOT_FOUND: 'The referenced memory was not found.',
  DOCUMENT_NOT_FOUND: 'The referenced document was not found.',
};

const MAX_MESSAGE_CHARS = 300;

function bound(message: string): string {
  return message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message;
}

/** Successful execution with a bounded, UI-safe summary. */
export function okResult(summary: string, output: Record<string, unknown> = {}): AgentResult {
  return { status: 'ok', summary: bound(summary), output };
}

/** Failed execution with a stable machine-readable code. */
export function failedResult(code: string, message: string): AgentResult {
  return { status: 'failed', error: { code, message: bound(message) } };
}

/**
 * Cooperative cancellation (the orchestrator maps a CANCELLED error code to
 * a cancelled step outcome).
 */
export function cancelledResult(message = 'Cancelled before execution.'): AgentResult {
  return failedResult(AGENT_ERROR_CODES.CANCELLED, message);
}

/** A model-supplied id could not be resolved for the authenticated owner. */
export function unresolvedResult(what: string): AgentResult {
  return failedResult(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE, `The referenced ${what} was not found.`);
}

/** Capability has no live execution path — reported honestly, never faked. */
export function unavailableResult(reason: string): AgentResult {
  return { status: 'unavailable', unavailableReason: bound(reason) };
}

export interface ThrownOptions {
  /** Message used when the error carries nothing client-safe. */
  fallbackMessage?: string;
  /** Structured log sink — the only place raw details may go. */
  context?: Pick<AgentContext, 'log'>;
}

/**
 * Map ANY thrown value from an existing service onto an AgentResult.
 * Unknown/infra errors deliberately degrade to a generic message so DB or
 * provider internals never reach the model or the UI.
 */
export function fromThrown(err: unknown, options: ThrownOptions = {}): AgentResult {
  if (err instanceof AgentError) {
    return failedResult(err.code, err.message);
  }

  const carrier = err as { code?: unknown; statusCode?: unknown; message?: unknown } | null;
  const code = typeof carrier?.code === 'string' ? carrier.code : undefined;
  const message = typeof carrier?.message === 'string' ? carrier.message : '';
  const isDocumentError = err instanceof Error && err.name === 'DocumentError';

  // 1. Owner-scoped not-found: the reference could not be resolved.
  if (code && NOT_FOUND_MESSAGES[code]) {
    return failedResult(AGENT_ERROR_CODES.UNRESOLVED_REFERENCE, NOT_FOUND_MESSAGES[code]!);
  }

  // 2. DocumentError: safe-by-contract message + HTTP class decides mapping.
  if (isDocumentError) {
    const status = typeof carrier?.statusCode === 'number' ? carrier.statusCode : 400;
    const mapped =
      status >= 500 ? AGENT_ERROR_CODES.EXECUTION_FAILED : AGENT_ERROR_CODES.INVALID_INPUT;
    return failedResult(mapped, message || 'The operation could not be completed.');
  }

  // 3. Known validation/policy rejections (client-safe messages).
  if (code && INVALID_INPUT_MESSAGES.has(code)) {
    return failedResult(AGENT_ERROR_CODES.INVALID_INPUT, message || 'The input was rejected.');
  }
  if (code && SAFE_CONFLICT_CODES.has(code)) {
    return failedResult(AGENT_ERROR_CODES.EXECUTION_FAILED, message);
  }

  // 4. Everything else: honest generic message; details only to the log.
  options.context?.log?.('agent step failed', {
    code: code ?? 'UNKNOWN',
    detail: message.slice(0, MAX_MESSAGE_CHARS),
  });
  return failedResult(AGENT_ERROR_CODES.EXECUTION_FAILED, options.fallbackMessage ?? 'The operation failed.');
}
