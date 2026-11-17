/**
 * M6 Phase 4 — Central Orchestrator tests (Module A).
 *
 * Covers: triage defaulting to normal chat, plan validation/registry gating,
 * dependency-ordered execution, bounded parallelism, approval pauses,
 * timeouts, idempotent retry, cancellation, partial failure with dependent
 * skip, duplicate-run prevention, and truthful response building.
 *
 * OpenAI (Gemini-compatible endpoint) is mocked — no API calls or charges.
 * Supabase is the in-memory fake.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { openaiCreate } = vi.hoisted(() => ({ openaiCreate: vi.fn() }));

vi.mock('openai', () => {
  class APIConnectionTimeoutError extends Error {}
  class APIError extends Error {}
  class FakeOpenAI {
    chat = { completions: { create: openaiCreate } };
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    static APIError = APIError;
    constructor(_options?: Record<string, unknown>) {}
  }
  return { default: FakeOpenAI };
});

vi.mock('../src/services/supabase.service.js', async () => {
  const { fakeCreateUserScopedClient } = await import('./helpers/fakeSupabase.js');
  return {
    createUserScopedClient: fakeCreateUserScopedClient,
    createAdminClient: () => {
      throw new Error('admin client unavailable in tests');
    },
  };
});

import {
  orchestrate,
  executeObjective,
  triageRequest,
  extractJson,
  MAX_ORCHESTRATOR_LLM_CALLS,
} from '../src/agents/orchestrator/orchestrator.service.js';
import { AgentRegistry } from '../src/agents/registry/agent.registry.js';
import { AgentError, parseExecutionPlan } from '../src/agents/shared/index.js';
import type { Agent, AgentContext, AgentInput, AgentResult } from '../src/agents/shared/index.js';
import type { CapabilityDefinition } from '../src/agents/registry/agent.registry.js';
import * as store from '../src/agents/workflow/workflow.store.js';
import {
  fakeCreateUserScopedClient,
  registerUser,
  resetFakeSupabase,
} from './helpers/fakeSupabase.js';
import { assistantReply } from './helpers/geminiMocks.js';
import { z } from 'zod';

const TOKEN = 'headerP.payloadP.signatureP';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

const emptyArgs = z.object({}).passthrough();

interface AgentScript {
  /** Executed operations in order (for ordering assertions). */
  calls: Array<{ agent: string; operation: string }>;
  /** Optional failure injection by operation. */
  failOperations?: Set<string>;
  /** Artificial delay (ms) for parallelism tests. */
  delayMs?: number;
}

function makeCap(agent: string, operation: string, extra: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
  return {
    name: `${agent}.${operation}`,
    agent: agent as CapabilityDefinition['agent'],
    operations: [operation],
    permissions: [],
    approvalRequired: false,
    inputSchema: emptyArgs,
    timeoutMs: 5_000,
    idempotent: false,
    available: true,
    ...extra,
  };
}

/** Build a registry with stub agents whose behavior is scripted. */
function registryWith(script: AgentScript, caps: CapabilityDefinition[]): AgentRegistry {
  const registry = new AgentRegistry();
  const agents = new Map<string, Agent>();
  for (const cap of caps) {
    if (agents.has(cap.agent)) continue;
    const name = cap.agent;
    agents.set(name, {
      name,
      canHandle: () => Promise.resolve(true),
      execute: async (input: AgentInput, _ctx: AgentContext): Promise<AgentResult> => {
        script.calls.push({ agent: name, operation: input.operation });
        if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
        if (script.failOperations?.has(input.operation)) {
          return {
            status: 'failed',
            error: { code: 'EXECUTION_FAILED', message: `${input.operation} blew up` },
          };
        }
        return { status: 'ok', summary: `${name} did ${input.operation}`, output: { ok: true } };
      },
    });
  }
  for (const agent of agents.values()) {
    registry.register(
      agent,
      caps.filter((c) => c.agent === agent.name),
    );
  }
  return registry;
}

function jsonReply(obj: unknown) {
  return assistantReply(JSON.stringify(obj));
}

function twoStepPlan(extra: Record<string, unknown> = {}): unknown {
  return {
    objective: 'Test objective',
    steps: [
      { stepKey: 'lookup', agent: 'memory', operation: 'retrieve' },
      {
        stepKey: 'record',
        agent: 'task',
        operation: 'create',
        dependsOn: ['lookup'],
        ...extra,
      },
    ],
    requiresApproval: false,
  };
}

let client: ReturnType<typeof fakeCreateUserScopedClient>;

