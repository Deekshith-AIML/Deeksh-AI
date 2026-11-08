/**
 * workers/document.worker.ts
 * --------------------------
 * Document processing worker (Milestone 5).
 *
 * Processes one claimed job end-to-end:
 *   1. Load document (must not be deleted/deleting).
 *   2. Download bytes from storage.
 *   3. Extract text (PDF/DOCX/TXT).
 *   4. Chunk (structure-aware).
 *   5. Embed + persist chunks.
 *   6. Mark document ready + update counts.
 *   7. Mark job completed.
 *
 * On transient failure: retry with exponential backoff (bounded attempts).
 * On permanent failure / exhaustion: mark document failed + job failed.
 *
 * SECURITY: worker uses the service-role client (bypasses RLS) because it
 * processes jobs across all users. It never logs document content or paths.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getDocumentsConfig, retryDelayMs } from '../config/documents.config.js';
import { createStorageProvider } from '../services/storage/index.js';
import { extractDocument } from '../services/documents/extraction/index.js';
import { chunkDocument } from '../services/documents/chunking.js';
import { embedAndPersistChunks, deleteDocumentChunks } from '../services/documents/chunk-embedding.service.js';
import type { DocumentRow } from '../services/documents/document.service.js';

export interface ProcessJobResult {
  processed: number;
  failed: number;
}

export interface ProcessJobContext {
  client: SupabaseClient;
  logger?: { info?: Function; warn?: Function; error?: Function };
}

/**
 * Process all currently-claimed jobs (or claim new ones first).
 *
 * The scheduler calls `claim_document_processing_jobs` then passes the
 * claimed rows here. This function is also called directly in tests.
 */
export async function processDocumentJobs(
  ctx: ProcessJobContext,
  jobs: Array<Record<string, unknown>>,
): Promise<ProcessJobResult> {
  const config = getDocumentsConfig();
  const storage = createStorageProvider(ctx.client);
  let processed = 0;
  let failed = 0;

  for (const job of jobs) {
    const jobId = String(job.id);
    const documentId = String(job.document_id);
    const userId = String(job.user_id);

    try {
      // Load document.
      const { data: doc, error: docErr } = await ctx.client
        .from('documents')
        .select('*')
        .eq('id', documentId)
        .eq('user_id', userId)
        .maybeSingle();

      if (docErr || !doc) {
        throw new Error('DOCUMENT_NOT_FOUND');
      }

      const document = doc as unknown as DocumentRow;

      // Skip if already deleted/deleting.
      if (document.status === 'deleted' || document.status === 'deleting') {
        await ctx.client
          .from('document_processing_jobs')
          .update({ status: 'completed', error_message: 'SKIPPED_DELETED' })
          .eq('id', jobId);
        processed++;
        continue;
      }

      // Mark processing.
      await ctx.client
        .from('documents')
        .update({ status: 'processing', processing_started_at: new Date().toISOString() })
        .eq('id', documentId)
        .eq('user_id', userId);

      // Download bytes.
      const bytes = await storage.get(document.storage_path);

      // Extract.
      const extension = document.extension as 'pdf' | 'docx' | 'txt';
      const extraction = await extractDocument(bytes, extension, config);

      if (!extraction.hasExtractableText) {
        if (extension === 'pdf' && extraction.metadata.scanned) {
          throw new Error('SCANNED_PDF_REQUIRES_OCR');
        }
        throw new Error('NO_EXTRACTABLE_TEXT');
      }

      // Chunk.
      const { chunks } = chunkDocument(documentId, userId, extraction, config);

      if (chunks.length === 0) {
        throw new Error('NO_CHUNKS_PRODUCED');
      }

      // Embed + persist.
      await embedAndPersistChunks(ctx.client, documentId, userId, chunks, config);

      // Mark ready.
      await ctx.client
        .from('documents')
        .update({
          status: 'ready',
          page_count: extraction.totalPages,
          text_char_count: extraction.totalText.length,
          chunk_count: chunks.length,
          extraction_metadata: extraction.metadata,
          processing_completed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('id', documentId)
        .eq('user_id', userId);

      // Mark job completed.
      await ctx.client
        .from('document_processing_jobs')
        .update({ status: 'completed', error_message: null })
        .eq('id', jobId);

      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isPermanent = isPermanentError(message);

      // Determine retry.
      const attempts = Number(job.attempts ?? 1);
      const maxAttempts = Number(job.max_attempts ?? 3);

      if (!isPermanent && attempts < maxAttempts) {
        // Schedule retry with exponential backoff.
        const delay = retryDelayMs(attempts, config.retryBaseDelayMs);
        const nextAttempt = new Date(Date.now() + delay).toISOString();

        await ctx.client
          .from('document_processing_jobs')
          .update({
            status: 'pending',
            next_attempt_at: nextAttempt,
            error_message: message,
          })
          .eq('id', jobId);

        await ctx.client
          .from('documents')
          .update({ status: 'pending', error_message: message })
          .eq('id', documentId)
          .eq('user_id', userId);
      } else {
        // Permanent failure or exhausted retries.
        await ctx.client
          .from('document_processing_jobs')
          .update({
            status: 'failed',
            failed_at: new Date().toISOString(),
            error_message: message,
          })
          .eq('id', jobId);

        await ctx.client
          .from('documents')
          .update({ status: 'failed', error_message: message })
          .eq('id', documentId)
          .eq('user_id', userId);

        // Clean up partial chunks.
        try {
          await deleteDocumentChunks(ctx.client, documentId, userId);
        } catch {
          // Best effort.
        }
      }

      failed++;
      ctx.logger?.error?.(`[document.worker] Job ${jobId} failed: ${message}`);
    }
  }

  return { processed, failed };
}

function isPermanentError(message: string): boolean {
  const permanent = [
    'SCANNED_PDF_REQUIRES_OCR',
    'NO_EXTRACTABLE_TEXT',
    'NO_CHUNKS_PRODUCED',
    'AUTH',
    'DIM_MISMATCH',
    'SPACE_MISMATCH',
    'INVALID_REQUEST',
    'UNSUPPORTED_EXTENSION',
  ];
  return permanent.some((code) => message.includes(code));
}

/**
 * Deletion sweeper: process all documents with status='deleting'.
 */
export async function sweepDeletingDocuments(ctx: ProcessJobContext): Promise<number> {
  const storage = createStorageProvider(ctx.client);
  const { data: docs, error } = await ctx.client
    .from('documents')
    .select('*')
    .eq('status', 'deleting');

  if (error || !docs) return 0;

  let swept = 0;
  for (const doc of docs as Array<Record<string, unknown>>) {
    const documentId = String(doc.id);
    const userId = String(doc.user_id);
    const storagePath = String(doc.storage_path);

    try {
      // Delete chunks (if any remain).
      await deleteDocumentChunks(ctx.client, documentId, userId);

      // Delete storage object.
      try {
        await storage.remove(storagePath);
      } catch {
        // Object may already be gone; continue.
      }

      // Mark deleted.
      await ctx.client
        .from('documents')
        .update({ status: 'deleted', deletion_error: null, chunk_count: 0 })
        .eq('id', documentId)
        .eq('user_id', userId);

      swept++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.client
        .from('documents')
        .update({
          deletion_attempts: Number(doc.deletion_attempts ?? 0) + 1,
          deletion_error: message,
        })
        .eq('id', documentId)
        .eq('user_id', userId);
    }
  }

  return swept;
}