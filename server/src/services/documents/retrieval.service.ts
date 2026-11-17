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
import { DocumentError } from './errors.js';

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
  /**
   * When true, an RPC failure throws a typed DocumentError instead of
   * returning an empty list. Explicit Knowledge Base search must be honest
   * about a database outage; chat retrieval stays non-fatal.
   */
  throwOnError?: boolean;
}

export interface ChunkParagraphRange {
  paragraphStart: number | null;
  paragraphEnd: number | null;
}

/**
 * Load paragraph provenance for already-authorized chunk ids.
 *
 * `match_document_chunks` returns page/section/char offsets but not the
 * chunk table's paragraph range. This bounded metadata lookup fills that gap
 * without duplicating vector SQL or changing the database function.
 * Failures degrade to "no paragraph range" rather than failing the search.
 */
export async function loadChunkParagraphRanges(
  client: SupabaseClient,
  userId: string,
  chunkIds: string[],
): Promise<Map<string, ChunkParagraphRange>> {
  const ranges = new Map<string, ChunkParagraphRange>();
  if (chunkIds.length === 0) return ranges;

  const uniqueIds = Array.from(new Set(chunkIds)).slice(0, 50);
  const { data, error } = await client
    .from('document_chunks')
    .select('id,paragraph_start,paragraph_end')
    .eq('user_id', userId)
    .in('id', uniqueIds);

  if (error) {
    console.warn(
      '[documents.retrieve] paragraph provenance lookup failed:',
      error.message,
    );
    return ranges;
  }

  for (const row of Array.isArray(data) ? data : []) {
    ranges.set(String(row.id ?? ''), {
      paragraphStart: (row.paragraph_start as number | null) ?? null,
      paragraphEnd: (row.paragraph_end as number | null) ?? null,
    });
  }
  return ranges;
}

const DELETED_STATUSES = new Set(['deleting', 'deleted']);

/**
 * Verify that every explicitly selected document belongs to the caller and
 * is ready for retrieval.
 *
 * Missing and foreign ids deliberately produce the same 404 so the endpoint
 * cannot be used to probe another user's document ids.
 */
export async function assertSearchableDocumentScope(
  client: SupabaseClient,
  userId: string,
  documentIds: string[],
): Promise<void> {
  if (documentIds.length === 0) return;

  const uniqueIds = Array.from(new Set(documentIds));
  const { data, error } = await client
    .from('documents')
    .select('id,status')
    .eq('user_id', userId)
    .in('id', uniqueIds);

  if (error) {
    throw new DocumentError(
      'The selected search scope could not be verified.',
      'DOCUMENT_SEARCH_SCOPE_UNAVAILABLE',
      503,
    );
  }

  const rows = Array.isArray(data)
    ? (data as Array<Record<string, unknown>>)
    : [];
  const statusById = new Map<string, string>();
  for (const row of rows) {
    statusById.set(String(row.id ?? ''), String(row.status ?? ''));
  }

  const missing = uniqueIds.filter((id) => !statusById.has(id));
  const deleted = uniqueIds.filter((id) => {
    const status = statusById.get(id);
    return status !== undefined && DELETED_STATUSES.has(status);
  });
  if (missing.length > 0 || deleted.length > 0) {
    throw new DocumentError('Document not found.', 'DOCUMENT_NOT_FOUND', 404);
  }

  const notReady = uniqueIds.filter((id) => statusById.get(id) !== 'ready');
  if (notReady.length > 0) {
    throw new DocumentError(
      'One or more selected documents are not ready for search yet.',
      'DOCUMENT_NOT_SEARCHABLE',
      409,
      { document_ids: notReady },
    );
  }
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
  const maxResults = Math.min(Math.max(options.maxResults ?? config.retrievalTopK, 1), 50);

  const { data, error } = await (client as any).rpc('match_document_chunks', {
    query_embedding: queryEmbedding,
    p_user_id: userId,
    match_threshold: threshold,
    match_count: maxResults,
    p_document_ids: options.documentIds && options.documentIds.length > 0 ? options.documentIds : null,
  });

  if (error) {
    console.warn('[documents.retrieve] match_document_chunks RPC failed:', error.message);
    if (options.throwOnError) {
      throw new DocumentError(
        'Search is temporarily unavailable. Please try again.',
        'DOCUMENT_SEARCH_UNAVAILABLE',
        503,
      );
    }
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