/**
 * tests/document-rag-edge-cases.test.ts
 * -------------------------------------
 * Phase 12 Task G — document pipeline edge cases that are deterministic and
 * do not require a live provider:
 *
 *   - a scanned (text-free) PDF fails permanently with
 *     `SCANNED_PDF_REQUIRES_OCR` and never persists chunks (no OCR exists),
 *   - a whitespace-only TXT fails permanently with `NO_EXTRACTABLE_TEXT`,
 *   - a very large TXT is bounded by `maxChunksPerDocument` and still becomes
 *     ready with truthful truncation metadata,
 *   - the chunker can produce zero chunks, which is the condition the worker
 *     rejects with `NO_CHUNKS_PRODUCED`,
 *   - the citation viewer link is short-lived (120s) and re-issues a signed
 *     URL rather than a permanent public URL.
 *
 * Documented limitations (cannot be exercised deterministically here):
 *   - password-protected / encrypted PDFs are unsupported (the PDF extractor
 *     rejects them as malformed; there is no decryption path),
 *   - OCR and malware scanning are not implemented,
 *   - actual signed-URL expiry cannot be simulated against the in-memory
 *     storage double; only the issued TTL is asserted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { processDocumentJobs } from '../src/workers/document.worker.js';
import { chunkDocument } from '../src/services/documents/chunking.js';
import { extractDocument } from '../src/services/documents/extraction/index.js';
import { getDocumentViewLink } from '../src/services/documents/document.service.js';
import { createStorageProvider } from '../src/services/storage/index.js';
import { getDocumentsConfig } from '../src/config/documents.config.js';
import {
  resetFakeSupabase,
  registerUser,
  fakeDb,
  fakeCreateUserScopedClient,
  seedStoredObject,
} from './helpers/fakeSupabase.js';
import type { FakeDocument, FakeDocumentJob } from './helpers/fakeSupabase.js';

const USER = 'user-edge';
const TOKEN = 'token-edge';
const BUCKET = 'documents';

function nowIso(): string {
  return new Date().toISOString();
}

function seedDocument(
  bytes: Buffer,
  options: {
    extension: 'pdf' | 'docx' | 'txt';
    mime: string;
    overrides?: Partial<FakeDocument>;
  },
): FakeDocument {
  const id = randomUUID();
  const row: FakeDocument = {
    id,
    user_id: USER,
    original_filename: `edge.${options.extension}`,
    storage_filename: `edge.${options.extension}`,
    extension: options.extension,
    mime_type: options.mime,
    file_size: bytes.length,
    content_hash: randomUUID().replace(/-/g, ''),
    storage_path: `${USER}/${id}/edge.${options.extension}`,
    status: 'processing',
    page_count: null,
    text_char_count: null,
    chunk_count: 0,
    extraction_metadata: {},
    error_message: null,
    deletion_attempts: 0,
    deletion_error: null,
    processing_started_at: null,
    processing_completed_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...options.overrides,
  };
  fakeDb.documents.push(row);
  seedStoredObject(BUCKET, row.storage_path, bytes, options.mime);
  return row;
}

function seedJob(document: FakeDocument, overrides: Partial<FakeDocumentJob> = {}): FakeDocumentJob {
  const row: FakeDocumentJob = {
    id: randomUUID(),
    document_id: document.id,
    user_id: document.user_id,
    status: 'claimed',
    attempts: 1,
    max_attempts: 3,
    claimed_at: nowIso(),
    last_attempt_at: null,
    next_attempt_at: nowIso(),
    failed_at: null,
    error_message: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  };
  fakeDb.document_processing_jobs.push(row);
  return row;
}

function findDoc(id: string): FakeDocument {
  const row = fakeDb.documents.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`document ${id} missing`);
  return row;
}

function findJob(id: string): FakeDocumentJob {
  const row = fakeDb.document_processing_jobs.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`job ${id} missing`);
  return row;
}

function jobRecord(job: FakeDocumentJob): Record<string, unknown> {
  return job as unknown as Record<string, unknown>;
}

async function scannedPdfBytes(): Promise<Buffer> {
  // A real PDF with one page and no text layer: this is exactly the
  // "scanned document" case, which requires OCR that this project does not
  // implement.
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save());
}

describe('Phase 12 Task G — document pipeline edge cases', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN, USER, 'edge@example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails a scanned PDF permanently with SCANNED_PDF_REQUIRES_OCR and stores no chunks', async () => {
    const bytes = await scannedPdfBytes();
    const doc = seedDocument(bytes, { extension: 'pdf', mime: 'application/pdf' });
    const job = seedJob(doc);
    const client = fakeCreateUserScopedClient(TOKEN);

    const result = await processDocumentJobs({ client }, [jobRecord(job)]);

    expect(result).toEqual({ processed: 0, failed: 1 });
    expect(findJob(job.id).status).toBe('failed');
    expect(findJob(job.id).error_message).toBe('SCANNED_PDF_REQUIRES_OCR');
    expect(findDoc(doc.id).status).toBe('failed');
    expect(findDoc(doc.id).chunk_count).toBe(0);
    expect(fakeDb.document_chunks).toHaveLength(0);
  });

  it('fails a whitespace-only TXT permanently with NO_EXTRACTABLE_TEXT', async () => {
    const doc = seedDocument(Buffer.from('   \n\n   \t  \n', 'utf8'), {
      extension: 'txt',
      mime: 'text/plain',
    });
    const job = seedJob(doc);
    const client = fakeCreateUserScopedClient(TOKEN);

    const result = await processDocumentJobs({ client }, [jobRecord(job)]);

    expect(result).toEqual({ processed: 0, failed: 1 });
    expect(findJob(job.id).status).toBe('failed');
    expect(findJob(job.id).error_message).toBe('NO_EXTRACTABLE_TEXT');
    expect(findDoc(doc.id).status).toBe('failed');
    expect(fakeDb.document_chunks).toHaveLength(0);
  });

  it('bounds a very large TXT by maxChunksPerDocument and records truncation', async () => {
    vi.stubEnv('DOC_CHUNK_TARGET_TOKENS', '100');
    vi.stubEnv('DOC_CHUNK_OVERLAP_TOKENS', '0');
    vi.stubEnv('DOC_MAX_CHUNKS_PER_DOCUMENT', '2');

    const paragraphs: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      paragraphs.push(
        `Paragraph ${index} covers a distinct topic with enough words to occupy ` +
          'several hundred characters so the chunker must split the document ' +
          'across multiple chunks while the configured cap still applies. '.repeat(4),
      );
    }
    const largeText = paragraphs.join('\n\n');
    expect(largeText.length).toBeGreaterThan(20_000);

    const doc = seedDocument(Buffer.from(largeText, 'utf8'), {
      extension: 'txt',
      mime: 'text/plain',
    });
    const job = seedJob(doc);
    const client = fakeCreateUserScopedClient(TOKEN);

    const result = await processDocumentJobs({ client }, [jobRecord(job)]);

    expect(result).toEqual({ processed: 1, failed: 0 });
    const updated = findDoc(doc.id);
    expect(updated.status).toBe('ready');
    expect(updated.chunk_count).toBe(2);
    expect(fakeDb.document_chunks).toHaveLength(2);
    expect(updated.extraction_metadata).toMatchObject({ truncated: true });
    expect(fakeDb.document_chunks.every((chunk) => chunk.content.trim().length > 0)).toBe(true);
  });

  it('produces zero chunks when the chunk cap is zero (worker NO_CHUNKS_PRODUCED guard)', async () => {
    const config = getDocumentsConfig();
    const extraction = await extractDocument(
      Buffer.from('A short but extractable paragraph.\n\nAnother paragraph.', 'utf8'),
      'txt',
      config,
    );
    expect(extraction.hasExtractableText).toBe(true);

    const result = chunkDocument('doc-edge', USER, extraction, {
      ...config,
      maxChunksPerDocument: 0,
    });

    expect(result.totalChunks).toBe(0);
    expect(result.chunks).toHaveLength(0);
  });

  it('issues a short-lived signed view link and never a permanent public URL', async () => {
    const doc = seedDocument(Buffer.from('Confidential policy text.', 'utf8'), {
      extension: 'txt',
      mime: 'text/plain',
      overrides: { status: 'ready', chunk_count: 1 },
    });
    const client = fakeCreateUserScopedClient(TOKEN);
    const storage = createStorageProvider(client);

    const view = await getDocumentViewLink(client, USER, doc.id, storage);

    expect(view.expires_in).toBe(120);
    expect(view.url).toContain('expires=120');
    expect(view.url.startsWith('https://')).toBe(true);
    // The viewer never returns a raw storage path or local adapter path.
    expect(view.url).not.toMatch(/\.local-storage/i);
  });

  it('refuses to view a document that is being deleted', async () => {
    const doc = seedDocument(Buffer.from('Going away.', 'utf8'), {
      extension: 'txt',
      mime: 'text/plain',
      overrides: { status: 'deleting' },
    });
    const client = fakeCreateUserScopedClient(TOKEN);
    const storage = createStorageProvider(client);

    await expect(getDocumentViewLink(client, USER, doc.id, storage)).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
    });
  });
});
