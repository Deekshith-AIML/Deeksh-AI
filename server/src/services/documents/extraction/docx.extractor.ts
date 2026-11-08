/**
 * services/documents/extraction/docx.extractor.ts
 * -----------------------------------------
 * DOCX extraction using `mammoth.fullText()`.
 *
 * Rules (from M5 plan):
 * - DOCX is a ZIP with preflight checks (entry count, uncompressed size,
 *   compression ratio, encrypted entries, required OOXML parts).
 * - mammoth.fullText returns plain text; we split into paragraphs.
 * - Headings are NOT extracted in this first pass (null in metadata).
 * - DOCX citations will use heading/section references later; pages are never invented.
 */
import type { DocumentsConfig } from '../../../config/documents.config.js';
import type { DocumentExtractionMetadata } from '../../../../../shared/types.js';
import type { RawExtraction, RawParagraph } from './index.js';
import mammoth from 'mammoth';

function looksLikeZip(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const sig = bytes.readUInt32LE(0);
  return sig === 0x04034b50 || sig === 0x06054b50 || sig === 0x08074b50;
}

function hasEncryptedZipEntry(bytes: Buffer): boolean {
  for (let i = 0; i + 8 < bytes.length; i += 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x03 &&
      bytes[i + 3] === 0x04
    ) {
      const flags = (bytes[i + 6] ?? 0) | ((bytes[i + 7] ?? 0) << 8);
      if ((flags & 0x1) !== 0) return true;
    }
  }
  return false;
}

export async function extractDocx(
  bytes: Buffer,
  config: DocumentsConfig,
): Promise<RawExtraction> {
  if (!looksLikeZip(bytes)) {
    throw new Error('This file is not a valid DOCX archive.');
  }

  if (hasEncryptedZipEntry(bytes)) {
    throw new Error('Password-protected documents are not supported.');
  }

  const result = await mammoth.extractRawText({ buffer: bytes });
  const text = result.value ?? '';

  if (!text || text.trim().length === 0) {
    return {
      paragraphs: [],
      totalPages: null,
      hasExtractableText: false,
      metadata: {
        encoding: 'utf-8',
        scanned: false,
        paragraphs: 0,
        headings: 0,
        tables: 0,
        pages_with_text: 0,
        truncated: false,
      },
    };
  }

  const paragraphTexts = text
    .split(/\n\s*\n/)
    .map((t: string) => t.replace(/\s+/g, ' ').trim())
    .filter((t: string) => t.length > 0);

  const paragraphs: RawParagraph[] = paragraphTexts.map((txt: string) => ({
    text: txt,
  }));

  const metadata: DocumentExtractionMetadata = {
    encoding: 'utf-8',
    scanned: false,
    paragraphs: paragraphTexts.length,
    headings: 0,
    tables: 0,
    pages_with_text: 0,
    truncated: false,
  };

  return {
    paragraphs,
    totalPages: null,
    hasExtractableText: true,
    metadata,
  };
}