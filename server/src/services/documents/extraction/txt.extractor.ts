/**
 * services/documents/extraction/txt.extractor.ts
 * -----------------------------------------
 * TXT extraction using Node TextDecoder.
 *
 * Rules (from M5 plan):
 * - Detect encoding via BOM or first few bytes.
 *   UTF-8 BOM: EF BB BF
 *   UTF-16LE BOM: FF FE
 *   UTF-16BE BOM: FE FF
 * - If no BOM, try UTF-8 with fatal:TextDecoder first; on failure,
 *   fall back to windows-1252 (common legacy OEM encoding).
 * - Decode then split into paragraphs on blank lines.
 * - Normalise whitespace per paragraph: collapse internal runs, preserve
 *   paragraph boundaries.
 * - Preserve Unicode characters; never silently strip them.
 * - Detect likely binary: >1% control chars (C0+C1 ranges) or NUL bytes.
 * - Empty file → hasExtractableText=false, zero paragraphs.
 * - Whitespace-only file → same as empty.
 * - Unsupported encoding → throw with stable code.
 *
 * Provenance:
 * - `metadata.encoding` records detected encoding.
 * - `metadata.scanned` is always false for TXT (no scanned concept).
 * - `paragraphs` count in metadata.
 */
import type { DocumentsConfig } from '../../../config/documents.config.js';
import type { DocumentExtractionMetadata } from '../../../../../shared/types.js';
import type { RawExtraction, RawParagraph } from './index.js';

interface DecodedText {
  text: string;
  encoding: string;
}

function decodeTextSafe(bytes: Buffer): DecodedText {
  // UTF-8 BOM.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = new TextDecoder('utf-8').decode(bytes.slice(3));
    return { text, encoding: 'utf-8' };
  }

  // UTF-16LE BOM.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = new TextDecoder('utf-16le').decode(bytes.slice(2));
    return { text, encoding: 'utf-16le' };
  }

  // UTF-16BE BOM — Node TextDecoder has no utf-16be, so swap byte pairs
  // and decode as utf-16le.
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(bytes.length - 2);
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      const b1 = bytes[i + 1] as number;
      const b0 = bytes[i] as number;
      swapped[i - 2] = b1;
      swapped[i - 1] = b0;
    }
    const text = new TextDecoder('utf-16le').decode(swapped);
    return { text, encoding: 'utf-16be' };
  }

  // No known BOM. Try UTF-8 fatal first; fallback to windows-1252.
  let text = '';
  let encoding = 'utf-8';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    encoding = 'utf-8';
  } catch {
    try {
      text = new TextDecoder('windows-1252', { fatal: false }).decode(bytes);
      encoding = 'windows-1252';
    } catch {
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      encoding = 'utf-8-replacement';
    }
  }

  return { text, encoding };
}

/** Return true if the text contains likely binary markers. */
function hasLikelyBinaryContent(text: string): boolean {
  if (text.length === 0) return false;
  const controlChars = text.match(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x80-\x9f]/g);
  if (!controlChars) return false;
  const ratio = controlChars.length / text.length;
  return ratio > 0.01;
}

export async function extractTxt(
  bytes: Buffer,
  config: DocumentsConfig,
): Promise<RawExtraction> {
  const decoded = decodeTextSafe(bytes);

  if (hasLikelyBinaryContent(decoded.text)) {
    return {
      paragraphs: [],
      totalPages: null,
      hasExtractableText: false,
      metadata: {
        encoding: decoded.encoding,
        scanned: false,
        paragraphs: 0,
        headings: 0,
        tables: 0,
        pages_with_text: 0,
        truncated: false,
      },
    };
  }

  const rawParagraphs = decoded.text
    .split(/\n\s*\n/)
    .map((t: string) => t.replace(/\s+/g, ' ').trim())
    .filter((t: string) => t.length > 0)
    .map((txt: string) => ({
      text: txt,
    }));

  if (rawParagraphs.length === 0) {
    return {
      paragraphs: [],
      totalPages: null,
      hasExtractableText: false,
      metadata: {
        encoding: decoded.encoding,
        scanned: false,
        paragraphs: 0,
        headings: 0,
        tables: 0,
        pages_with_text: 0,
        truncated: false,
      },
    };
  }

  const paragraphs: RawParagraph[] = rawParagraphs.map((p, idx) => ({
    ...p,
    pageStart: null,
    pageEnd: null,
    heading: null,
    sectionPath: null,
  }));

  const metadata: DocumentExtractionMetadata = {
    encoding: decoded.encoding,
    scanned: false,
    paragraphs: paragraphs.length,
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