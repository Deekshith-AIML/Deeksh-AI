/**
 * services/documents/extraction/index.ts
 * --------------------------------------
 * Document extraction orchestration (Milestone 5).
 *
 * Entry point: `extractDocument(bytes, extension, config)`.
 *
 * Every parser runs on raw bytes only (never on disk). Extracted text is
 * treated as untrusted data from the first byte onward.
 *
 * Supported:
 *   PDF   → pages tracked; scanned PDFs (too little extractable text)
 *           flagged for `SCANNED_PDF_REQUIRES_OCR`.
 *   DOCX  → paragraphs + heading hierarchy + tables; pages never invented.
 *   TXT   → paragraphs; encoding recorded.
 *
 * Public API returns a structure-aware result with per-paragraph provenance
 * (page range, heading, section path, character offsets) ready for the
 * chunking stage.
 */

import type { DocumentsConfig } from '../../../config/documents.config.js';
import type { DocumentExtractionMetadata } from '../../../../../shared/types.js';
import { extractPdf } from './pdf.extractor.js';
import { extractDocx } from './docx.extractor.js';
import { extractTxt } from './txt.extractor.js';
import { normalizeParagraphs } from './normalize.js';

/** Raw paragraph from a parser (provenance is optional; index.ts fills it). */
export interface RawParagraph {
  text: string;
  pageStart?: number | null;
  pageEnd?: number | null;
  heading?: string | null;
  sectionPath?: string | null;
}

/** What a parser returns before normalization. */
export interface RawExtraction {
  paragraphs: RawParagraph[];
  totalPages: number | null;
  hasExtractableText: boolean;
  metadata: DocumentExtractionMetadata;
}

export interface ParagraphProvenance {
  /** Zero-based index of this paragraph in the extracted sequence. */
  index: number;
  /** PDF page where this paragraph begins/ends (null for DOCX/TXT). */
  pageStart: number | null;
  pageEnd: number | null;
  /** Nearest heading/section title above this paragraph (DOCX preferred). */
  heading: string | null;
  /** Dotted section path, e.g. "2 Internship > 2.3 Skills". */
  sectionPath: string | null;
  /** Character offsets into `totalText` (inclusive start, exclusive end). */
  charStart: number;
  charEnd: number;
}

export interface ExtractionResult {
  /** Full normalized extracted text (all paragraphs joined with blank lines). */
  totalText: string;
  /** One entry per non-empty paragraph, in document order. */
  paragraphs: Array<{
    text: string;
    provenance: ParagraphProvenance;
    tokenEstimate: number;
  }>;
  /** Total pages (PDF only; null otherwise). */
  totalPages: number | null;
  /** Whether extraction produced any usable text at all. */
  hasExtractableText: boolean;
  /** Metadata recorded into `documents.extraction_metadata`. */
  metadata: DocumentExtractionMetadata;
}

/**
 * Extract text + provenance from a validated document buffer.
 *
 * Throws on structural failure; callers translate into stable errors.
 */
export async function extractDocument(
  bytes: Buffer,
  extension: 'pdf' | 'docx' | 'txt',
  config: DocumentsConfig,
): Promise<ExtractionResult> {
  let raw: RawExtraction;

  switch (extension) {
    case 'pdf':
      raw = await extractPdf(bytes, config);
      break;
    case 'docx':
      raw = await extractDocx(bytes, config);
      break;
    case 'txt':
      raw = await extractTxt(bytes, config);
      break;
    default:
      throw new Error(`Unsupported extension: ${extension}`);
  }

  const paragraphs = normalizeParagraphs(raw.paragraphs, config);

  const metadata: DocumentExtractionMetadata = {
    encoding: raw.metadata.encoding,
    scanned: raw.metadata.scanned,
    paragraphs: paragraphs.length,
    headings: raw.metadata.headings,
    tables: raw.metadata.tables,
    pages_with_text: raw.metadata.pages_with_text,
    truncated: paragraphs.length >= config.maxChunksPerDocument,
  };

  return {
    totalText: paragraphs.map((p) => p.text).join('\n\n'),
    paragraphs,
    totalPages: raw.totalPages,
    hasExtractableText: raw.hasExtractableText,
    metadata,
  };
}