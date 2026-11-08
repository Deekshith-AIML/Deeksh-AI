/**
 * services/documents/validation.ts
 * --------------------------------
 * Server-side upload validation for the Knowledge Base.
 *
 * The browser-supplied MIME type and file extension are ADVISORY ONLY.
 * Every decision here is made from the bytes:
 *
 *   PDF   -> must start with "%PDF-" and contain "%%EOF"
 *   DOCX  -> must be a ZIP containing [Content_Types].xml + word/document.xml
 *   TXT   -> must decode as UTF-8/UTF-16/Windows-1252 with no NUL bytes and
 *            a negligible control-character ratio
 *
 * DOCX is a ZIP, so it is preflighted against zip-bomb limits BEFORE any
 * parser (mammoth) is allowed to inflate it. Nothing is ever extracted to
 * disk, so entry names cannot cause path traversal.
 *
 * SECURITY: a valid signature does not make content trusted. Extracted text
 * is untrusted data downstream; this module only decides whether the file is
 * structurally safe to process.
 */

import JSZip from 'jszip';
import type { DocumentsConfig } from '../../config/documents.config.js';
import type { DocumentExtension, DocumentMimeType } from '../../../../shared/types.js';
import { DocumentValidationError } from './errors.js';

export const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'txt'] as const;

export const MIME_BY_EXTENSION: Record<DocumentExtension, DocumentMimeType> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
};

/** Result of a successful validation pass. */
export interface ValidatedUpload {
  extension: DocumentExtension;
  mimeType: DocumentMimeType;
  /** Display name, normalised and safe to store/show. */
  normalizedFilename: string;
  /** Encoding detected for TXT uploads (undefined for binary formats). */
  encoding?: string;
}

// ---------------------------------------------------------------------------
// Filename handling
// ---------------------------------------------------------------------------

/**
 * Normalise an uploaded filename:
 * - keep only the basename (defeats "../" and absolute paths)
 * - strip control characters and Windows-reserved characters
 * - collapse whitespace, strip leading dots
 * - cap at 255 BYTES while preserving the extension
 *
 * The result is display-only; it is never used as a filesystem path. The
 * storage object name is a fresh UUID.
 */
export function normalizeFilename(raw: string): string {
  const base = String(raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? '';

  let name = base
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');

  if (!name) name = 'document';

  // Cap at 255 bytes without splitting a multi-byte character.
  while (Buffer.byteLength(name, 'utf8') > 255) {
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
      name = name.slice(0, dot - 1) + name.slice(dot);
    } else {
      name = name.slice(0, -1);
    }
    if (!name) return 'document';
  }

  return name;
}

