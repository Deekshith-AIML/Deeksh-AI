/**
 * services/documents/document.service.ts
 * --------------------------------------
 * Document metadata, upload persistence and lifecycle (Milestone 5).
 *
 * RESPONSIBILITIES
 * - validate uploaded bytes (validation.ts) before anything is stored;
 * - write the binary to the configured StorageProvider under a server-
 *   generated path (`{userId}/{documentId}/{uuid}.{ext}`);
 * - persist metadata + a durable processing job row;
 * - list / read / rename / retry / delete documents.
 *
 * SECURITY
 * - `userId` always comes from the verified bearer token (getAuth), never
 *   from a request body. Every query also filters `.eq('user_id', userId)`
 *   on top of RLS.
 * - storage paths are never accepted from clients and never returned by the
 *   API (`KnowledgeDocument` omits them).
 * - document text is not touched here; extraction happens in the worker.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  DocumentChunkPreview,
  DocumentDetailsResponse,
  DocumentExtension,
  DocumentExtractionMetadata,
  DocumentJobInfo,
  DocumentMimeType,
  DocumentStatus,
  DocumentViewResponse,
  KnowledgeDocument,
} from '../../../../shared/types.js';
import { getDocumentsConfig } from '../../config/documents.config.js';
import type { StorageProvider } from '../storage/index.js';
import { StorageError } from '../storage/index.js';
import { DocumentError } from './errors.js';
import { normalizeFilename, validateUpload, withExtension } from './validation.js';

/** Statuses that count as "live" for duplicate detection. */
const LIVE_STATUSES = ['uploaded', 'pending', 'processing', 'ready', 'failed'] as const;

