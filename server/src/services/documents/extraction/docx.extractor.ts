/**
 * services/documents/extraction/docx.extractor.ts
 * ------------------------------------------------
 * Structured DOCX extraction (Milestone 5, Corrective Patch 2).
 *
 * Pipeline:
 *   1. Bounded ZIP inspection (`inspectDocxZip`) before any decompression.
 *   2. `mammoth.convertToHtml` to obtain structural HTML (headings, paragraphs,
 *      tables, lists). Mammoth escapes document text; it never emits
 *      executable content.
 *   3. A small, deterministic HTML reader that understands only a fixed set
 *      of structural tags. Unknown tags are ignored and no external resource
 *      is ever fetched or executed.
 *   4. A heading-stack pass assigns `heading`, `sectionPath`, and
 *      `headingLevel` to every block.
 *
 * Representation:
 *   - headings   → blockType 'heading', headingLevel 1–6
 *   - paragraphs → blockType 'paragraph'
 *   - tables     → one 'table-row' block per row, cells joined with ` | `
 *   - lists      → blockType 'list-item'
 *   - every block keeps document order and zero-based `index`
 *
 * DOCX has no reliable page numbers. `pageStart` / `pageEnd` are always null;
 * citations must use headings/sections/paragraph references instead.
 */

import type { DocumentsConfig } from '../../../config/documents.config.js';
import type { DocumentExtractionMetadata } from '../../../../../shared/types.js';
import type { RawExtraction, RawParagraph } from './index.js';
import { inspectDocxZip } from '../docx.zip.js';
import mammoth from 'mammoth';

interface ParsedBlock {
  type: 'heading' | 'paragraph' | 'table-row' | 'list-item';
  text: string;
  level?: number;
  tableIndex?: number;
  rowIndex?: number;
}

interface HeadingFrame {
  level: number;
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode the small entity set Mammoth emits; unknown entities stay literal. */
function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, code: string) => {
    if (code.startsWith('#')) {
      const isHex = code[1]?.toLowerCase() === 'x';
      const digits = isHex ? code.slice(2) : code.slice(1);
      const value = Number.parseInt(digits, isHex ? 16 : 10);
      if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
        try {
          return String.fromCodePoint(value);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * Parse Mammoth's structural HTML into ordered blocks.
 *
 * SECURITY: this is not a general-purpose HTML engine. Only the tags listed
 * below are interpreted; attributes, scripts, styles, links and images are
 * ignored, and nothing is fetched or executed.
 */
function parseDocxHtml(html: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];

  let headingLevel: number | null = null;
  let headingText = '';
  let paragraphText = '';
  let listItemText = '';
  let inListItem = false;

  let tableDepth = 0;
  let tableCount = 0;
  let currentTableIndex: number | null = null;
  let rowCells: string[] | null = null;
  let tableRows: string[][] = [];
  let cellText = '';
  let inCell = false;

  function appendText(raw: string): void {
    if (!raw) return;
    // Outside a cell inside a table: whitespace only, ignore.
    if (tableDepth > 0 && !inCell) return;

    const decoded = decodeHtmlEntities(raw);
    if (inCell) {
      cellText += decoded;
      return;
    }
    if (headingLevel !== null) {
      headingText += decoded;
      return;
    }
    if (inListItem) {
      listItemText += decoded;
      return;
    }
    paragraphText += decoded;
  }

  function flushHeading(): void {
    if (headingLevel === null) return;
    const text = normalizeText(headingText);
    if (text) blocks.push({ type: 'heading', text, level: headingLevel });
    headingLevel = null;
    headingText = '';
  }

  function flushParagraph(): void {
    const text = normalizeText(paragraphText);
    if (text) blocks.push({ type: 'paragraph', text });
    paragraphText = '';
  }

  function flushListItem(): void {
    if (!inListItem) return;
    const text = normalizeText(listItemText);
    if (text) blocks.push({ type: 'list-item', text });
    listItemText = '';
    inListItem = false;
  }

  function flushTextBlock(): void {
    if (headingLevel !== null) {
      flushHeading();
    } else if (inListItem) {
      flushListItem();
    } else {
      flushParagraph();
    }
  }

  function flushCell(): void {
    if (!inCell) return;
    if (rowCells) rowCells.push(normalizeText(cellText));
    cellText = '';
    inCell = false;
  }

  function flushRow(): void {
    if (!rowCells) return;
    if (rowCells.some((cell) => cell.length > 0)) tableRows.push(rowCells);
    rowCells = null;
  }

  const tokens = html.match(/<[^>]*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      appendText(token);
      continue;
    }

    const isEndTag = token.startsWith('</');
    const nameMatch = /^<\/?\s*([a-zA-Z0-9]+)/.exec(token);
    const tag = nameMatch?.[1]?.toLowerCase();
    if (!tag) continue;

    if (isEndTag) {
      switch (tag) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          flushHeading();
          break;
        case 'p':
          if (inCell) {
            // Inner cell paragraph; keep the text in the cell buffer.
            if (cellText && !/\s$/.test(cellText)) cellText += ' ';
          } else if (!inListItem) {
            flushParagraph();
          }
          break;
        case 'td':
        case 'th':
          if (tableDepth === 1) flushCell();
          break;
        case 'tr':
          if (tableDepth === 1) flushRow();
          break;
        case 'table': {
          if (tableDepth === 1) {
            flushRow();
            for (let rowIndex = 0; rowIndex < tableRows.length; rowIndex += 1) {
              const row = tableRows[rowIndex];
              if (!row) continue;
              blocks.push({
                type: 'table-row',
                text: row.join(' | '),
                ...(currentTableIndex !== null ? { tableIndex: currentTableIndex } : {}),
                rowIndex,
              });
            }
            tableRows = [];
            currentTableIndex = null;
          }
          tableDepth = Math.max(0, tableDepth - 1);
          break;
        }
        case 'li':
          flushListItem();
          break;
        case 'ul':
        case 'ol':
          flushTextBlock();
          break;
        default:
          break;
      }
      continue;
    }

    // Start tags.
    const headingMatch = /^h([1-6])$/.exec(tag);
    if (headingMatch) {
      flushTextBlock();
      headingLevel = Number(headingMatch[1]);
      headingText = '';
      continue;
    }

    switch (tag) {
      case 'p':
        // A paragraph inside a list item is the list item's own text; do not
        // flush the surrounding list context.
        if (!inCell && !inListItem) flushTextBlock();
        break;
      case 'table':
        flushTextBlock();
        tableDepth += 1;
        if (tableDepth === 1) {
          currentTableIndex = tableCount;
          tableCount += 1;
          tableRows = [];
          rowCells = null;
        }
        break;
      case 'tr':
        if (tableDepth === 1) {
          flushRow();
          rowCells = [];
        }
        break;
      case 'td':
      case 'th':
        if (tableDepth === 1) {
          inCell = true;
          cellText = '';
        }
        break;
      case 'li':
        if (tableDepth === 0) {
          flushTextBlock();
          inListItem = true;
          listItemText = '';
        }
        break;
      case 'ul':
      case 'ol':
        flushTextBlock();
        break;
      case 'br':
        appendText(' ');
        break;
      default:
        break;
    }
  }

  flushTextBlock();
  flushRow();

  return blocks;
}

