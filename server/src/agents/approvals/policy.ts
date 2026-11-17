/**
 * Phase 6 — Operation risk policy (M6).
 *
 * Explicit, audited classification of EVERY registered capability. The
 * enforcement point is the registry's `approvalRequired` flag plus this
 * matrix (asserted identical by unit tests); execution additionally goes
 * through the nine-check gate in approval.service.ts.
 *
 * Risk classes:
 *   read        — no side effects; approval never required.
 *   mutate      — internal user-data change, non-destructive; approval by
 *                 default policy (task create/update, scheduling create/update).
 *   destructive — irreversible or consequential side effects; approval ALWAYS
 *                 required (task.delete, scheduling.cancel).
 *   unsupported — no live execution path registered; dispatch is refused
 *                 before any approval exists.
 *
 * Nothing here grants permissions. The backend does. An LLM proposing an
 * approvalRequired step only causes a PENDING row to exist — it cannot
 * flip it to approved.
 */

export type RiskClass = 'read' | 'mutating' | 'destructive' | 'unsupported';

export interface CapabilityPolicy {
  /** Capability name as registered, e.g. 'task.delete'. */
  name: string;
  risk: RiskClass;
  approvalRequired: boolean;
  /** What approving it actually authorizes — shown to the human. */
  summary: string;
}

/**
 * The matrix below MUST stay in lock-step with the capability definitions
 * registered in agents (checked by tests). Adding a capability? Classify
 * it here first.
 */
export const OPERATION_RISK_POLICY: readonly CapabilityPolicy[] = [
  // ---- Memory -----------------------------------------------------------
  { name: 'memory.retrieve', risk: 'read', approvalRequired: false,
    summary: 'Read saved memories (owner-scoped). No data changes.' },
  { name: 'memory.create', risk: 'mutating', approvalRequired: false,
    summary: 'Save a new memory for the user. Reversible; confidence-tracked.' },
  // ---- Knowledge (documents) --------------------------------------------
  { name: 'knowledge.search', risk: 'read', approvalRequired: false,
    summary: 'Vector-search the user’s own uploaded documents. No data changes.' },
  { name: 'knowledge.list', risk: 'read', approvalRequired: false,
    summary: 'List the user’s documents and processing state. No data changes.' },
  // ---- Tasks -------------------------------------------------------------
  { name: 'task.list', risk: 'read', approvalRequired: false,
    summary: 'List the user’s tasks. No data changes.' },
  { name: 'task.create', risk: 'mutating', approvalRequired: false,
    summary: 'Create a task for the user. Duplicate detection built in.' },
  { name: 'task.update', risk: 'mutating', approvalRequired: false,
    summary: 'Change a task the user owns (owner-scoped).' },
  { name: 'task.delete', risk: 'destructive', approvalRequired: true,
    summary: 'Permanently delete a task. Cannot be undone.' },
  // ---- Scheduling ---------------------------------------------------------
  { name: 'scheduling.list', risk: 'read', approvalRequired: false,
    summary: 'List the user’s reminders. No data changes.' },
  { name: 'scheduling.create', risk: 'mutating', approvalRequired: false,
    summary: 'Schedule a reminder (delivery via Resend; idempotency-key supported).' },
  { name: 'scheduling.update', risk: 'mutating', approvalRequired: false,
    summary: 'Reschedule a pending reminder the user owns.' },
  { name: 'scheduling.cancel', risk: 'destructive', approvalRequired: true,
    summary: 'Cancel a pending reminder. Missed delivery cannot be undone.' },
];

export const policyByName = new Map(OPERATION_RISK_POLICY.map((p) => [p.name, p]));

/** Approval requirement for a capability, or null when unclassified. */
export function approvalRequiredFor(capabilityName: string): boolean | null {
  const p = policyByName.get(capabilityName);
  return p ? p.approvalRequired : null;
}
