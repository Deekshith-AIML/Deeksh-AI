/**
 * services/documents/extraction/normalize.ts
 * ------------------------------------------
 * Whitespace normalisation + paragraph provenance stitching.
 *
 * Rules (applied to every format uniformly):
 * - collapse internal whitespace runs to single spaces
 * - preserve paragraph boundaries (blank line between paragraphs)
 * - keep table cell separators as ` | `
 * - strip leading/trailing whitespace per paragraph
 * - recompute character offsets into the final concatenated text
 * - drop empty paragraphs
 */

import type { DocumentsConfig } from '../../../config/documents.config.js';
import type { ParagraphProvenance, RawParagraph } from './index.js';

interface InputParagraph {
  text: string;
  pageStart?: number | null;
  pageEnd?: number | null;
  heading?: string | null;
  sectionPath?: string | null;
  blockType?: RawParagraph['blockType'];
  headingLevel?: number | null;
  tableIndex?: number | null;
  tableRowIndex?: number | null;
}

export interface NormalizedParagraph {
  text: string;
  provenance: ParagraphProvenance;
  tokenEstimate: number;
}

/** Collapse whitespace within a single line; preserve newlines. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .trim();
}

/**
 * Merge adjacent lines of a paragraph into one line (paragraphs are
 * separated by blank lines), while preserving table cell separators.
 */
export function joinParagraphLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join(' ');
}

/**
 * Validate and propagate a page range. Page numbers are never fabricated:
 * missing or non-positive values become null, and an inverted range is
 * ordered rather than silently trusted. A one-sided range is treated as a
 * single page (the page that was actually recorded).
 */
function normalizePageRange(
  pageStart?: number | null,
  pageEnd?: number | null,
): { pageStart: number | null; pageEnd: number | null } {
  const start =
    typeof pageStart === 'number' && Number.isFinite(pageStart) && pageStart > 0
      ? Math.trunc(pageStart)
      : null;
  const end =
    typeof pageEnd === 'number' && Number.isFinite(pageEnd) && pageEnd > 0
      ? Math.trunc(pageEnd)
      : null;

  if (start === null && end === null) {
    return { pageStart: null, pageEnd: null };
  }
  if (start === null) {
    return { pageStart: end, pageEnd: end };
  }
  if (end === null) {
    return { pageStart: start, pageEnd: start };
  }

  return {
    pageStart: Math.min(start, end),
    pageEnd: Math.max(start, end),
  };
}

export function normalizeParagraphs(
  paragraphs: RawParagraph[],
  _config: DocumentsConfig,
): NormalizedParagraph[] {
  const out: NormalizedParagraph[] = [];
  let cursor = 0;

  for (const p of paragraphs) {
    const text = joinParagraphLines(p.text);
    if (!text) continue;

    const tokenEstimate = Math.max(1, Math.ceil(text.length / 4));
    const pageRange = normalizePageRange(p.pageStart, p.pageEnd);

    out.push({
      text,
      provenance: {
        index: out.length,
        pageStart: pageRange.pageStart,
        pageEnd: pageRange.pageEnd,
        heading: p.heading ?? null,
        sectionPath: p.sectionPath ?? null,
        charStart: cursor,
        charEnd: cursor + text.length,
        ...(p.blockType ? { blockType: p.blockType } : {}),
        ...(p.headingLevel !== undefined ? { headingLevel: p.headingLevel } : {}),
        ...(p.tableIndex !== undefined ? { tableIndex: p.tableIndex } : {}),
        ...(p.tableRowIndex !== undefined ? { tableRowIndex: p.tableRowIndex } : {}),
      },
      tokenEstimate,
    });

    cursor += text.length + 2; // +2 for the "\n\n" separator
  }

  return out;
}