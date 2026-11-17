/**
 * M5 Corrective Patch 4 — upload validation coverage
 * --------------------------------------------------
 * Dedicated tests for the upload pipeline: valid formats, extension and
 * magic-byte rejection, size limits, duplicates, filename normalisation,
 * path traversal, cross-user access, storage failure, DB failure and
 * partial-upload cleanup. Storage is always an in-memory fake — no real
 * documents are uploaded anywhere.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import {
  createDocument,
  getOwnedRow,
} from '../src/services/documents/document.service.js';
import {
  resetFakeSupabase,
  registerUser,
  fakeDb,
  fakeCreateUserScopedClient,
  injectDatabaseFailure,
} from './helpers/fakeSupabase.js';
import {
  validateUpload,
  normalizeFilename,
  assertAllowedExtension,
  looksLikePdf,
  looksLikeZip,
} from '../src/services/documents/validation.js';
import { StorageError } from '../src/services/storage/index.js';
import type { StorageProvider } from '../src/services/storage/index.js';
import { getDocumentsConfig } from '../src/config/documents.config.js';

const config = getDocumentsConfig();

function pdfBytes(): Buffer {
  return Buffer.from('%PDF-1.4\nHello World\n%%EOF', 'latin1');
}

function txtBytes(): Buffer {
  return Buffer.from('This is plain text content.\nSecond line.', 'utf8');
}

async function docxBytes(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('_rels/.rels', '<Relationships/>');
  zip.file('word/document.xml', '<w:document><w:body/></w:document>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** In-memory storage provider with spies used by createDocument. */
