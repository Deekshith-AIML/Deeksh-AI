/**
 * controllers/document.controller.ts
 * ----------------------------------
 * Knowledge Base API (Milestone 5 — additive; existing routes untouched).
 *
 * SECURITY
 * - `getAuth(req)` supplies the verified user id; no route reads an identity
 *   from the body, query string or headers.
 * - `getDb(req)` is the user-scoped Supabase client, so RLS applies on top of
 *   the explicit `.eq('user_id', userId)` filters in the service.
 * - Storage keys never leave the server; the only read surface is a
 *   short-lived signed URL (or the authenticated local content route).
 * - Errors return stable codes, never SQL/parser internals or file content.
 */

import type { Request, Response, NextFunction } from 'express';
import { getAuth, getDb } from '../middleware/auth.middleware.js';
import * as DocumentService from '../services/documents/document.service.js';
import * as DocumentRetrieval from '../services/documents/retrieval.service.js';
import { DocumentError, isDocumentError } from '../services/documents/errors.js';
import { createStorageProvider } from '../services/storage/index.js';
import { embed } from '../services/embedding.service.js';
import { getDocumentsConfig } from '../config/documents.config.js';
import {
  documentListQuerySchema,
  documentRenameSchema,
  documentSearchSchema,
} from '../../../shared/schemas.js';
import type { DocumentSearchHit } from '../../../shared/types.js';

function fail(err: unknown, res: Response, next: NextFunction): void {
  if (isDocumentError(err)) {
    const payload: { error: string; code: string; details?: unknown } = {
      error: err.message,
      code: err.code,
    };
    if (err.details !== undefined) payload.details = err.details;
    res.status(err.statusCode).json(payload);
    return;
  }
  next(err);
}

/** Maximum excerpt length returned by semantic search. */
const SEARCH_PREVIEW_CHARS = 400;

/** Build a bounded, display-safe excerpt from a retrieved chunk. */
function toPreview(content: string): string {
  const normalised = content.trim();
  if (normalised.length <= SEARCH_PREVIEW_CHARS) return normalised;
  return `${normalised.slice(0, SEARCH_PREVIEW_CHARS).trimEnd()}…`;
}

/**
 * POST /api/documents/search — semantic search over the caller's ready docs.
 *
 * The vector SQL stays in the `match_document_chunks` RPC; this handler only
 * validates input, verifies an optional document scope, embeds the query and
 * maps rows to the public `DocumentSearchResponse` shape.
 */
export async function searchDocumentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const parsed = documentSearchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid search query',
        code: 'INVALID_SEARCH_QUERY',
        details: parsed.error.flatten(),
      });
      return;
    }

    const { query, document_ids, threshold, max_results } = parsed.data;

    // Explicitly selected ids are verified before any embedding call, so a
    // foreign id can never influence retrieval or leak that it exists.
    if (document_ids && document_ids.length > 0) {
      await DocumentRetrieval.assertSearchableDocumentScope(db, userId, document_ids);
    }

    let queryEmbedding: number[];
    try {
      // Query-role formatting is required to match document embeddings.
      queryEmbedding = await embed(query, { role: 'query' });
    } catch (err) {
      console.warn(
        '[documents.search] query embedding failed:',
        err instanceof Error ? err.message : err,
      );
      throw new DocumentError(
        'Search is temporarily unavailable. Please try again.',
        'DOCUMENT_SEARCH_EMBEDDING_FAILED',
        503,
      );
    }

    const config = getDocumentsConfig();
    const hits = await DocumentRetrieval.searchDocumentChunks(
      db,
      userId,
      queryEmbedding,
      {
        documentIds: document_ids,
        threshold,
        maxResults: Math.min(Math.max(max_results ?? config.retrievalTopK, 1), 50),
        // The Knowledge Base search surface reports DB outages honestly
        // instead of returning a misleading empty result.
        throwOnError: true,
      },
    );

    // Defence in depth: the RPC already filters by user_id + ready status.
    const paragraphs = await DocumentRetrieval.loadChunkParagraphRanges(
      db,
      userId,
      hits.map((hit) => hit.chunkId),
    );

    const chunks: DocumentSearchHit[] = hits
      .filter((hit) => hit.userId === userId)
      .map((hit) => ({
        chunk_id: hit.chunkId,
        document_id: hit.documentId,
        filename: hit.filename,
        chunk_index: hit.chunkIndex,
        page_start: hit.pageStart,
        page_end: hit.pageEnd,
        heading: hit.heading,
        section_path: hit.sectionPath,
        paragraph_start: paragraphs.get(hit.chunkId)?.paragraphStart ?? null,
        paragraph_end: paragraphs.get(hit.chunkId)?.paragraphEnd ?? null,
        similarity: hit.similarity,
        preview: toPreview(hit.content),
      }));

    res.json({ chunks, count: chunks.length });
  } catch (err) {
    fail(err, res, next);
  }
}

