/**
 * M6 Phase 5 — Memory Agent.
 *
 * Capability-scoped adapter over the EXISTING memory service: retrieval and
 * saving go through `retrieveMemories` / `createMemory`, which enforce
 * ownership (RLS + explicit filters), conflict detection, credential
 * rejection and embedding invariants. This module adds NO business logic —
 * it validates input (same Zod schemas as the chat tools), calls the
 * service with the authenticated owner, and maps the outcome.
 */

import { z } from 'zod';
import { memoryCategorySchema, saveMemoryToolArgsSchema } from '../../../../shared/schemas.js';
import type { CapabilityDefinition } from '../registry/agent.registry.js';
import {
  AGENT_ERROR_CODES,
  cancelledResult,
  failedResult,
  formatZodIssues,
  fromThrown,
  okResult,
} from '../shared/index.js';
import type { Agent, AgentContext, AgentInput, AgentResult } from '../shared/index.js';
import { embed } from '../../services/embedding.service.js';
import { createMemory, retrieveMemories } from '../../services/memory.service.js';

// ---------------------------------------------------------------------------
// Input schemas (the SAME shape the registry validates before dispatch)
// ---------------------------------------------------------------------------

/**
 * Semantic memory retrieval. The embedding is always server-generated from
 * the query text — a model can never supply its own vector.
 */
export const memoryRetrieveInput = z.object({
  query: z
    .string()
    .trim()
    .min(1, 'query must be at least 1 character')
    .max(2000, 'query must be at most 2000 characters'),
  category: memoryCategorySchema.optional(),
  max_results: z.number().int().min(1).max(20).default(6),
  threshold: z.number().min(0).max(1).optional(),
});

/**
 * Saving a memory: reuses the `save_memory` tool schema verbatim (unknown
 * keys are stripped, so an injected `user_id` can never reach the service).
 */
export const memoryCreateInput = saveMemoryToolArgsSchema;

const OPERATIONS: readonly string[] = ['retrieve', 'create'];

// ---------------------------------------------------------------------------
// Operations — thin wrappers over the existing memory service
// ---------------------------------------------------------------------------

async function retrieve(rawArgs: unknown, context: AgentContext): Promise<AgentResult> {
  const parsed = memoryRetrieveInput.safeParse(rawArgs);
  if (!parsed.success) {
    return failedResult(AGENT_ERROR_CODES.INVALID_INPUT, formatZodIssues(parsed.error));
  }
  const { query, category, max_results: maxResults, threshold } = parsed.data;

  const embedding = await embed(query, { role: 'query' });
  const { memories, count } = await retrieveMemories(context.client, context.userId, embedding, {
    threshold,
    maxResults,
    category,
    queryText: query,
  });

  return okResult(`Retrieved ${count} ${count === 1 ? 'memory' : 'memories'}.`, {
    count,
    memories: memories.map((m) => ({
      id: m.id,
      category: m.category,
      similarity: m.similarity,
      excerpt: m.content.slice(0, 200),
    })),
  });
}

async function create(rawArgs: unknown, context: AgentContext): Promise<AgentResult> {
  const parsed = memoryCreateInput.safeParse(rawArgs);
  if (!parsed.success) {
    return failedResult(AGENT_ERROR_CODES.INVALID_INPUT, formatZodIssues(parsed.error));
  }
  const { content, category, evidence } = parsed.data;

  // Same parameter policy as the existing save_memory tool: the USER asked
  // for this memory explicitly, so confidence is high (→ active status).
  const { memory, created } = await createMemory(context.client, context.userId, {
    content,
    category,
    evidence,
    confidence: 'high',
  });

  return okResult(
    created
      ? `Saved memory: ${content.slice(0, 120)}`
      : 'A matching memory already exists — nothing was duplicated.',
    {
      memory_id: memory.id,
      category: memory.category,
      status: memory.status,
      created,
    },
  );
}

// ---------------------------------------------------------------------------
// Agent + capability registration metadata
// ---------------------------------------------------------------------------

export const memoryAgent: Agent = {
  name: 'memory',
  canHandle: (input: AgentInput) => Promise.resolve(OPERATIONS.includes(input.operation)),
  execute: async (input: AgentInput, context: AgentContext): Promise<AgentResult> => {
    if (context.signal?.aborted) return cancelledResult();
    try {
      switch (input.operation) {
        case 'retrieve':
          return await retrieve(input.args, context);
        case 'create':
          return await create(input.args, context);
        default:
          return failedResult(
            AGENT_ERROR_CODES.CAPABILITY_FORBIDDEN,
            `The memory agent does not support operation '${input.operation}'.`,
          );
      }
    } catch (err) {
      return fromThrown(err, { context, fallbackMessage: 'The memory operation failed.' });
    }
  },
};

export const memoryCapabilities: CapabilityDefinition[] = [
  {
    name: 'memory.retrieve',
    agent: 'memory',
    operations: ['retrieve'],
    permissions: ['memory:read'],
    approvalRequired: false,
    inputSchema: memoryRetrieveInput,
    timeoutMs: 15_000,
    idempotent: true,
    available: true,
  },
  {
    name: 'memory.create',
    agent: 'memory',
    operations: ['create'],
    permissions: ['memory:write'],
    approvalRequired: false,
    inputSchema: memoryCreateInput,
    timeoutMs: 15_000,
    idempotent: false,
    available: true,
  },
];