function makeProvider(overrides: Partial<StorageProvider> = {}): StorageProvider & {
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  signedUrl: ReturnType<typeof vi.fn>;
} {
  return {
    kind: 'local',
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(Buffer.from('')),
    remove: vi.fn().mockResolvedValue(undefined),
    signedUrl: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as never;
}

describe('M5 Corrective Patch 4 — upload validation', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser('token-a', 'user-a', 'a@example.com');
    registerUser('token-b', 'user-b', 'b@example.com');
  });

  describe('validateUpload (bytes only)', () => {
    it('accepts a valid PDF', async () => {
      const result = await validateUpload(pdfBytes(), 'doc.pdf', config);
      expect(result.extension).toBe('pdf');
      expect(result.mimeType).toBe('application/pdf');
    });

    it('accepts a valid DOCX', async () => {
      const result = await validateUpload(await docxBytes(), 'report.docx', config);
      expect(result.extension).toBe('docx');
    });

    it('accepts a valid TXT file and records encoding', async () => {
      const result = await validateUpload(txtBytes(), 'notes.txt', config);
      expect(result.extension).toBe('txt');
      expect(result.encoding).toBe('utf-8');
    });

    it('rejects an unsupported extension', () => {
      expect(() => assertAllowedExtension('malware.exe')).toThrowError(
        expect.objectContaining({ code: 'UNSUPPORTED_EXTENSION' }),
      );
    });

    it('rejects a .pdf filename whose bytes are not a PDF (MIME/magic mismatch)', async () => {
      await expect(
        validateUpload(Buffer.from('plain text, not a pdf at all'), 'fake.pdf', config),
      ).rejects.toMatchObject({ code: 'MALFORMED_FILE' });
    });

    it('rejects a .docx filename whose bytes are not a ZIP', async () => {
      await expect(
        validateUpload(Buffer.from('clearly not a zip archive'), 'fake.docx', config),
      ).rejects.toMatchObject({ code: 'MALFORMED_FILE' });
    });

    it('rejects incorrect magic bytes for both detectors', () => {
      expect(looksLikePdf(Buffer.from('not a pdf'))).toBe(false);
      expect(looksLikeZip(Buffer.from('plain text'))).toBe(false);
    });

    it('rejects an oversized file', async () => {
      const strict = { ...config, maxUploadBytes: 10 };
      await expect(validateUpload(Buffer.alloc(11, 0x41), 'big.pdf', strict)).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE',
      });
    });

    it('rejects an empty file', async () => {
      await expect(validateUpload(Buffer.alloc(0), 'empty.pdf', config)).rejects.toMatchObject({
        code: 'EMPTY_FILE',
      });
    });

    it('normalises unsafe filenames', () => {
      const normalized = normalizeFilename('..\\..\\My<Report>:Q1?.pdf');
      expect(normalized).not.toMatch(/[<>:"|?*\\/]/);
      expect(normalized.endsWith('.pdf')).toBe(true);
      // Directory components are stripped (basename only).
      expect(normalized).not.toContain('..');
    });
  });

  describe('createDocument persistence', () => {
    it('stores and registers a PDF upload', async () => {
      const client = fakeCreateUserScopedClient('token-a');
      const provider = makeProvider();

      const doc = await createDocument(
        client,
        'user-a',
        { bytes: pdfBytes(), originalFilename: 'guide.pdf' },
        provider,
      );

      expect(doc.status).toBe('pending');
      expect(provider.put).toHaveBeenCalledTimes(1);
      expect(fakeDb.documents).toHaveLength(1);
      expect(fakeDb.document_processing_jobs).toHaveLength(1);

      const [path] = provider.put.mock.calls[0]!;
      expect(path).toMatch(
        new RegExp(`^user-a/${doc.id}/[0-9a-f-]{36}\\.pdf$`),
      );
      expect(path).not.toContain('..');
    });

    it('rejects an unsupported extension before writing anything', async () => {
      const client = fakeCreateUserScopedClient('token-a');
      const provider = makeProvider();

      await expect(
        createDocument(
          client,
          'user-a',
          { bytes: pdfBytes(), originalFilename: 'evil.exe' },
          provider,
        ),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_EXTENSION' });

      expect(provider.put).not.toHaveBeenCalled();
      expect(fakeDb.documents).toHaveLength(0);
    });

    it('strips path traversal from the filename (never used as a path)', async () => {
      const client = fakeCreateUserScopedClient('token-a');
      const provider = makeProvider();

      // Basename is "passwd", which has no allowed extension.
      await expect(
        createDocument(
          client,
          'user-a',
          { bytes: pdfBytes(), originalFilename: '../../etc/passwd.pdf' },
          provider,
        ),
      ).resolves.toMatchObject({ original_filename: 'passwd.pdf' });

      const [path] = provider.put.mock.calls[0]!;
      expect(path).toMatch(/^user-a\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/);
    });

    it('rejects identical content as a duplicate', async () => {
      const providerA = makeProvider();
      const doc = await createDocument(
        fakeCreateUserScopedClient('token-a'),
        'user-a',
        { bytes: pdfBytes(), originalFilename: 'first.pdf' },
        providerA,
      );
      expect(doc.status).toBe('pending');

      const providerB = makeProvider();
      await expect(
        createDocument(
          fakeCreateUserScopedClient('token-a'),
          'user-a',
          { bytes: pdfBytes(), originalFilename: 'second.pdf' },
          providerB,
        ),
      ).rejects.toMatchObject({ code: 'DUPLICATE_DOCUMENT' });
      expect(providerB.put).not.toHaveBeenCalled();
    });

    it('maps a storage write failure to STORAGE_WRITE_FAILED', async () => {
      const provider = makeProvider({
        put: vi.fn().mockRejectedValue(new StorageError('bucket unavailable', 'STORAGE_UPLOAD_FAILED')),
      });

      await expect(
        createDocument(
          fakeCreateUserScopedClient('token-a'),
          'user-a',
          { bytes: pdfBytes(), originalFilename: 'guide.pdf' },
          provider,
        ),
      ).rejects.toMatchObject({ code: 'STORAGE_WRITE_FAILED' });

      expect(fakeDb.documents).toHaveLength(0);
    });

    it('removes the stored object when metadata insertion fails', async () => {
      const provider = makeProvider();
      injectDatabaseFailure('documents', 'insert');

      await expect(
        createDocument(
          fakeCreateUserScopedClient('token-a'),
          'user-a',
          { bytes: pdfBytes(), originalFilename: 'guide.pdf' },
          provider,
        ),
      ).rejects.toMatchObject({ code: 'DATABASE_ERROR' });

      // No document row survives and the object was cleaned up.
      expect(fakeDb.documents).toHaveLength(0);
      expect(provider.remove).toHaveBeenCalledTimes(1);
    });

    it('rolls back the row and object when job creation fails', async () => {
      const provider = makeProvider();
      injectDatabaseFailure('document_processing_jobs', 'insert');

      await expect(
        createDocument(
          fakeCreateUserScopedClient('token-a'),
          'user-a',
          { bytes: pdfBytes(), originalFilename: 'guide.pdf' },
          provider,
        ),
      ).rejects.toMatchObject({ code: 'DATABASE_ERROR' });

      expect(fakeDb.documents).toHaveLength(0);
      expect(fakeDb.document_processing_jobs).toHaveLength(0);
      expect(provider.remove).toHaveBeenCalledTimes(1);
    });

    it('does not expose another user\'s document', async () => {
      const doc = await createDocument(
        fakeCreateUserScopedClient('token-a'),
        'user-a',
        { bytes: pdfBytes(), originalFilename: 'private.pdf' },
        makeProvider(),
      );

      await expect(
        getOwnedRow(fakeCreateUserScopedClient('token-b'), 'user-b', doc.id),
      ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    });
  });
});