/** Lowercased extension without the dot, or null. */
export function extensionOf(filename: string): string | null {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

/** Assert the extension is supported; a double extension like .pdf.exe fails. */
export function assertAllowedExtension(filename: string): DocumentExtension {
  const ext = extensionOf(filename);
  if (!ext || !(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new DocumentValidationError(
      'Unsupported file type. Allowed formats: PDF, DOCX, TXT.',
      'UNSUPPORTED_EXTENSION',
      415,
    );
  }
  return ext as DocumentExtension;
}

/** Force the stored extension to match the detected file type on rename. */
export function withExtension(filename: string, ext: DocumentExtension): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return `${stem || 'document'}.${ext}`;
}

// ---------------------------------------------------------------------------
// Byte signatures
// ---------------------------------------------------------------------------

const PDF_HEADER = '%PDF-';

export function looksLikePdf(bytes: Buffer): boolean {
  if (bytes.length < 16) return false;
  if (bytes.subarray(0, PDF_HEADER.length).toString('latin1') !== PDF_HEADER) {
    return false;
  }
  // "%%EOF" may be followed by padding/newlines; search the tail.
  const tailStart = Math.max(0, bytes.length - 2048);
  return bytes.subarray(tailStart).toString('latin1').includes('%%EOF');
}

export function looksLikeZip(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  // Local file header, empty archive, or spanned archive signature.
  const sig = bytes.readUInt32LE(0);
  return sig === 0x04034b50 || sig === 0x06054b50 || sig === 0x08074b50;
}

/**
 * Detect the ZIP "encrypted" flag (general purpose bit 0) in local file
 * headers. JSZip cannot decrypt, and we refuse to hand encrypted archives
 * to a parser that might hang or produce garbage.
 */
export function hasEncryptedZipEntry(bytes: Buffer): boolean {
  for (let i = 0; i + 8 < bytes.length; i += 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x03 &&
      bytes[i + 3] === 0x04
    ) {
      const flags = (bytes[i + 6] ?? 0) | ((bytes[i + 7] ?? 0) << 8);
      if ((flags & 0x1) !== 0) return true;
      i += 3;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// DOCX (ZIP) preflight
// ---------------------------------------------------------------------------

interface ZipEntryMeta {
  uncompressedSize?: number;
  compressedSize?: number;
}

/**
 * Resource guards for DOCX before parsing:
 * - entry count cap
 * - total declared uncompressed size cap
 * - per-entry compression-ratio cap (zip bomb)
 * - encrypted entries refused
 * - required OOXML parts present
 */
export async function preflightDocx(bytes: Buffer, config: DocumentsConfig): Promise<void> {
  if (!looksLikeZip(bytes)) {
    throw new DocumentValidationError(
      'This file is not a valid DOCX archive.',
      'MALFORMED_FILE',
      400,
    );
  }
  if (hasEncryptedZipEntry(bytes)) {
    throw new DocumentValidationError(
      'Password-protected documents are not supported.',
      'DOCX_ENCRYPTED',
      400,
    );
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: false });
  } catch {
    throw new DocumentValidationError(
      'This DOCX file is corrupted and cannot be read.',
      'MALFORMED_FILE',
      400,
    );
  }

  const names = Object.keys(zip.files);
  if (names.length > config.docxMaxEntries) {
    throw new DocumentValidationError(
      'This DOCX file contains too many internal parts.',
      'DOCX_TOO_MANY_ENTRIES',
      400,
    );
  }

  let totalUncompressed = 0;
  for (const name of names) {
    const entry = zip.files[name];
    if (!entry || entry.dir) continue;
    const meta = (entry as unknown as { _data?: ZipEntryMeta })._data;
    const uncompressed = Number(meta?.uncompressedSize ?? 0);
    const compressed = Number(meta?.compressedSize ?? 0);

    if (!Number.isFinite(uncompressed) || uncompressed < 0) {
      throw new DocumentValidationError(
        'This DOCX file has an invalid internal structure.',
        'MALFORMED_FILE',
        400,
      );
    }

    totalUncompressed += uncompressed;
    if (totalUncompressed > config.docxMaxUncompressedBytes) {
      throw new DocumentValidationError(
        'This DOCX file expands beyond the allowed size.',
        'DOCX_TOO_LARGE',
        413,
      );
    }

    // A zero compressed size with a large payload is a classic bomb shape.
    if (compressed === 0) {
      if (uncompressed > 1_048_576) {
        throw new DocumentValidationError(
          'This DOCX file has an unsafe compression ratio.',
          'DOCX_COMPRESSION_RATIO',
          400,
        );
      }
    } else if (uncompressed / compressed > config.docxMaxCompressionRatio) {
      throw new DocumentValidationError(
        'This DOCX file has an unsafe compression ratio.',
        'DOCX_COMPRESSION_RATIO',
        400,
      );
    }
  }

  if (!names.includes('[Content_Types].xml') || !names.includes('word/document.xml')) {
    throw new DocumentValidationError(
      'This archive is not a Word document.',
      'MALFORMED_FILE',
      400,
    );
  }
}

// ---------------------------------------------------------------------------
// Text decoding
// ---------------------------------------------------------------------------

/** Decode text bytes and record the encoding. Throws on binary garbage. */
export function decodeText(bytes: Buffer): { text: string; encoding: string } {
  let encoding = 'utf-8';

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8';
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
  } else {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      encoding = 'utf-8';
    } catch {
      encoding = 'windows-1252';
    }
  }

  let text: string;
  try {
    // TextDecoder strips a leading BOM for the matching encoding.
    text = new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    throw new DocumentValidationError(
      'This text file uses an unsupported character encoding.',
      'TEXT_UNDECODABLE',
      400,
    );
  }

  if (text.includes('\u0000')) {
    throw new DocumentValidationError(
      'This file looks like binary data, not plain text.',
      'TEXT_UNDECODABLE',
      400,
    );
  }

  const controlCount = (text.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
  if (text.length > 0 && controlCount / text.length > 0.01) {
    throw new DocumentValidationError(
      'This file looks like binary data, not plain text.',
      'TEXT_UNDECODABLE',
      400,
    );
  }

  return { text, encoding };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validate an uploaded file end-to-end and return what the caller needs to
 * persist. Throws `DocumentValidationError` with a stable code on failure.
 *
 * The browser-provided MIME type is accepted as an argument only so the
 * caller can compare it against the detected type if desired; it never
 * influences the detected type.
 */
export async function validateUpload(
  bytes: Buffer,
  originalName: string,
  config: DocumentsConfig,
): Promise<ValidatedUpload> {
  if (!bytes || bytes.length === 0) {
    throw new DocumentValidationError('The uploaded file is empty.', 'EMPTY_FILE', 400);
  }
  if (bytes.length > config.maxUploadBytes) {
    throw new DocumentValidationError(
      `File exceeds the ${Math.floor(config.maxUploadBytes / (1024 * 1024))} MB limit.`,
      'FILE_TOO_LARGE',
      413,
    );
  }

  const normalizedFilename = normalizeFilename(originalName);
  const extension = assertAllowedExtension(normalizedFilename);
  const mimeType = MIME_BY_EXTENSION[extension];

  let encoding: string | undefined;

  if (extension === 'pdf') {
    if (!looksLikePdf(bytes)) {
      throw new DocumentValidationError(
        'This file is not a valid PDF.',
        'MALFORMED_FILE',
        400,
      );
    }
  } else if (extension === 'docx') {
    await preflightDocx(bytes, config);
  } else {
    const decoded = decodeText(bytes);
    encoding = decoded.encoding;
  }

  return { extension, mimeType, normalizedFilename, encoding };
}
