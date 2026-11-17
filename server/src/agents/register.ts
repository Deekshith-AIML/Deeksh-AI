/**
 * M6 Phase 5 — Domain agent registration (Module C wiring).
 *
 * The ONLY place concrete agents are bound to a registry. Registration is
 * explicit (never a side effect of importing a module) so tests and the API
 * route each get a deterministic registry, and the process-wide
 * `agentRegistry` stays untouched until the API layer opts in.
 *
 * Phase 9 will additionally register `research` and `communication` as
 * DECLARED-UNAVAILABLE capabilities (honest refusal — no fake backends).
 */

import { AgentRegistry } from './registry/agent.registry.js';
import { memoryAgent, memoryCapabilities } from './memory/memory.agent.js';
import { knowledgeAgent, knowledgeCapabilities } from './knowledge/knowledge.agent.js';
import { taskAgent, taskCapabilities } from './task/task.agent.js';
import { schedulingAgent, schedulingCapabilities } from './scheduling/scheduling.agent.js';

/**
 * Register the four live domain agents (memory, knowledge, task,
 * scheduling) with their capability metadata. Throws on any duplicate or
 * invalid registration — a startup-time failure, never a silent gap.
 */
export function registerDomainAgents(registry: AgentRegistry): void {
  registry.register(memoryAgent, memoryCapabilities);
  registry.register(knowledgeAgent, knowledgeCapabilities);
  registry.register(taskAgent, taskCapabilities);
  registry.register(schedulingAgent, schedulingCapabilities);
}

/** Build a fresh registry pre-populated with the live domain agents. */
export function createDomainRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registerDomainAgents(registry);
  return registry;
}
