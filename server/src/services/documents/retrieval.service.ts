/**
 * services/documents/retrieval.service.ts
 * --------------------------------------
 * Semantic document retrieval (Milestone 5).
 *
 * Uses the `match_document_chunks` PostgreSQL RPC (not PostgREST filters).
 * Enforces user ownership, ready-only filtering, optional document scoping,
 * similarity threshold, and strict result limits.
 *
 * One query embedding per chat turn is shared with memory retrieval (no
 * second embedding call). The caller passes the pre-computed embedding.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getDocumentsConfig } from '../../config/documents.config.js';

export interface DocumentChunkHit {
  chunkId: string;
  documentId: string;
  userId: string;
  content: string;
  similarity: number;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  heading: string | null;
  sectionPath: string | null;
  charStart: number | null;
  charEnd: number | null;
  filename: string;
}

export interface SearchDocumentChunksOptions {
  /** Restrict to these document IDs (verified owned by caller). */
  documentIds?: string[];
  /** Override similarity threshold (default from config). */
  threshold?: number;
  /** Override result count (default from config). */
  maxResults?: number;
}

/**
 * Search document chunks via the `match_document_chunks` RPC.
 *
 * @param client        User-scoped Supabase client (RLS applies).
 * @param userId        Verified user id.
 * @param queryEmbedding  Pre-computed query embedding (1536-dim).
 * @param options       Optional scoping/threshold/limit.
 */
export async function searchDocumentChunks(
  client: SupabaseClient,
  userId: string,
  queryEmbedding: number[],
  options: SearchDocumentChunksOptions = {},
): Promise<DocumentChunkHit[]> {
  const config = getDocumentsConfig();
  const threshold = options.threshold ?? config.retrievalThreshold;
  const maxResults = options.maxResults ?? config.retrievalTopK;

  const { data, error } = await (client as any).rpc('match_document_chunks', {
    query_embedding: queryEmbedding,
    p_user_id: userId,
    match_threshold: threshold,
    match_count: maxResults,
    p_document_ids: options.documentIds && options.documentIds.length > 0 ? options.documentIds : null,
  });

  if (error) {
    console.warn('[documents.retrieve] match_document_chunks RPC failed:', error.message);
    return [];
  }

  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  return rows.map((r) => ({
    chunkId: String(r.chunk_id ?? ''),
    documentId: String(r.document_id ?? ''),
    userId: String(r.user_id ?? ''),
    content: String(r.content ?? ''),
    similarity: Number(r.similarity ?? 0),
    chunkIndex: Number(r.chunk_index ?? 0),
    pageStart: (r.page_start as number | null) ?? null,
    pageEnd: (r.page_end as number | null) ?? null,
    heading: (r.heading as string | null) ?? null,
    sectionPath: (r.section_path as string | null) ?? null,
    charStart: (r.char_start as number | null) ?? null,
    charEnd: (r.char_end as number | null) ?? null,
    filename: String(r.original_filename ?? ''),
  }));
}