/**
 * controllers/approval.controller.ts
 * ----------------------------------
 * REST handlers for the human-approval lifecycle (M6 Phase 6):
 *
 *   GET    /api/approvals            — list the caller's approvals
 *   GET    /api/approvals/:id        — one approval's details
 *   POST   /api/approvals/:id/approve — PENDING → APPROVED (+ resume run)
 *   POST   /api/approvals/:id/reject  — PENDING → REJECTED  (+ settle run)
 *   POST   /api/approvals/:id/cancel  — PENDING|APPROVED → CANCELLED (+ settle)
 *
 * SECURITY:
 *   - Identity comes exclusively from `getAuth(req)` (verified bearer
 *     token). Bodies/queries are Zod-validated; decision bodies are
 *     strictly empty, so a body-borne `user_id` is rejected with 400.
 *   - All approval reads/decisions are owner-scoped in the service layer
 *     (`.eq('user_id', userId)` + CAS transitions), so another user's id
 *     produces the SAME 404 as a missing id — ids cannot be probed.
 *   - AgentError messages are client-safe by contract; they are mapped to
 *     explicit HTTP statuses here (the app error handler has no code→status
 *     mapping of its own). Unexpected errors go to next(err) → generic 500.
 *   - A decision does not grant execution: the orchestrator re-verifies the
 *     binding hash, expiry, capability, operation and persisted args before
 *     anything runs (nine-check gate in approval.service.ts).
 */

import type { Request, Response, NextFunction } from 'express';
import { getAuth, getDb } from '../middleware/auth.middleware.js';
import {
  approvalDecisionBodySchema,
  approvalIdParamSchema,
  listApprovalsQuerySchema,
} from '../agents/approvals/approval.schemas.js';
import {
  approveApproval,
  cancelApproval,
  getApproval,
  listApprovals,
  rejectApproval,
} from '../agents/approvals/approval.service.js';
import { AGENT_ERROR_CODES, AgentError, isAgentError } from '../agents/shared/index.js';
import { createDomainRegistry } from '../agents/register.js';
import { resumeRun } from '../agents/orchestrator/orchestrator.service.js';

// ---------------------------------------------------------------------------
// AgentError → HTTP status (explicit; the central handler maps none)
// ---------------------------------------------------------------------------

function agentErrorStatus(err: AgentError): number {
  switch (err.code) {
    case AGENT_ERROR_CODES.INVALID_INPUT:
      return 400;
    case AGENT_ERROR_CODES.CAPABILITY_FORBIDDEN:
      return 403;
    case AGENT_ERROR_CODES.UNRESOLVED_REFERENCE:
      // Missing id and other-user id are indistinguishable by design.
      return 404;
    case AGENT_ERROR_CODES.INVALID_STATE:
    case AGENT_ERROR_CODES.APPROVAL_REQUIRED:
      // Already decided / not actionable / raced — a state conflict.
      return 409;
    case AGENT_ERROR_CODES.TIMEOUT:
      // The approval expired.
      return 410;
    case AGENT_ERROR_CODES.CAPABILITY_UNAVAILABLE:
      return 503;
    default:
      return 500;
  }
}

function sendAgentError(res: Response, err: AgentError): void {
  const status = agentErrorStatus(err);
  // Mirror the central handler's rule: 5xx messages may carry store or
  // provider internals, so only sub-500 (client-authored) messages surface.
  const message =
    status >= 500 ? 'The approval service could not complete the request.' : err.message;
  res.status(status).json({ error: message, code: err.code });
}

// ---------------------------------------------------------------------------
// GET /api/approvals
// ---------------------------------------------------------------------------

export async function listApprovalsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const parsed = listApprovalsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
      return;
    }

    const approvals = await listApprovals(db, userId, parsed.data);
    res.status(200).json({ approvals });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/approvals/:id
// ---------------------------------------------------------------------------

export async function getApprovalHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const params = approvalIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: 'Invalid approval id' });
      return;
    }

    // Owner-scoped: null for missing AND for other users' approvals (404,
    // no cross-account probing).
    const approval = await getApproval(db, userId, params.data.id);
    if (!approval) {
      res.status(404).json({ error: 'Approval not found' });
      return;
    }

    res.status(200).json({ approval });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Decision handlers (approve / reject / cancel)
// ---------------------------------------------------------------------------

async function decideHandler(
  req: Request,
  res: Response,
  next: NextFunction,
  action: 'approve' | 'reject' | 'cancel',
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const params = approvalIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: 'Invalid approval id' });
      return;
    }
    // Strictly empty: any body field (including `user_id`) is rejected.
    const body = approvalDecisionBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({
        error: 'Decision requests must not carry any body fields (identity comes from your token).',
        details: body.error.flatten(),
      });
      return;
    }

    const id = params.data.id;
    const approval =
      action === 'approve'
        ? await approveApproval(db, userId, id)
        : action === 'reject'
          ? await rejectApproval(db, userId, id)
          : await cancelApproval(db, userId, id);

    // Continue the workflow so the approval gate settles (reject/cancel) or
    // promotes + executes (approve) the paused step. The DECISION is already
    // persisted; a resume failure must not roll it back — the run simply
    // stays paused until the next resume trigger.
    let resumed = false;
    try {
      await resumeRun(db, userId, approval.run_id, createDomainRegistry());
      resumed = true;
    } catch {
      resumed = false;
    }

    // Return the POST-resume row (an approved grant may already be
    // executed/settled by now) — the decision response reflects reality.
    const fresh = (await getApproval(db, userId, id)) ?? approval;
    res.status(200).json({ approval: fresh, resumed });
  } catch (err) {
    if (isAgentError(err)) {
      sendAgentError(res, err);
      return;
    }
    next(err);
  }
}

export async function approveHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  await decideHandler(req, res, next, 'approve');
}

export async function rejectHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  await decideHandler(req, res, next, 'reject');
}

export async function cancelHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  await decideHandler(req, res, next, 'cancel');
}