/**
 * Assign heading/section provenance and convert blocks to the shared
 * `RawParagraph` representation. Page fields stay null: DOCX has no stable
 * page numbers, and inventing them is forbidden.
 */
function toRawParagraphs(blocks: ParsedBlock[]): RawParagraph[] {
  const stack: HeadingFrame[] = [];
  const paragraphs: RawParagraph[] = [];

  let currentHeading: string | null = null;
  let currentSectionPath: string | null = null;

  for (const block of blocks) {
    if (block.type === 'heading' && typeof block.level === 'number') {
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= block.level) {
        stack.pop();
      }
      stack.push({ level: block.level, text: block.text });

      currentHeading = block.text;
      currentSectionPath = stack.map((frame) => frame.text).join(' > ');

      paragraphs.push({
        text: block.text,
        pageStart: null,
        pageEnd: null,
        heading: currentHeading,
        sectionPath: currentSectionPath,
        blockType: 'heading',
        headingLevel: block.level,
        tableIndex: null,
        tableRowIndex: null,
      });
      continue;
    }

    paragraphs.push({
      text: block.text,
      pageStart: null,
      pageEnd: null,
      heading: currentHeading,
      sectionPath: currentSectionPath,
      blockType: block.type,
      headingLevel: null,
      tableIndex: block.tableIndex ?? null,
      tableRowIndex: block.rowIndex ?? null,
    });
  }

  return paragraphs;
}

export async function extractDocx(
  bytes: Buffer,
  config: DocumentsConfig,
): Promise<RawExtraction> {
  // Enforce ZIP limits before Mammoth is allowed to inflate anything.
  inspectDocxZip(bytes, config);

  let html: string;
  try {
    const converted = await mammoth.convertToHtml({ buffer: bytes });
    html = converted.value ?? '';
  } catch (err) {
    throw new Error(`Failed to parse DOCX: ${(err as Error).message}`);
  }

  const blocks = parseDocxHtml(html);
  const paragraphs = toRawParagraphs(blocks);

  const headingCount = blocks.filter((block) => block.type === 'heading').length;
  const tableCount = blocks.reduce((max, block) => {
    if (typeof block.tableIndex !== 'number') return max;
    return Math.max(max, block.tableIndex + 1);
  }, 0);

  const metadata: DocumentExtractionMetadata = {
    encoding: 'utf-8',
    scanned: false,
    paragraphs: paragraphs.length,
    headings: headingCount,
    tables: tableCount,
    pages_with_text: 0,
    truncated: false,
  };

  if (paragraphs.length === 0) {
    return {
      paragraphs: [],
      totalPages: null,
      hasExtractableText: false,
      metadata,
    };
  }

  return {
    paragraphs,
    totalPages: null,
    hasExtractableText: true,
    metadata,
  };
}
