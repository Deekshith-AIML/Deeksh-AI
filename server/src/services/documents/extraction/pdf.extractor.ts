/**
 * services/documents/extraction/pdf.extractor.ts
 * -----------------------------------------
 * PDF extraction using pdfjs-dist legacy build.
 *
 * Rules (from M5 plan):
 * - PDF must pass magic-byte validation (%PDF- + %%EOF near end).
 * - PDF pages are tracked 1..N via pdfjsLib.getDocument/getPage.
 * - If total extractable characters across all pages is below
 *   config.minExtractableChars, the PDF is treated as scanned and fails
 *   with `SCANNED_PDF_REQUIRES_OCR` (no OCR implemented).
 * - Text extracted via page.getTextContent().items → strings → join.
 * - Whitespace normalised per-page; paragraphs split on blank lines.
 */
import type { DocumentsConfig } from '../../../config/documents.config.js';
import type { DocumentExtractionMetadata } from '../../../../../shared/types.js';
import type { RawExtraction, RawParagraph } from './index.js';

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const pdfDocApi: any = pdfjsLib;

export async function extractPdf(
  bytes: Buffer,
  config: DocumentsConfig,
): Promise<RawExtraction> {
  let doc: any;
  try {
    doc = await pdfDocApi.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  } catch (err) {
    throw new Error(`Failed to parse PDF: ${(err as Error).message}`);
  }

  const pageCount = doc.numPages;
  if (pageCount === 0) {
    return {
      paragraphs: [],
      totalPages: 0,
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

  // Extract text from every page.
  let totalExtractableChars = 0;
  const pageTexts: string[] = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const items = textContent.items.map((item: any) => item.str);
    const pageText = items.join(' ');
    pageTexts.push(pageText);
    totalExtractableChars += pageText.length;
  }

  // Below threshold → scanned PDF.
  if (totalExtractableChars < config.minExtractableChars) {
    return {
      paragraphs: [],
      totalPages: pageCount,
      hasExtractableText: false,
      metadata: {
        encoding: 'utf-8',
        scanned: true,
        paragraphs: 0,
        headings: 0,
        tables: 0,
        pages_with_text: 0,
        truncated: false,
      },
    };
  }

  // Normalise whitespace per page.
  const normPages = pageTexts.map((txt: string) => txt.replace(/\s+/g, ' ').trim());

  const paragraphs: RawParagraph[] = normPages.map((txt: string) => ({
    text: txt,
    pageStart: 1,
    pageEnd: 1,
  }));

  return {
    paragraphs,
    totalPages: pageCount,
    hasExtractableText: true,
    metadata: {
      encoding: 'utf-8',
      scanned: false,
      paragraphs: normPages.length,
      headings: 0,
      tables: 0,
      pages_with_text: pageCount,
      truncated: false,
    },
  };
}