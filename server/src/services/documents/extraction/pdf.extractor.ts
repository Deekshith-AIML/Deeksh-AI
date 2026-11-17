/**
 * services/documents/extraction/pdf.extractor.ts
 * -----------------------------------------
 * PDF extraction using pdfjs-dist legacy build.
 *
 * Rules (from M5 plan):
 * - PDF must pass magic-byte validation (%PDF- + %%EOF near end).
 * - PDF pages are tracked 1..N via pdfjsLib.getDocument/getPage.
 * - Every paragraph carries the real page it came from; page numbers are
 *   never hardcoded or inferred from the page count.
 * - A paragraph that visibly continues across a page break is stitched
 *   onto the next page and keeps `pageStart` / `pageEnd` covering both
 *   pages. Stitching is conservative: the previous paragraph must be
 *   unfinished (no terminal punctuation) and the next must start in
 *   lowercase, so headings are never merged.
 * - If total extractable characters across all pages is below
 *   config.minExtractableChars, the PDF is treated as scanned and fails
 *   with `SCANNED_PDF_REQUIRES_OCR` (no OCR implemented).
 * - Text extracted via page.getTextContent().items → positioned lines →
 *   paragraphs. Empty pages contribute no paragraphs.
 */
import type { DocumentsConfig } from '../../../config/documents.config.js';
import type { DocumentExtractionMetadata } from '../../../../../shared/types.js';
import type { RawExtraction, RawParagraph } from './index.js';

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const pdfDocApi: any = pdfjsLib;

/** A single positioned text run from pdfjs. */
interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One visual line after grouping runs that share a baseline. */
interface TextLine {
  text: string;
  y: number;
  height: number;
}

/** Terminal punctuation that marks a paragraph as complete. */
const TERMINAL_PUNCTUATION = /[.!?:;]["')\]]?$/;

/** Continuation paragraphs must begin in lowercase or punctuation. */
const CONTINUATION_START = /^[a-z,;)\]]/;

/**
 * Convert pdfjs text items into positioned runs, dropping empty strings.
 * Coordinates come from the item transform matrix: [a b c d e f] where
 * `e` is x and `f` is the baseline y (PDF origin is bottom-left).
 */
function toPositionedItems(items: unknown[]): PositionedItem[] {
  const positioned: PositionedItem[] = [];

  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const str = typeof record.str === 'string' ? record.str : '';
    if (!str) continue;

    const transform = Array.isArray(record.transform) ? record.transform : [];
    const rawX = transform[4];
    const rawY = transform[5];
    const x = typeof rawX === 'number' ? rawX : 0;
    const y = typeof rawY === 'number' ? rawY : 0;
    const width = typeof record.width === 'number' ? record.width : 0;
    const rawHeight = record.height;
    const height =
      typeof rawHeight === 'number' && rawHeight > 0 ? rawHeight : 12;

    positioned.push({ str, x, y, width, height });
  }

  return positioned;
}

/**
 * Group runs that share a baseline into visual lines, ordered top-to-bottom
 * and left-to-right. Joins runs with a space only when there is a real
 * horizontal gap, so split glyphs stay intact.
 */
function groupLines(items: PositionedItem[]): TextLine[] {
  const rows: Array<{ y: number; height: number; items: PositionedItem[] }> = [];

  for (const item of items) {
    const row = rows.find(
      (candidate) => Math.abs(candidate.y - item.y) <= Math.max(2, candidate.height * 0.25),
    );
    if (row) {
      row.items.push(item);
      row.height = Math.max(row.height, item.height);
    } else {
      rows.push({ y: item.y, height: item.height, items: [item] });
    }
  }

  // PDF y grows upward, so larger y is higher on the page.
  rows.sort((a, b) => b.y - a.y);

  return rows
    .map((row) => {
      const sorted = row.items.slice().sort((a, b) => a.x - b.x);
      let text = '';
      let previousEnd: number | null = null;

      for (const item of sorted) {
        if (previousEnd !== null) {
          const gap = item.x - previousEnd;
          if (gap > 1 && !/\s$/.test(text)) text += ' ';
        }
        text += item.str;
        previousEnd = item.x + item.width;
      }

      return {
        text: text.replace(/\s+/g, ' ').trim(),
        y: row.y,
        height: row.height,
      };
    })
    .filter((line) => line.text.length > 0);
}

/**
 * Group visual lines into paragraphs using vertical gaps. Lines closer than
 * ~1.6 line-heights belong to the same paragraph; larger gaps start a new
 * one. This preserves paragraph boundaries where the source PDF has them.
 */
function linesToParagraphs(lines: TextLine[]): string[] {
  const paragraphs: string[] = [];
  let current = '';
  let previous: TextLine | null = null;

  for (const line of lines) {
    if (previous) {
      const verticalGap = previous.y - line.y;
      const threshold = Math.max(previous.height, line.height) * 1.6;
      if (verticalGap > threshold) {
        if (current) paragraphs.push(current);
        current = '';
      }
    }

    current = current ? `${current} ${line.text}` : line.text;
    previous = line;
  }

  if (current) paragraphs.push(current);
  return paragraphs;
}

/**
 * Decide whether the first paragraph of a page is a continuation of the last
 * paragraph on the previous page. Deliberately conservative: only an
 * unfinished previous paragraph followed by lowercase text qualifies, so a
 * heading at the top of a page can never absorb the previous page's tail.
 */
function continuesAcrossPages(previousText: string, nextText: string): boolean {
  const previous = previousText.trim();
  const next = nextText.trim();

  if (!previous || !next) return false;
  if (TERMINAL_PUNCTUATION.test(previous)) return false;
  return CONTINUATION_START.test(next);
}

/**
 * Flatten per-page paragraphs into a single ordered list, stitching true
 * page-spanning continuations and assigning real page provenance. A stitched
 * paragraph keeps `pageStart` from the page it began on and `pageEnd` from
 * the page it finished on.
 */
function buildParagraphs(pages: string[][]): RawParagraph[] {
  const paragraphs: RawParagraph[] = [];

  pages.forEach((pageParagraphs, pageIndex) => {
    const pageNumber = pageIndex + 1;

    pageParagraphs.forEach((text, paragraphIndex) => {
      const previous = paragraphs[paragraphs.length - 1];

      if (previous && paragraphIndex === 0 && continuesAcrossPages(previous.text, text)) {
        previous.text = `${previous.text} ${text}`.replace(/\s+/g, ' ').trim();
        previous.pageEnd = pageNumber;
        return;
      }

      paragraphs.push({
        text,
        pageStart: pageNumber,
        pageEnd: pageNumber,
      });
    });
  });

  return paragraphs;
}

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

  // Extract text from every page, preserving page order and page numbers.
  const pageParagraphs: string[][] = [];
  let totalExtractableChars = 0;
  let pagesWithText = 0;

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const items = Array.isArray(textContent.items) ? textContent.items : [];

    const lines = groupLines(toPositionedItems(items));
    const paragraphs = linesToParagraphs(lines);

    pageParagraphs.push(paragraphs);

    const pageText = paragraphs.join(' ').trim();
    totalExtractableChars += pageText.length;
    if (pageText.length > 0) pagesWithText += 1;
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
        pages_with_text: pagesWithText,
        truncated: false,
      },
    };
  }

  const paragraphs = buildParagraphs(pageParagraphs);

  return {
    paragraphs,
    totalPages: pageCount,
    hasExtractableText: true,
    metadata: {
      encoding: 'utf-8',
      scanned: false,
      paragraphs: paragraphs.length,
      headings: 0,
      tables: 0,
      pages_with_text: pagesWithText,
      truncated: false,
    },
  };
}
