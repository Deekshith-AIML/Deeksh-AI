/**
 * services/documents/chunk-embedding.service.ts
 * --------------------------------------------
 * Embedding generation and persistence for document chunks (Milestone 5).
 *
 * Uses the existing embedding service (`embed()` with `role: 'document'`)
 * and the 1536-dim Gemini Embedding 2 space. Never mixes with Ollama 768-dim.
 *
 * Every chunk is embedded with the active provider/model/dimension metadata.
 * On failure, the chunk's embedding stays NULL and the job is retried.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { embed, getActiveSpace, assertStorableInIndex } from '../embedding.service.js';
import type { DocumentsConfig } from '../../config/documents.config.js';
import type { ChunkProvenance } from './chunking.js';

export interface PersistedChunk {
  id: string;
  document_id: string;
  user_id: string;
  chunk_index: number;
  content: string;
  embedding: number[] | null;
  embedding_provider: string;
  embedding_model_version: string;
  embedding_dimensions: number;
  page_start: number | null;
  page_end: number | null;
  heading: string | null;
  section_path: string | null;
  paragraph_start: number;
  paragraph_end: number;
  char_start: number;
  char_end: number;
  token_estimate: number;
}

/**
 * Embed and persist a batch of chunks for a document.
 *
 * @param client   User-scoped or admin Supabase client.
 * @param documentId  The document's UUID.
 * @param userId      The owning user's UUID.
 * @param chunks      Provenance-aware chunks from the chunking stage.
 * @param config      Document configuration (concurrency, retry).
 * @returns Array of persisted chunk rows (with embeddings).
 */
export async function embedAndPersistChunks(
  client: SupabaseClient,
  documentId: string,
  userId: string,
  chunks: ChunkProvenance[],
  config: DocumentsConfig,
): Promise<PersistedChunk[]> {
  const activeSpace = getActiveSpace();
  const concurrency = Math.min(config.embedConcurrency, 10);

  // Delete existing chunks for this document (idempotent re-processing).
  const { error: deleteError } = await client
    .from('document_chunks')
    .delete()
    .eq('document_id', documentId)
    .eq('user_id', userId);

  if (deleteError) {
    throw new Error(`Failed to clear old chunks: ${deleteError.message}`);
  }

  // Embed chunks with bounded concurrency.
  const embeddings: (number[] | null)[] = new Array(chunks.length).fill(null);
  const errors: (Error | null)[] = new Array(chunks.length).fill(null);

  let cursor = 0;
  async function worker() {
    while (cursor < chunks.length) {
      const idx = cursor++;
      const chunk = chunks[idx]!;
      try {
        const embedding = await embed(chunk.content, { role: 'document' });
        assertStorableInIndex(
          { vector: embedding, provider: activeSpace.provider, model: activeSpace.model, dimension: embedding.length },
          activeSpace,
        );
        embeddings[idx] = embedding;
      } catch (err) {
        errors[idx] = err as Error;
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  // Check for any permanent failures.
  const firstError = errors.find((e) => e !== null);
  if (firstError) {
    throw firstError;
  }

  // Build rows.
  const rows = chunks.map((chunk, idx) => ({
    document_id: documentId,
    user_id: userId,
    chunk_index: chunk.chunkIndex,
    content: chunk.content,
    embedding: embeddings[idx],
    embedding_provider: activeSpace.provider,
    embedding_model_version: activeSpace.model,
    embedding_dimensions: embeddings[idx]!.length,
    page_start: chunk.pageStart,
    page_end: chunk.pageEnd,
    heading: chunk.heading,
    section_path: chunk.sectionPath,
    paragraph_start: chunk.paragraphStart,
    paragraph_end: chunk.paragraphEnd,
    char_start: chunk.charStart,
    char_end: chunk.charEnd,
    token_estimate: chunk.tokenEstimate,
  }));

  // Insert all rows.
  const { data, error } = await client
    .from('document_chunks')
    .insert(rows)
    .select();

  if (error) {
    throw new Error(`Failed to persist chunks: ${error.message}`);
  }

  return (data ?? []) as unknown as PersistedChunk[];
}

/**
 * Delete all chunks for a document (used during re-processing and deletion).
 */
export async function deleteDocumentChunks(
  client: SupabaseClient,
  documentId: string,
  userId: string,
): Promise<void> {
  const { error } = await client
    .from('document_chunks')
    .delete()
    .eq('document_id', documentId)
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to delete chunks: ${error.message}`);
  }
}