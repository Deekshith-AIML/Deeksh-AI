/**
 * Phase 1 — Shared agent interfaces (M6 Multi-Agent Orchestration Engine).
 *
 * Every specialized agent (Memory, Knowledge, Task, Scheduling, Research,
 * Communication) implements the same contract so the orchestrator can treat
 * them uniformly. Agents are capability-scoped adapters: they receive a
 * user-scoped Supabase client and call the EXISTING domain services — they
 * never open arbitrary table access and never bypass backend authorization.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The fixed set of registered agent names in M6. */
export type AgentName =
  | 'memory'
  | 'knowledge'
  | 'task'
  | 'scheduling'
  | 'research'
  | 'communication';

/**
 * Validated input for a single agent operation.
 *
 * `args` is raw model-adjacent data; the registry validates it against the
 * capability's Zod input schema BEFORE `execute` is called. Identity is never
 * part of the input — `userId` comes exclusively from the authenticated
 * request via {@link AgentContext}.
 */
export interface AgentInput {
  /** Registry-validated operation name (e.g. 'retrieve', 'create'). */
  operation: string;
  /** Operation arguments; validated by the capability input schema. */
  args: Record<string, unknown>;
}

/**
 * Execution context supplied by the orchestrator. Agents may only act with
 * what is provided here.
 */
export interface AgentContext {
  /** Verified authenticated owner. The ONLY source of ownership. */
  userId: string;
  /** User-scoped (RLS) Supabase client for this run. */
  client: SupabaseClient;
  /** Workflow run id this step belongs to. */
  runId: string;
  /** Step id for logging/traceability. */
  stepId: string;
  /** Absolute deadline (epoch ms) after which the step must abort. */
  deadline: number;
  /** Cooperative cancellation signal (user cancel / run timeout). */
  signal?: AbortSignal;
  /** Structured logger; must never emit credentials or raw secrets. */
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Outcome status of one agent execution. */
export type AgentResultStatus = 'ok' | 'failed' | 'unavailable' | 'needs_approval';

/** Structured, validated result of one agent execution. */
export interface AgentResult {
  status: AgentResultStatus;
  /** Machine-readable output metadata (bounded; no secrets). */
  output?: Record<string, unknown>;
  /** Human-readable summary safe to show in the UI. */
  summary?: string;
  /** Set when status is 'failed'. */
  error?: { code: string; message: string };
  /** Set when status is 'unavailable' (capability not backed by a live provider). */
  unavailableReason?: string;
  /** Set when status is 'needs_approval'. */
  approval?: {
    actionDescription: string;
    /** Exact proposed payload that must be approved before execution. */
    payload: Record<string, unknown>;
  };
}

/**
 * The agent contract. `canHandle` is a cheap capability check (no side
 * effects); `execute` performs the work through existing services.
 */
export interface Agent {
  readonly name: AgentName;
  canHandle(input: AgentInput): Promise<boolean>;
  execute(input: AgentInput, context: AgentContext): Promise<AgentResult>;
}