beforeEach(() => {
  resetFakeSupabase();
  registerUser(TOKEN, USER, 'p@example.com');
  registerUser('token-o', OTHER, 'o@example.com');
  client = fakeCreateUserScopedClient(TOKEN);
  openaiCreate.mockReset();
});

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

describe('orchestrator triage', () => {
  it('returns false for a simple request (normal chat path)', async () => {
    openaiCreate.mockResolvedValueOnce(jsonReply({ orchestrate: false }));
    expect(await triageRequest(client, USER, 'what is the capital of France?')).toBe(false);
  });

  it('returns true for a multi-step request', async () => {
    openaiCreate.mockResolvedValueOnce(jsonReply({ orchestrate: true }));
    expect(
      await triageRequest(client, USER, 'read my internship doc, make a task, remind me tomorrow'),
    ).toBe(true);
  });

  it('defaults to false on unparseable output (never forces chat into a workflow)', async () => {
    openaiCreate.mockResolvedValueOnce(assistantReply('I refuse to answer in JSON'));
    expect(await triageRequest(client, USER, 'hello')).toBe(false);
  });

  it('defaults to false when the provider errors', async () => {
    openaiCreate.mockRejectedValueOnce(new Error('network down'));
    expect(await triageRequest(client, USER, 'hello')).toBe(false);
  });

  it('orchestrate() returns null for non-orchestrated requests (no run created)', async () => {
    openaiCreate.mockResolvedValueOnce(jsonReply({ orchestrate: false }));
    const result = await orchestrate(client, USER, 'hi', new AgentRegistry());
    expect(result).toBeNull();
    expect(await store.listRuns(client, USER)).toHaveLength(0);
  });

  it('extractJson tolerates code fences and prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":1} hope that helps')).toEqual({ a: 1 });
    expect(extractJson('no json here')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Planning gate
// ---------------------------------------------------------------------------

describe('orchestrator planning gate', () => {
  it('rejects a plan whose operation is not registered (model cannot invent functions)', async () => {
    const script: AgentScript = { calls: [] };
    const registry = registryWith(script, [makeCap('memory', 'retrieve')]);
    openaiCreate.mockResolvedValueOnce(
      jsonReply({
        objective: 'x',
        steps: [{ stepKey: 'boom', agent: 'task', operation: 'drop_table' }],
      }),
    );
    await expect(executeObjective(client, USER, 'x', registry)).rejects.toThrow(AgentError);
    // Run recorded as failed with an honest error; nothing executed.
    expect(script.calls).toHaveLength(0);
    const runs = await store.listRuns(client, USER);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error_code).toBe('INVALID_PLAN');
  });

  it('rejects structurally invalid plans (cycles, duplicates, identity fields)', async () => {
    const script: AgentScript = { calls: [] };
    const registry = registryWith(script, [makeCap('memory', 'retrieve')]);

    for (const bad of [
      // cycle
      {
        objective: 'x',
        steps: [
          { stepKey: 'a', agent: 'memory', operation: 'retrieve', dependsOn: ['b'] },
          { stepKey: 'b', agent: 'memory', operation: 'retrieve', dependsOn: ['a'] },
        ],
      },
      // duplicate keys
      {
        objective: 'x',
        steps: [
          { stepKey: 'a', agent: 'memory', operation: 'retrieve' },
          { stepKey: 'a', agent: 'memory', operation: 'retrieve' },
        ],
      },
      // model-supplied identity
      {
        objective: 'x',
        steps: [{ stepKey: 'a', agent: 'memory', operation: 'retrieve', args: { user_id: 'evil' } }],
      },
      // unparseable garbage
      { nonsense: true },
    ]) {
      openaiCreate.mockReset();
      openaiCreate.mockResolvedValueOnce(jsonReply(bad));
      await expect(executeObjective(client, USER, 'x', registry)).rejects.toThrow(/Invalid|plan/i);
      expect(script.calls).toHaveLength(0);
    }
  });

  it('rejects unavailable capabilities at planning time (honest failure, no fake work)', async () => {
    const script: AgentScript = { calls: [] };
    const registry = registryWith(script, [
      makeCap('research', 'web_search', {
        available: false,
        unavailableReason: 'No web-search provider exists in this milestone.',
      }),
    ]);
    openaiCreate.mockResolvedValueOnce(
      jsonReply({
        objective: 'research something',
        steps: [{ stepKey: 'search', agent: 'research', operation: 'web_search' }],
      }),
    );
    await expect(executeObjective(client, USER, 'research', registry)).rejects.toThrow(
      /web-search provider/,
    );
    expect(script.calls).toHaveLength(0);
  });

  it('bounds the number of planning/LLM calls (no uncontrolled loop)', async () => {
    const script: AgentScript = { calls: [] };
    const registry = registryWith(script, [
      makeCap('memory', 'retrieve'),
      makeCap('task', 'create'),
    ]);
    openaiCreate.mockResolvedValueOnce(jsonReply(twoStepPlan()));
    const result = await executeObjective(client, USER, 'x', registry);
    expect(result.llmCalls).toBeLessThanOrEqual(MAX_ORCHESTRATOR_LLM_CALLS);
    expect(openaiCreate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

describe('orchestrator execution', () => {
  it('executes dependent steps in order and verifies completion', async () => {
    const script: AgentScript = { calls: [] };
    const registry = registryWith(script, [
      makeCap('memory', 'retrieve'),
      makeCap('task', 'create'),
    ]);
    openaiCreate.mockResolvedValueOnce(jsonReply(twoStepPlan()));

    const result = await executeObjective(client, USER, 'do the thing', registry);

    expect(result.status).toBe('completed');
    expect(result.awaitingApproval).toBe(false);
    expect(script.calls.map((c) => `${c.agent}:${c.operation}`)).toEqual([
      'memory:retrieve',
      'task:create',
    ]);
    expect(result.outcomes.every((o) => o.status === 'completed')).toBe(true);
    expect(result.response).toContain('verified');

    // Durable state matches the claim.
    const run = await store.getRunOrThrow(client, USER, result.runId);
    expect(run.status).toBe('completed');
    const steps = await store.listSteps(client, USER, result.runId);
    expect(steps.every((s) => s.status === 'completed')).toBe(true);
  });

  it('runs independent steps concurrently (bounded) rather than strictly serially', async () => {
    const script: AgentScript = { calls: [], delayMs: 60 };
    const registry = registryWith(script, [
      makeCap('memory', 'retrieve'),
      makeCap('knowledge', 'search'),
    ]);
    openaiCreate.mockResolvedValueOnce(
      jsonReply({
        objective: 'parallel',
        steps: [
          { stepKey: 'mem', agent: 'memory', operation: 'retrieve' },
          { stepKey: 'docs', agent: 'knowledge', operation: 'search' },
        ],
      }),
    );
    const startedAt = Date.now();
    const result = await executeObjective(client, USER, 'parallel', registry);
    const elapsed = Date.now() - startedAt;
    expect(result.status).toBe('completed');
    // Serial would be >=120ms; concurrent ~60ms (+overhead).
    expect(elapsed).toBeLessThan(115);
    expect(script.calls).toHaveLength(2);
  });

  it('marks a failed step, completes independent work, and SKIPS dependents (partial failure)', async () => {
    const script: AgentScript = { calls: [], failOperations: new Set(['retrieve']) };
    const registry = registryWith(script, [
      makeCap('memory', 'retrieve'),
      makeCap('task', 'create'),
      makeCap('knowledge', 'search'),
    ]);
    openaiCreate.mockResolvedValueOnce(
      jsonReply({
        objective: 'partial',
        steps: [
          { stepKey: 'lookup', agent: 'memory', operation: 'retrieve' },
          // independent of lookup → still runs and succeeds
          { stepKey: 'independent', agent: 'knowledge', operation: 'search' },
          // depends on the failing lookup → must be skipped
          { stepKey: 'record', agent: 'task', operation: 'create', dependsOn: ['lookup'] },
        ],
      }),
    );

    const result = await executeObjective(client, USER, 'partial', registry);

    expect(result.status).toBe('partially_failed');
    // The dependent step never ran; the independent one did.
    expect(script.calls.map((c) => c.operation).sort()).toEqual(['retrieve', 'search']);
    const byKey = new Map(result.outcomes.map((o) => [o.stepKey, o]));
    expect(byKey.get('lookup')?.status).toBe('failed');
    expect(byKey.get('independent')?.status).toBe('completed');
    expect(byKey.get('record')?.status).toBe('skipped');
    // Response never claims success for the failed/skipped parts.
    expect(result.response).toContain('Failed');
    expect(result.response).toContain('Skipped');
    expect(result.response).not.toContain('All planned operations completed');
    const steps = await store.listSteps(client, USER, result.runId);
    expect(steps.find((s) => s.step_key === 'record')?.status).toBe('skipped');
  });

  it('a workflow where NOTHING succeeded is reported as failed, not partially failed', async () => {
    const script: AgentScript = { calls: [], failOperations: new Set(['retrieve']) };
    const registry = registryWith(script, [
      makeCap('memory', 'retrieve'),
      makeCap('task', 'create'),
    ]);
    openaiCreate.mockResolvedValueOnce(jsonReply(twoStepPlan()));

    const result = await executeObjective(client, USER, 'x', registry);

    expect(result.status).toBe('failed');
    expect(script.calls.map((c) => c.operation)).toEqual(['retrieve']);
    const byKey = new Map(result.outcomes.map((o) => [o.stepKey, o]));
    expect(byKey.get('lookup')?.status).toBe('failed');
    expect(byKey.get('record')?.status).toBe('skipped');
    // Response never claims success for the failed/skipped parts.
    expect(result.response).toContain('Failed');
    expect(result.response).not.toContain('All planned operations completed');
    const steps = await store.listSteps(client, USER, result.runId);
    expect(steps.find((s) => s.step_key === 'record')?.status).toBe('skipped');
  });

  it('pauses the run at an approval-required step (waiting_approval, no execution)', async () => {
    const script: AgentScript = { calls: [] };
    const registry = registryWith(script, [
      makeCap('memory', 'retrieve'),
      makeCap('task', 'create', { approvalRequired: true }),
    ]);
    openaiCreate.mockResolvedValueOnce(jsonReply(twoStepPlan()));

    const result = await executeObjective(client, USER, 'x', registry);

    expect(result.status).toBe('waiting_approval');
    expect(result.awaitingApproval).toBe(true);
    // First step ran, second paused before execution.
    expect(script.calls.map((c) => c.operation)).toEqual(['retrieve']);
    const run = await store.getRunOrThrow(client, USER, result.runId);
    expect(run.status).toBe('waiting_approval');
    const steps = await store.listSteps(client, USER, result.runId);
    expect(steps.find((s) => s.step_key === 'record')?.status).toBe('waiting_approval');
    expect(result.response).toContain('approval');
  });

  it('a step-level requiresApproval flag in the plan also pauses execution', async () => {
    const script: AgentScript = { calls: [] };
    const registry = registryWith(script, [
      makeCap('memory', 'retrieve'),
      makeCap('task', 'create'),
    ]);
    openaiCreate.mockResolvedValueOnce(jsonReply(twoStepPlan({ requiresApproval: true })));
    const result = await executeObjective(client, USER, 'x', registry);
    expect(result.awaitingApproval).toBe(true);
    expect(script.calls.map((c) => c.operation)).toEqual(['retrieve']);
  });

  it('times out a hung step and reports it honestly', async () => {
    const registry = new AgentRegistry();
    registry.register(
      {
        name: 'memory',
        canHandle: () => Promise.resolve(true),
        execute: () => new Promise(() => {}), // hangs forever
      },
      [makeCap('memory', 'retrieve', { timeoutMs: 1_000 })],
    );
    openaiCreate.mockResolvedValueOnce(
      jsonReply({
        objective: 'hang',
        steps: [{ stepKey: 'slow', agent: 'memory', operation: 'retrieve', timeoutMs: 1_000 }],
      }),
    );
    const result = await executeObjective(client, USER, 'hang', registry, {
      runTimeoutMs: 5_000,
    });
    expect(result.status).toBe('failed');
    const outcome = result.outcomes[0];
    expect(outcome?.status).toBe('failed');
    expect(outcome?.errorCode).toBe('TIMEOUT');
    // The hung step was recorded as failed durably, never as success.
    const steps = await store.listSteps(client, USER, result.runId);
    expect(steps[0]?.status).toBe('failed');
    expect(steps[0]?.error_code).toBe('TIMEOUT');
    expect(result.response).not.toContain('verified');
  });

  it('retries an idempotent step up to its budget, then succeeds', async () => {
    let attempts = 0;
    const registry = new AgentRegistry();
    registry.register(
      {
        name: 'memory',
        canHandle: () => Promise.resolve(true),
        execute: () => {
          attempts += 1;
          if (attempts < 2) {
            return Promise.resolve({
              status: 'failed' as const,
              error: { code: 'EXECUTION_FAILED', message: 'transient' },
            });
          }
          return Promise.resolve({ status: 'ok' as const, summary: 'recovered' });
        },
      },
      [makeCap('memory', 'retrieve', { idempotent: true })],
    );
    openaiCreate.mockResolvedValueOnce(
      jsonReply({
        objective: 'retry',
        steps: [{ stepKey: 'r', agent: 'memory', operation: 'retrieve', maxRetries: 2 }],
      }),
    );
    const result = await executeObjective(client, USER, 'retry', registry);
    expect(result.status).toBe('completed');
    expect(attempts).toBe(2);
    const steps = await store.listSteps(client, USER, result.runId);
    expect(steps[0]?.retry_count).toBe(1);
  });

  it('does NOT retry a non-idempotent step', async () => {
    let attempts = 0;
    const registry = new AgentRegistry();
    registry.register(
      {
        name: 'task',
        canHandle: () => Promise.resolve(true),
        execute: () => {
          attempts += 1;
          return Promise.resolve({
            status: 'failed' as const,
            error: { code: 'EXECUTION_FAILED', message: 'nope' },
          });
        },
      },
      [makeCap('task', 'create', { idempotent: false })],
    );
    openaiCreate.mockResolvedValueOnce(
      jsonReply({
        objective: 'noidem',
        steps: [{ stepKey: 't', agent: 'task', operation: 'create', maxRetries: 2 }],
      }),
    );
    const result = await executeObjective(client, USER, 'noidem', registry);
    expect(result.status).toBe('failed');
    expect(attempts).toBe(1);
  });

  it('cancellation stops remaining steps and finalizes as cancelled', async () => {
    const script: AgentScript = { calls: [], delayMs: 30 };
    const registry = registryWith(script, [
      makeCap('memory', 'retrieve'),
      makeCap('task', 'create'),
    ]);
    const controller = new AbortController();
    openaiCreate.mockResolvedValueOnce(
      jsonReply({
        objective: 'cancel me',
        steps: [
          { stepKey: 'a', agent: 'memory', operation: 'retrieve' },
          { stepKey: 'b', agent: 'memory', operation: 'retrieve', dependsOn: ['a'] },
          { stepKey: 'c', agent: 'task', operation: 'create', dependsOn: ['b'] },
        ],
      }),
    );
    // Abort right after the first batch starts.
    setTimeout(() => controller.abort(), 5);
    const result = await executeObjective(client, USER, 'cancel me', registry, {
      signal: controller.signal,
      runTimeoutMs: 10_000,
    });
    expect(result.status).toBe('cancelled');
    // Step c never executed.
    expect(script.calls.every((c) => c.operation === 'retrieve')).toBe(true);
    const run = await store.getRunOrThrow(client, USER, result.runId);
    expect(run.status).toBe('cancelled');
  });

  it('never reports success before backend verification (persisted status drives response)', async () => {
    const script: AgentScript = { calls: [], failOperations: new Set(['create']) };
    const registry = registryWith(script, [
      makeCap('memory', 'retrieve'),
      makeCap('task', 'create'),
    ]);
    openaiCreate.mockResolvedValueOnce(jsonReply(twoStepPlan()));
    const result = await executeObjective(client, USER, 'x', registry);
    const run = await store.getRunOrThrow(client, USER, result.runId);
    expect(run.status).toBe('partially_failed');
    expect(result.response).not.toContain('All planned operations completed');
  });
});

// ---------------------------------------------------------------------------
// Duplicate prevention + isolation
// ---------------------------------------------------------------------------

describe('orchestrator duplicate prevention and isolation', () => {
  it('a repeated idempotency key returns the SAME run without re-executing steps', async () => {
    const script: AgentScript = { calls: [] };
    const registry = registryWith(script, [
      makeCap('memory', 'retrieve'),
      makeCap('task', 'create'),
    ]);
    openaiCreate.mockResolvedValueOnce(jsonReply(twoStepPlan()));
    const first = await executeObjective(client, USER, 'x', registry, {
      idempotencyKey: 'dup-1',
    });
    const callsAfterFirst = script.calls.length;

    // Second submission: no new planning call, no step re-execution.
    const second = await executeObjective(client, USER, 'x', registry, {
      idempotencyKey: 'dup-1',
    });
    expect(second.runId).toBe(first.runId);
    expect(script.calls.length).toBe(callsAfterFirst);
    expect(openaiCreate).toHaveBeenCalledTimes(1);
    expect(await store.listRuns(client, USER)).toHaveLength(1);
  });

  it('runs are user-scoped: another user cannot read, resume or finalize them', async () => {
    const script: AgentScript = { calls: [] };
    const registry = registryWith(script, [makeCap('memory', 'retrieve')]);
    openaiCreate.mockResolvedValueOnce(
      jsonReply({ objective: 'mine', steps: [{ stepKey: 'a', agent: 'memory', operation: 'retrieve' }] }),
    );
    const result = await executeObjective(client, USER, 'mine', registry);

    const otherClient = fakeCreateUserScopedClient('token-o');
    expect(await store.getRun(otherClient, OTHER, result.runId)).toBeNull();
    expect(await store.listRuns(otherClient, OTHER)).toHaveLength(0);
    expect(await store.listSteps(otherClient, OTHER, result.runId)).toHaveLength(0);
    await expect(
      store.transitionRun(otherClient, OTHER, result.runId, 'completed', 'running'),
    ).rejects.toThrow();
  });
});
