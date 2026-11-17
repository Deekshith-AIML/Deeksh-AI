/**
 * Phase 6 — Zod schemas for the authenticated approval API (M6).
 *
 * SECURITY: decision bodies are STRICTLY EMPTY. Identity never comes from
 * a body, query, or header other than the verified bearer token — a body
 * that tries to carry `user_id` (or any field) is rejected with 400 rather
 * than silently stripped, so the rejection is explicit and testable.
 */

import { z } from 'zod';
import { APPROVAL_STATUSES } from './approval.store.js';

/** Approval ids are UUIDs (gen_random_uuid) — reject anything else early. */
export const approvalIdParamSchema = z.object({
  id: z.string().uuid('Invalid approval id'),
});

/** Optional owner-scoped list filters. */
export const listApprovalsQuerySchema = z.object({
  status: z.enum(APPROVAL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Approve / reject / cancel take NO body fields. `.strict()` makes an
 * attempted identity injection (`{ "user_id": "..." }`) a 400 instead of
 * something that could ever be mistaken for an identity source.
 */
export const approvalDecisionBodySchema = z.object({}).strict();

export type ApprovalDecisionInput = z.infer<typeof approvalDecisionBodySchema>;
export type ListApprovalsQuery = z.infer<typeof listApprovalsQuerySchema>;
