/**
 * M6 Phase 2 — Agent Registry tests (Module C).
 *
 * Covers registration integrity (no duplicates, valid metadata), capability
 * discovery, dispatch gating (availability, operation allowlist, Zod input
 * validation), honest unavailable-capability answers and health tracking.
 * Pure in-memory — no provider or database access.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentRegistry } from '../src/agents/registry/agent.registry.js';
import { AGENT_ERROR_CODES, AgentError } from '../src/agents/shared/index.js';
import type { Agent, AgentInput } from '../src/agents/shared/index.js';
import type { CapabilityDefinition } from '../src/agents/registry/agent.registry.js';

const retrieveCap: CapabilityDefinition = {
  name: 'memory.retrieve',
  agent: 'memory',
  operations: ['retrieve', 'search'],
  permissions: ['memory:read'],
  approvalRequired: false,
  inputSchema: z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).default(5) }),
  timeoutMs: 15_000,
  idempotent: true,
  available: true,
};

const sendCap: CapabilityDefinition = {
  name: 'communication.send_email',
  agent: 'communication',
  operations: ['send'],
  permissions: ['draft:compose'],
  approvalRequired: true,
  inputSchema: z.object({ to: z.string().email(), subject: z.string().min(1) }),
  timeoutMs: 30_000,
  idempotent: false,
  available: false,
  unavailableReason: 'No Gmail API integration is configured in this milestone (M6).',
};

function makeAgent(name: Agent['name']): Agent {
  return {
    name,
    canHandle: (_input: AgentInput) => Promise.resolve(true),
    execute: () => Promise.resolve({ status: 'ok' }),
  };
}

function registryWithMemory(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(makeAgent('memory'), [retrieveCap]);
  return registry;
}

describe('M6 Phase 2 — registration', () => {
  it('registers an agent with capabilities and lists them', () => {
    const registry = registryWithMemory();
    expect(registry.listAgents()).toEqual(['memory']);
    expect(registry.listCapabilities()).toHaveLength(1);
    expect(registry.listCapabilities({ agent: 'memory' })[0]?.name).toBe('memory.retrieve');
    expect(registry.hasAgent('memory')).toBe(true);
    expect(registry.hasAgent('task')).toBe(false);
  });

  it('rejects duplicate agent registration', () => {
    const registry = registryWithMemory();
    expect(() => registry.register(makeAgent('memory'), [retrieveCap])).toThrow(
      /already registered: memory/,
    );
  });

  it('rejects duplicate capability names across agents', () => {
    const registry = registryWithMemory();
    const other: CapabilityDefinition = { ...retrieveCap, agent: 'task' };
    expect(() => registry.register(makeAgent('task'), [other])).toThrow(
      /Capability already registered/,
    );
  });

  it('rejects an agent registered with zero capabilities', () => {
    const registry = new AgentRegistry();
    expect(() => registry.register(makeAgent('task'), [])).toThrow(/without capabilities/);
  });

  it('rejects metadata that claims the wrong owning agent', () => {
    const registry = new AgentRegistry();
    const wrong: CapabilityDefinition = { ...retrieveCap, agent: 'task' };
    expect(() => registry.register(makeAgent('memory'), [wrong])).toThrow(/claims agent/);
  });

  it('rejects invalid capability names, operations and timeouts', () => {
    const registry = new AgentRegistry();
    expect(() =>
      registry.register(makeAgent('memory'), [{ ...retrieveCap, name: 'bad name' }]),
    ).toThrow(/Invalid capability name/);
    expect(() =>
      registry.register(makeAgent('memory'), [{ ...retrieveCap, operations: ['DROP TABLE'] }]),
    ).toThrow(/invalid operation/);
    expect(() =>
      registry.register(makeAgent('memory'), [{ ...retrieveCap, timeoutMs: 500 }]),
    ).toThrow(/timeout out of bounds/);
    expect(() =>
      registry.register(makeAgent('memory'), [{ ...retrieveCap, timeoutMs: 400_000 }]),
    ).toThrow(/timeout out of bounds/);
  });

  it('requires unavailable capabilities to declare an honest reason', () => {
    const registry = new AgentRegistry();
    const { unavailableReason: _drop, ...noReason } = sendCap;
    expect(() => registry.register(makeAgent('communication'), [{ ...noReason }])).toThrow(
      /must declare a reason/,
    );
  });
});

describe('M6 Phase 2 — dispatch gating', () => {
  it('validates a good request and returns normalized args (defaults applied)', () => {
    const registry = registryWithMemory();
    const { args, capability, agent } = registry.validateRequest('memory.retrieve', 'retrieve', {
      query: 'career goals',
    });
    expect(args).toEqual({ query: 'career goals', limit: 5 });
    expect(capability.name).toBe('memory.retrieve');
    expect(agent.name).toBe('memory');
  });

  it('rejects unknown capabilities with CAPABILITY_UNAVAILABLE', () => {
    const registry = registryWithMemory();
    try {
      registry.validateRequest('memory.erase', 'retrieve', {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe(AGENT_ERROR_CODES.CAPABILITY_UNAVAILABLE);
    }
    expect(() => registry.getAgent('ghost')).toThrow(AgentError);
  });

  it('rejects operations outside the declared allowlist', () => {
    const registry = registryWithMemory();
    try {
      registry.validateRequest('memory.retrieve', 'delete', { query: 'x' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AgentError).code).toBe(AGENT_ERROR_CODES.CAPABILITY_FORBIDDEN);
    }
  });

  it('rejects unavailable capabilities with the honest reason (no fake execution)', () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('communication'), [sendCap]);
    try {
      registry.validateRequest('communication.send_email', 'send', {
        to: 'a@b.com',
        subject: 'hi',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AgentError).code).toBe(AGENT_ERROR_CODES.CAPABILITY_UNAVAILABLE);
      expect((err as AgentError).message).toMatch(/Gmail API/);
    }
    expect(registry.canDispatch('communication.send_email', 'send')).toBe(false);
  });

  it('rejects invalid input with INVALID_INPUT and a labelled message', () => {
    const registry = registryWithMemory();
    try {
      registry.validateRequest('memory.retrieve', 'retrieve', { query: '' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AgentError).code).toBe(AGENT_ERROR_CODES.INVALID_INPUT);
      expect((err as AgentError).message).toContain('memory.retrieve');
      expect((err as AgentError).message).toContain('query');
    }
    // Wrong types too.
    expect(() => registry.validateRequest('memory.retrieve', 'retrieve', { query: 42 })).toThrow(
      AgentError,
    );
  });

  it('strips unknown input keys via the capability schema (no smuggled fields)', () => {
    const registry = registryWithMemory();
    const { args } = registry.validateRequest('memory.retrieve', 'retrieve', {
      query: 'x',
      user_id: 'attacker',
      sql: 'select 1',
    });
    expect(args).toEqual({ query: 'x', limit: 5 });
  });

  it('canDispatch reflects availability and operation allowlist', () => {
    const registry = registryWithMemory();
    expect(registry.canDispatch('memory.retrieve', 'retrieve')).toBe(true);
    expect(registry.canDispatch('memory.retrieve', 'erase')).toBe(false);
    expect(registry.canDispatch('nope.nope', 'retrieve')).toBe(false);
  });

  it('hides unavailable capabilities from the default discovery list', () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('communication'), [sendCap]);
    expect(registry.listCapabilities()).toHaveLength(0);
    expect(registry.listCapabilities({ includeUnavailable: true })).toHaveLength(1);
  });
});

describe('M6 Phase 2 — health tracking', () => {
  it('tracks successes and failures and degrades after repeated failures', () => {
    const registry = new AgentRegistry({ degradedAfter: 2 });
    registry.register(makeAgent('memory'), [retrieveCap]);

    expect(registry.healthSnapshot('memory.retrieve')).toMatchObject({
      successes: 0,
      failures: 0,
      degraded: false,
    });

    registry.recordSuccess('memory.retrieve');
    registry.recordFailure('memory.retrieve');
    expect(registry.healthSnapshot('memory.retrieve')?.degraded).toBe(false);

    registry.recordFailure('memory.retrieve');
    expect(registry.healthSnapshot('memory.retrieve')?.degraded).toBe(true);

    // A later success clears the degraded flag.
    registry.recordSuccess('memory.retrieve');
    expect(registry.healthSnapshot('memory.retrieve')?.degraded).toBe(false);

    expect(registry.healthSnapshot('unknown.cap')).toBeNull();
  });
});
