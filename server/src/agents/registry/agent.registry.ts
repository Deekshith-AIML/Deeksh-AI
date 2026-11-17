/**
 * M6 Phase 2 — Agent Registry (Module C).
 *
 * The single source of truth for which agents exist, which capabilities they
 * expose, and what each capability is allowed to do. The orchestrator can
 * only dispatch what is registered here; the model can never invent a
 * backend function. Capabilities are declarative metadata — input validation,
 * approval policy, timeout, idempotency and availability are enforced by the
 * registry, not trusted from the plan.
 */

import type { z } from 'zod';
import type { Agent, AgentName } from '../shared/agent.types.js';
import { AGENT_ERROR_CODES, AgentError, operationNameSchema } from '../shared/index.js';

// ---------------------------------------------------------------------------
// Capability metadata
// ---------------------------------------------------------------------------

/**
 * Permissions a capability may require. Every permission maps to an existing,
 * owner-scoped backend service — there is no raw SQL, filesystem or arbitrary
 * network permission.
 */
export type CapabilityPermission =
  | 'memory:read'
  | 'memory:write'
  | 'documents:read'
  | 'tasks:read'
  | 'tasks:write'
  | 'tasks:delete'
  | 'reminders:read'
  | 'reminders:write'
  | 'draft:compose';

export interface CapabilityDefinition {
  /** Globally unique capability name, e.g. 'memory.retrieve'. */
  readonly name: string;
  /** Owning agent. */
  readonly agent: AgentName;
  /** Operations this capability serves (validated snake_case). */
  readonly operations: readonly string[];
  /** Permissions the executing service layer enforces per call. */
  readonly permissions: readonly CapabilityPermission[];
  /** Whether human approval is mandatory before execution. */
  readonly approvalRequired: boolean;
  /** Zod schema every dispatched input must pass. */
  readonly inputSchema: z.ZodTypeAny;
  /** Zod schema for the capability's structured output metadata. */
  readonly outputSchema?: z.ZodTypeAny;
  /** Default per-invocation timeout (ms), bounded 1s..5min. */
  readonly timeoutMs: number;
  /** Whether re-running with the same args is safe (gates retries). */
  readonly idempotent: boolean;
  /**
   * Whether a live provider/execution path exists. Unavailable capabilities
   * are still registered so the orchestrator can answer honestly
   * (CAPABILITY_UNAVAILABLE) instead of faking results.
   */
  readonly available: boolean;
  /** Why the capability is unavailable (shown to the user). */
  readonly unavailableReason?: string;
}

export interface RegisteredAgent {
  readonly agent: Agent;
  readonly capabilities: readonly CapabilityDefinition[];
}

export interface CapabilityHealth {
  readonly name: string;
  successes: number;
  failures: number;
  lastErrorAt: number | null;
  /** Degraded after repeated recent failures; never auto-removed. */
  degraded: boolean;
}

const CAPABILITY_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