/** POST /api/documents — multipart upload. */
export async function uploadDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);
    const file = req.file;

    if (!file || !file.buffer || file.buffer.length === 0) {
      res.status(400).json({
        error: 'No file uploaded. Send multipart/form-data with a "file" field.',
        code: 'NO_FILE',
      });
      return;
    }

    const storage = createStorageProvider(db);
    const document = await DocumentService.createDocument(
      db,
      userId,
      { bytes: file.buffer, originalFilename: file.originalname },
      storage,
    );

    res.status(201).json({ document });
  } catch (err) {
    fail(err, res, next);
  }
}

/** GET /api/documents — list with search + filters. */
export async function listDocumentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const parsed = documentListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      return;
    }

    const result = await DocumentService.listDocuments(db, userId, parsed.data);
    res.json(result);
  } catch (err) {
    fail(err, res, next);
  }
}

/** GET /api/documents/:id — metadata + queue state. */
export async function getDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);
    const result = await DocumentService.getDocumentDetails(db, userId, String(req.params.id));
    res.json(result);
  } catch (err) {
    fail(err, res, next);
  }
}

/** PATCH /api/documents/:id — rename only. */
export async function renameDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const parsed = documentRenameSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }

    const document = await DocumentService.renameDocument(
      db,
      userId,
      String(req.params.id),
      parsed.data.original_filename,
    );
    res.json({ document });
  } catch (err) {
    fail(err, res, next);
  }
}

/** DELETE /api/documents/:id — begin (and normally complete) deletion. */
export async function deleteDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);
    const storage = createStorageProvider(db);
    const document = await DocumentService.deleteDocument(
      db,
      userId,
      String(req.params.id),
      storage,
    );
    res.json({ document });
  } catch (err) {
    fail(err, res, next);
  }
}

/** POST /api/documents/:id/retry — re-enqueue a failed document. */
export async function retryDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);
    const document = await DocumentService.retryDocument(
      db,
      userId,
      String(req.params.id),
    );
    res.status(202).json({ document });
  } catch (err) {
    fail(err, res, next);
  }
}

/** GET /api/documents/:id/view — short-lived link. */
export async function viewDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);
    const storage = createStorageProvider(db);
    const result = await DocumentService.getDocumentViewLink(
      db,
      userId,
      String(req.params.id),
      storage,
    );
    res.json(result);
  } catch (err) {
    fail(err, res, next);
  }
}

/** GET /api/documents/:id/chunks — provenance preview (paginated). */
export async function listDocumentChunksHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);

    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const offset = Number.parseInt(String(req.query.offset ?? '0'), 10);

    const result = await DocumentService.listDocumentChunks(
      db,
      userId,
      String(req.params.id),
      {
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0,
      },
    );
    res.json(result);
  } catch (err) {
    fail(err, res, next);
  }
}

/**
 * GET /api/documents/:id/content — authenticated byte stream.
 *
 * Used by the local storage adapter (no signed URLs exist without Supabase
 * Storage). Ownership is checked exactly like every other route; the
 * response is private and non-cacheable.
 */
export async function downloadDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    const db = getDb(req);
    const storage = createStorageProvider(db);

    const { bytes, row } = await DocumentService.readDocumentBytes(
      db,
      userId,
      String(req.params.id),
      storage,
    );

    const safeName = row.original_filename.replace(/["\r\n]/g, '_');
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(bytes);
  } catch (err) {
    fail(err, res, next);
  }
}
