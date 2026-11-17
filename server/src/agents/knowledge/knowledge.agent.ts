/**
 * M6 Phase 5 — Knowledge Agent.
 *
 * Capability-scoped adapter over the EXISTING document services: passage
 * search goes through `searchDocumentChunks` (pgvector RPC, owner-scoped)
 * and listing through `listDocuments`. Model-supplied document ids are
 * ALWAYS verified by `assertSearchableDocumentScope` (owner + ready) before
 * any retrieval — foreign or deleted ids are indistinguishable from missing
 * ones, and a not-yet-ready document is an honest failure, never a silent
 * empty result.
 */

import { documentListQuerySchema, documentSearchSchema } from '../../../../shared/schemas.js';
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
import { listDocuments } from '../../services/documents/document.service.js';
import {
  assertSearchableDocumentScope,
  searchDocumentChunks,
} from '../../services/documents/retrieval.service.js';

// ---------------------------------------------------------------------------
// Input schemas — reuse the API schemas (same validation as REST routes)
// ---------------------------------------------------------------------------

export const knowledgeSearchInput = documentSearchSchema;
export const knowledgeListInput = documentListQuerySchema;

const OPERATIONS: readonly string[] = ['search', 'list'];

/** Default page size when the caller does not specify one. */
const DEFAULT_LIST_LIMIT = 20;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function search(rawArgs: unknown, context: AgentContext): Promise<AgentResult> {
  const parsed = knowledgeSearchInput.safeParse(rawArgs);
  if (!parsed.success) {
    return failedResult(AGENT_ERROR_CODES.INVALID_INPUT, formatZodIssues(parsed.error));
  }
  const { query, document_ids: documentIds, threshold, max_results: maxResults } = parsed.data;

  // Owner + readiness gate for model-supplied ids BEFORE any retrieval.
  if (documentIds && documentIds.length > 0) {
    await assertSearchableDocumentScope(context.client, context.userId, documentIds);
  }

  const embedding = await embed(query, { role: 'query' });
  const hits = await searchDocumentChunks(context.client, context.userId, embedding, {
    documentIds,
    threshold,
    maxResults,
    // Explicit knowledge searches must be honest about an outage instead
    // of silently returning "no results".
    throwOnError: true,
  });

  const documentCount = new Set(hits.map((h) => h.documentId)).size;
  return okResult(
    `Found ${hits.length} ${hits.length === 1 ? 'passage' : 'passages'} in ${documentCount} ${
      documentCount === 1 ? 'document' : 'documents'
    }.`,
    {
      count: hits.length,
      chunks: hits.map((h) => ({
        chunk_id: h.chunkId,
        document_id: h.documentId,
        filename: h.filename,
        similarity: h.similarity,
        page_start: h.pageStart,
        excerpt: h.content.slice(0, 300),
      })),
    },
  );
}

async function list(rawArgs: unknown, context: AgentContext): Promise<AgentResult> {
  const parsed = knowledgeListInput.safeParse(rawArgs);
  if (!parsed.success) {
    return failedResult(AGENT_ERROR_CODES.INVALID_INPUT, formatZodIssues(parsed.error));
  }
  const { q, type, status, limit, offset } = parsed.data;

  const { documents, count } = await listDocuments(context.client, context.userId, {
    q,
    type,
    status,
    limit: limit ?? DEFAULT_LIST_LIMIT,
    offset: offset ?? 0,
  });

  return okResult(`Found ${count} ${count === 1 ? 'document' : 'documents'}.`, {
    count,
    documents: documents.map((d) => ({
      id: d.id,
      filename: d.original_filename,
      type: d.extension,
      status: d.status,
      chunk_count: d.chunk_count,
    })),
  });
}

// ---------------------------------------------------------------------------
// Agent + capability registration metadata
// ---------------------------------------------------------------------------

export const knowledgeAgent: Agent = {
  name: 'knowledge',
  canHandle: (input: AgentInput) => Promise.resolve(OPERATIONS.includes(input.operation)),
  execute: async (input: AgentInput, context: AgentContext): Promise<AgentResult> => {
    if (context.signal?.aborted) return cancelledResult();
    try {
      switch (input.operation) {
        case 'search':
          return await search(input.args, context);
        case 'list':
          return await list(input.args, context);
        default:
          return failedResult(
            AGENT_ERROR_CODES.CAPABILITY_FORBIDDEN,
            `The knowledge agent does not support operation '${input.operation}'.`,
          );
      }
    } catch (err) {
      return fromThrown(err, { context, fallbackMessage: 'The knowledge operation failed.' });
    }
  },
};

export const knowledgeCapabilities: CapabilityDefinition[] = [
  {
    name: 'knowledge.search',
    agent: 'knowledge',
    operations: ['search'],
    permissions: ['documents:read'],
    approvalRequired: false,
    inputSchema: knowledgeSearchInput,
    timeoutMs: 20_000,
    idempotent: true,
    available: true,
  },
  {
    name: 'knowledge.list',
    agent: 'knowledge',
    operations: ['list'],
    permissions: ['documents:read'],
    approvalRequired: false,
    inputSchema: knowledgeListInput,
    timeoutMs: 10_000,
    idempotent: true,
    available: true,
  },
];