function assertValidCapability(cap: CapabilityDefinition): void {
  if (!CAPABILITY_NAME_RE.test(cap.name)) {
    throw new Error(`Invalid capability name: ${cap.name}`);
  }
  if (cap.operations.length === 0) {
    throw new Error(`Capability ${cap.name} declares no operations`);
  }
  for (const op of cap.operations) {
    if (!operationNameSchema.safeParse(op).success) {
      throw new Error(`Capability ${cap.name} has invalid operation: ${op}`);
    }
  }
  if (cap.timeoutMs < 1_000 || cap.timeoutMs > 300_000) {
    throw new Error(`Capability ${cap.name} timeout out of bounds`);
  }
  if (!cap.available && !cap.unavailableReason) {
    throw new Error(`Unavailable capability ${cap.name} must declare a reason`);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class AgentRegistry {
  private readonly agents = new Map<AgentName, RegisteredAgent>();
  private readonly capabilities = new Map<string, CapabilityDefinition>();
  private readonly health = new Map<string, CapabilityHealth>();
  private readonly degradedAfter: number;

  constructor(opts?: { degradedAfter?: number }) {
    this.degradedAfter = opts?.degradedAfter ?? 3;
  }

  /**
   * Register an agent with its capabilities. Duplicate agent names,
   * duplicate capability names and invalid metadata are rejected loudly —
   * registration happens once at startup (Phase 5 wires the real agents).
   */
  register(agent: Agent, capabilities: CapabilityDefinition[]): void {
    if (this.agents.has(agent.name)) {
      throw new Error(`Agent already registered: ${agent.name}`);
    }
    if (capabilities.length === 0) {
      throw new Error(`Agent ${agent.name} registered without capabilities`);
    }
    for (const cap of capabilities) {
      assertValidCapability(cap);
      if (cap.agent !== agent.name) {
        throw new Error(`Capability ${cap.name} claims agent ${cap.agent}, not ${agent.name}`);
      }
      if (this.capabilities.has(cap.name)) {
        throw new Error(`Capability already registered: ${cap.name}`);
      }
    }
    for (const cap of capabilities) {
      this.capabilities.set(cap.name, cap);
      this.health.set(cap.name, {
        name: cap.name,
        successes: 0,
        failures: 0,
        lastErrorAt: null,
        degraded: false,
      });
    }
    this.agents.set(agent.name, { agent, capabilities });
  }

  hasAgent(name: string): name is AgentName {
    return this.agents.has(name as AgentName);
  }

  getAgent(name: string): Agent {
    const entry = this.agents.get(name as AgentName);
    if (!entry) {
      throw new AgentError(AGENT_ERROR_CODES.CAPABILITY_UNAVAILABLE, `Unknown agent: ${name}`);
    }
    return entry.agent;
  }

  listAgents(): AgentName[] {
    return [...this.agents.keys()];
  }

  listCapabilities(opts?: { agent?: AgentName; includeUnavailable?: boolean }): CapabilityDefinition[] {
    const all = [...this.capabilities.values()];
    return all.filter(
      (c) =>
        (!opts?.agent || c.agent === opts.agent) &&
        (c.available || opts?.includeUnavailable === true),
    );
  }

  /** Resolve a capability by exact name; throws when not registered. */
  resolve(name: string): CapabilityDefinition {
    const cap = this.capabilities.get(name);
    if (!cap) {
      throw new AgentError(AGENT_ERROR_CODES.CAPABILITY_UNAVAILABLE, `Unknown capability: ${name}`);
    }
    return cap;
  }

  /**
   * Find the capability serving an (agent, operation) pair — the shape a
   * model-proposed plan step carries. Returns null when no registered
   * capability covers it (unavailable capabilities ARE returned here so the
   * caller can report them honestly; availability is enforced at dispatch).
   */
  findCapabilityFor(agent: string, operation: string): CapabilityDefinition | null {
    for (const cap of this.capabilities.values()) {
      if (cap.agent === agent && cap.operations.includes(operation)) return cap;
    }
    return null;
  }

  /**
   * Full dispatch gate: resolves the capability, verifies its agent is
   * registered, checks availability, verifies the requested operation is
   * declared, and validates args against the capability's input schema.
   * Returns the validated args — dispatch must use ONLY these.
   */
  validateRequest(
    capabilityName: string,
    operation: string,
    rawArgs: unknown,
  ): { capability: CapabilityDefinition; agent: Agent; args: unknown } {
    const capability = this.resolve(capabilityName);

    if (!capability.available) {
      throw new AgentError(
        AGENT_ERROR_CODES.CAPABILITY_UNAVAILABLE,
        capability.unavailableReason ?? `${capability.name} is not available.`,
      );
    }
    if (!capability.operations.includes(operation)) {
      throw new AgentError(
        AGENT_ERROR_CODES.CAPABILITY_FORBIDDEN,
        `Operation '${operation}' is not permitted for ${capability.name}.`,
      );
    }
    const agent = this.getAgent(capability.agent);
    const parsed = capability.inputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      throw new AgentError(
        AGENT_ERROR_CODES.INVALID_INPUT,
        `Invalid input for ${capability.name}: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return { capability, agent, args: parsed.data };
  }

  /**
   * Plan-step dispatch gate: resolves (agent, operation) to a registered
   * capability, checks availability, then validates args against the
   * capability's input schema. Returns the validated args.
   */
  validatePlanStep(
    agent: string,
    operation: string,
    rawArgs: unknown,
  ): { capability: CapabilityDefinition; agent: Agent; args: unknown } {
    const capability = this.findCapabilityFor(agent, operation);
    if (!capability) {
      throw new AgentError(
        AGENT_ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `No registered capability for agent '${agent}' operation '${operation}'.`,
      );
    }
    return this.validateRequest(capability.name, operation, rawArgs);
  }

  /** Whether a plan step (capability + operation) may be dispatched at all. */
  canDispatch(capabilityName: string, operation: string): boolean {
    const cap = this.capabilities.get(capabilityName);
    return Boolean(cap && cap.available && cap.operations.includes(operation));
  }

  // -------------------------------------------------------------------------
  // Health tracking (observability — Phase 8 displays this)
  // -------------------------------------------------------------------------

  recordSuccess(capabilityName: string): void {
    const h = this.health.get(capabilityName);
    if (h) {
      h.successes += 1;
      h.degraded = false;
    }
  }

  recordFailure(capabilityName: string): void {
    const h = this.health.get(capabilityName);
    if (h) {
      h.failures += 1;
      h.lastErrorAt = Date.now();
      if (h.failures >= this.degradedAfter) h.degraded = true;
    }
  }

  healthSnapshot(capabilityName: string): CapabilityHealth | null {
    const h = this.health.get(capabilityName);
    return h ? { ...h } : null;
  }
}

// ---------------------------------------------------------------------------
// Default registry instance (populated in Phase 5)
// ---------------------------------------------------------------------------

/** Process-wide registry. Agents are registered once during bootstrap. */
export const agentRegistry = new AgentRegistry();