/** Server-side row shape (never sent to clients as-is). */
export interface DocumentRow {
  id: string;
  user_id: string;
  original_filename: string;
  storage_filename: string;
  extension: DocumentExtension;
  mime_type: DocumentMimeType;
  file_size: number | string;
  content_hash: string;
  storage_path: string;
  status: DocumentStatus;
  page_count: number | null;
  text_char_count: number | null;
  chunk_count: number | string;
  extraction_metadata: DocumentExtractionMetadata | null;
  error_message: string | null;
  deletion_attempts: number | string;
  deletion_error: string | null;
  processing_started_at: string | null;
  processing_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DbResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

function dbError(message: string): DocumentError {
  return new DocumentError(message, 'DATABASE_ERROR', 500);
}

/** Map a database row to the client-facing shape (no storage paths). */
export function toPublicDocument(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id,
    original_filename: row.original_filename,
    extension: row.extension,
    mime_type: row.mime_type,
    file_size: Number(row.file_size),
    content_hash: row.content_hash,
    status: row.status,
    page_count: row.page_count ?? null,
    text_char_count: row.text_char_count ?? null,
    chunk_count: Number(row.chunk_count ?? 0),
    extraction_metadata: row.extraction_metadata ?? {},
    error_message: row.error_message ?? null,
    processing_started_at: row.processing_started_at ?? null,
    processing_completed_at: row.processing_completed_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toJobInfo(row: Record<string, unknown> | null): DocumentJobInfo | null {
  if (!row) return null;
  return {
    status: row.status as DocumentJobInfo['status'],
    attempts: Number(row.attempts ?? 0),
    max_attempts: Number(row.max_attempts ?? 3),
    next_attempt_at: String(row.next_attempt_at ?? ''),
    failed_at: (row.failed_at as string | null) ?? null,
    error_message: (row.error_message as string | null) ?? null,
  };
}

/**
 * Load a document owned by `userId`.
 *
 * A missing row and a foreign row are intentionally indistinguishable (404),
 * so the API never reveals that another user's document id exists.
 */
export async function getOwnedRow(
  client: SupabaseClient,
  userId: string,
  documentId: string,
): Promise<DocumentRow> {
  const { data, error } = await client
    .from('documents')
    .select('*')
    .eq('id', documentId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw dbError('Document could not be loaded.');
  if (!data) {
    throw new DocumentError('Document not found.', 'DOCUMENT_NOT_FOUND', 404);
  }
  return data as unknown as DocumentRow;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface CreateDocumentInput {
  bytes: Buffer;
  originalFilename: string;
}

/**
 * Validate, store and register one upload.
 *
 * Ordering matters: validate -> dedupe -> store object -> insert metadata ->
 * insert job -> mark pending. Any failure after the object write cleans up
 * the object (and the metadata row if it was created) before rethrowing, so
 * no silent orphans are left behind.
 */
export async function createDocument(
  client: SupabaseClient,
  userId: string,
  input: CreateDocumentInput,
  storage: StorageProvider,
): Promise<KnowledgeDocument> {
  const config = getDocumentsConfig();
  const validated = await validateUpload(input.bytes, input.originalFilename, config);

  const contentHash = createHash('sha256').update(input.bytes).digest('hex');

  const existing = await client
    .from('documents')
    .select('id')
    .eq('user_id', userId)
    .eq('content_hash', contentHash)
    .in('status', [...LIVE_STATUSES])
    .maybeSingle();

  if (existing.error) throw dbError('Duplicate check failed.');
  if (existing.data) {
    throw new DocumentError(
      'A document with identical content already exists.',
      'DUPLICATE_DOCUMENT',
      409,
      { existing_document_id: (existing.data as { id: string }).id },
    );
  }

  const documentId = randomUUID();
  const storageFilename = `${randomUUID()}.${validated.extension}`;
  const storagePath = `${userId}/${documentId}/${storageFilename}`;

  try {
    await storage.put(storagePath, input.bytes, validated.mimeType);
  } catch (err) {
    if (err instanceof StorageError) {
      throw new DocumentError(
        'The document could not be stored. Please try again.',
        'STORAGE_WRITE_FAILED',
        502,
      );
    }
    throw err;
  }

  const inserted = await client
    .from('documents')
    .insert({
      id: documentId,
      user_id: userId,
      original_filename: validated.normalizedFilename,
      storage_filename: storageFilename,
      extension: validated.extension,
      mime_type: validated.mimeType,
      file_size: input.bytes.length,
      content_hash: contentHash,
      storage_path: storagePath,
      status: 'uploaded',
      extraction_metadata: validated.encoding ? { encoding: validated.encoding } : {},
    })
    .select()
    .single();

  if (inserted.error || !inserted.data) {
    await safeRemove(storage, storagePath);
    // A concurrent identical upload won the unique index: report it as a
    // duplicate rather than as an internal error.
    if (inserted.error?.code === '23505') {
      throw new DocumentError(
        'A document with identical content already exists.',
        'DUPLICATE_DOCUMENT',
        409,
      );
    }
    throw dbError('Document metadata could not be saved.');
  }

  const jobInsert = await client.from('document_processing_jobs').insert({
    document_id: documentId,
    user_id: userId,
    status: 'pending',
    attempts: 0,
    next_attempt_at: new Date().toISOString(),
  });

  if (jobInsert.error) {
    // Roll back the metadata row and the object: the upload is not usable
    // without a job, and a half-registered document is worse than none.
    await client.from('documents').delete().eq('id', documentId).eq('user_id', userId);
    await safeRemove(storage, storagePath);
    throw dbError('Document processing could not be scheduled.');
  }

  const marked = await client
    .from('documents')
    .update({ status: 'pending' })
    .eq('id', documentId)
    .eq('user_id', userId)
    .select()
    .single();

  if (marked.error || !marked.data) {
    throw dbError('Document could not be queued.');
  }

  return toPublicDocument(marked.data as unknown as DocumentRow);
}

async function safeRemove(storage: StorageProvider, path: string): Promise<void> {
  try {
    await storage.remove(path);
  } catch {
    // Best effort: the metadata rows are the source of truth and the worker
    // sweeper is the safety net for orphaned objects.
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ListDocumentsOptions {
  q?: string;
  type?: DocumentExtension;
  status?: DocumentStatus;
  limit?: number;
  offset?: number;
}

export async function listDocuments(
  client: SupabaseClient,
  userId: string,
  options: ListDocumentsOptions = {},
): Promise<{ documents: KnowledgeDocument[]; count: number }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  let builder = client.from('documents').select('*').eq('user_id', userId);
  if (options.type) builder = builder.eq('extension', options.type);
  if (options.status) builder = builder.eq('status', options.status);
  if (options.q?.trim()) builder = builder.ilike('original_filename', `%${options.q.trim()}%`);

  const { data, error } = await builder
    .order('created_at', { ascending: false })
    .limit(limit);
  // PostgREST offset is applied client-side of the range; the fake supports
  // limit only, so slice here for both.
  const rows = (data ?? []) as unknown as DocumentRow[];
  const page = rows.slice(offset, offset + limit);
  if (error) throw dbError('Documents could not be listed.');

  return { documents: page.map(toPublicDocument), count: page.length };
}

export async function getDocumentDetails(
  client: SupabaseClient,
  userId: string,
  documentId: string,
): Promise<DocumentDetailsResponse> {
  const row = await getOwnedRow(client, userId, documentId);

  const { data: job, error } = await client
    .from('document_processing_jobs')
    .select('*')
    .eq('document_id', documentId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw dbError('Document job state could not be read.');

  return {
    document: toPublicDocument(row),
    job: toJobInfo(job as Record<string, unknown> | null),
  };
}

export async function listDocumentChunks(
  client: SupabaseClient,
  userId: string,
  documentId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ chunks: DocumentChunkPreview[]; count: number }> {
  await getOwnedRow(client, userId, documentId);

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const { data, error } = await client
    .from('document_chunks')
    .select(
      'id, chunk_index, page_start, page_end, heading, section_path, paragraph_start, paragraph_end, char_start, char_end, token_estimate, content',
    )
    .eq('document_id', documentId)
    .eq('user_id', userId)
    .order('chunk_index', { ascending: true })
    .limit(offset + limit);

  if (error) throw dbError('Document chunks could not be listed.');

  const rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).slice(
    offset,
    offset + limit,
  );

  return {
    chunks: rows.map((r) => ({
      id: String(r.id),
      chunk_index: Number(r.chunk_index ?? 0),
      page_start: (r.page_start as number | null) ?? null,
      page_end: (r.page_end as number | null) ?? null,
      heading: (r.heading as string | null) ?? null,
      section_path: (r.section_path as string | null) ?? null,
      paragraph_start: (r.paragraph_start as number | null) ?? null,
      paragraph_end: (r.paragraph_end as number | null) ?? null,
      char_start: (r.char_start as number | null) ?? null,
      char_end: (r.char_end as number | null) ?? null,
      token_estimate: (r.token_estimate as number | null) ?? null,
      preview: String(r.content ?? '').slice(0, 300),
    })),
    count: rows.length,
  };
}

// ---------------------------------------------------------------------------
// Update / retry
// ---------------------------------------------------------------------------

export async function renameDocument(
  client: SupabaseClient,
  userId: string,
  documentId: string,
  newName: string,
): Promise<KnowledgeDocument> {
  const row = await getOwnedRow(client, userId, documentId);
  if (row.status === 'deleted' || row.status === 'deleting') {
    throw new DocumentError('Document is being deleted.', 'DOCUMENT_NOT_FOUND', 404);
  }

  const normalized = withExtension(normalizeFilename(newName), row.extension);
  const { data, error } = await client
    .from('documents')
    .update({ original_filename: normalized })
    .eq('id', documentId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error || !data) throw dbError('Document could not be renamed.');
  return toPublicDocument(data as unknown as DocumentRow);
}

/**
 * Re-enqueue a failed document.
 *
 * Only `failed` documents are retryable; ready documents must be deleted and
 * re-uploaded so a working document is never silently re-processed. Stale
 * partial chunks from the failed attempt are removed first, and the existing
 * failed job row is reset (no duplicate active jobs).
 */
export async function retryDocument(
  client: SupabaseClient,
  userId: string,
  documentId: string,
): Promise<KnowledgeDocument> {
  const row = await getOwnedRow(client, userId, documentId);

  if (row.status === 'deleting' || row.status === 'deleted') {
    throw new DocumentError('Document is being deleted.', 'DOCUMENT_NOT_FOUND', 404);
  }
  if (row.status !== 'failed') {
    throw new DocumentError(
      'Only failed documents can be retried.',
      'INVALID_DOCUMENT_STATE',
      409,
    );
  }

  const chunkDelete = await client
    .from('document_chunks')
    .delete()
    .eq('document_id', documentId)
    .eq('user_id', userId);
  if (chunkDelete.error) throw dbError('Partial chunks could not be cleared.');

  const nowIso = new Date().toISOString();
  const jobUpdate = await client
    .from('document_processing_jobs')
    .update({
      status: 'pending',
      attempts: 0,
      claimed_at: null,
      next_attempt_at: nowIso,
      failed_at: null,
      error_message: null,
    })
    .eq('document_id', documentId)
    .eq('user_id', userId)
    .eq('status', 'failed');

  if (jobUpdate.error) throw dbError('Processing job could not be requeued.');

  const { data: jobCheck } = await client
    .from('document_processing_jobs')
    .select('id, status')
    .eq('document_id', documentId)
    .eq('user_id', userId)
    .in('status', ['pending', 'claimed'])
    .maybeSingle();

  if (!jobCheck) {
    const jobInsert = await client.from('document_processing_jobs').insert({
      document_id: documentId,
      user_id: userId,
      status: 'pending',
      attempts: 0,
      next_attempt_at: nowIso,
    });
    if (jobInsert.error) throw dbError('Processing job could not be requeued.');
  }

  const { data, error } = await client
    .from('documents')
    .update({
      status: 'pending',
      error_message: null,
      chunk_count: 0,
      processing_started_at: null,
      processing_completed_at: null,
    })
    .eq('id', documentId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error || !data) throw dbError('Document could not be requeued.');
  return toPublicDocument(data as unknown as DocumentRow);
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/**
 * Begin deletion: mark `deleting` FIRST (which immediately removes the
 * document from retrieval, because `match_document_chunks` only returns
 * `ready` rows), then delete chunks, then the stored object, then mark
 * `deleted`.
 *
 * The metadata row is retained as an audit trail (approved retention
 * policy); the unique hash index excludes deleted rows, so the same content
 * can be uploaded again later. A storage failure leaves the document in
 * `deleting` with counters incremented, and the worker sweeper retries it.
 */
export async function deleteDocument(
  client: SupabaseClient,
  userId: string,
  documentId: string,
  storage: StorageProvider,
): Promise<KnowledgeDocument> {
  const row = await getOwnedRow(client, userId, documentId);

  if (row.status === 'deleted') {
    return toPublicDocument(row);
  }

  const marked = await client
    .from('documents')
    .update({ status: 'deleting' })
    .eq('id', documentId)
    .eq('user_id', userId)
    .select()
    .single();
  if (marked.error || !marked.data) throw dbError('Document could not be marked for deletion.');

  // Remove queue rows and chunks before the object: retrieval and the worker
  // must never see a half-deleted document.
  const jobDelete = await client
    .from('document_processing_jobs')
    .delete()
    .eq('document_id', documentId)
    .eq('user_id', userId);
  if (jobDelete.error) throw dbError('Document jobs could not be removed.');

  const chunkDelete = await client
    .from('document_chunks')
    .delete()
    .eq('document_id', documentId)
    .eq('user_id', userId);
  if (chunkDelete.error) throw dbError('Document chunks could not be removed.');

  let storageFailed = false;
  try {
    await storage.remove(row.storage_path);
  } catch {
    storageFailed = true;
  }

  if (storageFailed) {
    const { data } = await client
      .from('documents')
      .update({
        deletion_attempts: Number(row.deletion_attempts ?? 0) + 1,
        deletion_error: 'STORAGE_DELETE_FAILED',
        chunk_count: 0,
      })
      .eq('id', documentId)
      .eq('user_id', userId)
      .select()
      .single();
    return toPublicDocument((data ?? marked.data) as unknown as DocumentRow);
  }

  const { data, error } = await client
    .from('documents')
    .update({
      status: 'deleted',
      deletion_error: null,
      chunk_count: 0,
    })
    .eq('id', documentId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error || !data) throw dbError('Document could not be finalized.');
  return toPublicDocument(data as unknown as DocumentRow);
}

// ---------------------------------------------------------------------------
// Viewing
// ---------------------------------------------------------------------------

/** Short-lived viewing link (or the authenticated local content route). */
export async function getDocumentViewLink(
  client: SupabaseClient,
  userId: string,
  documentId: string,
  storage: StorageProvider,
): Promise<DocumentViewResponse> {
  const row = await getOwnedRow(client, userId, documentId);

  if (row.status === 'deleting' || row.status === 'deleted') {
    throw new DocumentError('Document not found.', 'DOCUMENT_NOT_FOUND', 404);
  }
  if (row.status !== 'ready' && row.status !== 'uploaded') {
    throw new DocumentError(
      'This document is not ready to view yet.',
      'DOCUMENT_NOT_VIEWABLE',
      409,
    );
  }

  const signed = await storage.signedUrl(row.storage_path, 120);
  if (signed) {
    return {
      url: signed,
      extension: row.extension,
      page_count: row.page_count ?? null,
      expires_in: 120,
    };
  }

  // Local adapter: streamed by the API after the same auth checks.
  return {
    url: `/api/documents/${documentId}/content`,
    extension: row.extension,
    page_count: row.page_count ?? null,
    expires_in: 0,
  };
}

/** Bytes for the authenticated local-content route. */
export async function readDocumentBytes(
  client: SupabaseClient,
  userId: string,
  documentId: string,
  storage: StorageProvider,
): Promise<{ bytes: Buffer; row: DocumentRow }> {
  const row = await getOwnedRow(client, userId, documentId);
  if (row.status === 'deleting' || row.status === 'deleted') {
    throw new DocumentError('Document not found.', 'DOCUMENT_NOT_FOUND', 404);
  }
  try {
    const bytes = await storage.get(row.storage_path);
    return { bytes, row };
  } catch {
    throw new DocumentError('Document file is unavailable.', 'DOCUMENT_FILE_MISSING', 404);
  }
}
