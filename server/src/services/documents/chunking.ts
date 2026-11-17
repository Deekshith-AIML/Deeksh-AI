/**
 * services/documents/chunking.ts
 * --------------------------------
 * Structure-aware document chunking (Milestone 5).
 *
 * Strategy (Corrective Patch 2):
 *   1. Every extracted paragraph is first broken into provenance-carrying
 *      pieces that fit the token budget:
 *        - sentence boundaries first
 *        - word boundaries when a single sentence is too large
 *        - a hard character split only for one absurdly long token
 *   2. Pieces are packed in document order into chunks. A chunk never
 *      crosses a heading/section boundary, so unrelated sections are never
 *      blended.
 *   3. A controlled tail overlap is carried into the next chunk, but only
 *      inside the same section and only when there is room left in the
 *      budget. Overlap can never push a chunk past the budget.
 *   4. Every chunk retains full provenance: document id, user id, index,
 *      page range, heading, section path, paragraph range, char offsets and
 *      token estimate. Split pieces keep their original paragraph index and
 *      page range, so chunk provenance points at the real source.
 *
 * Config (env-overridable via documents.config):
 *   chunkTargetTokens    default 900
 *   chunkOverlapTokens    default 120
 *   maxChunksPerDocument  default 2000
 *   maxTextChars          default 2,000,000
 *
 * Token estimate: ceil(chars / 4) — documented approximation.
 */

import type { DocumentsConfig } from '../../config/documents.config.js';
import type { ExtractionResult } from './extraction/index.js';

export interface ChunkProvenance {
  documentId: string;
  userId: string;
  chunkIndex: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  heading: string | null;
  sectionPath: string | null;
  paragraphStart: number;
  paragraphEnd: number;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
}

export interface ChunkingResult {
  chunks: ChunkProvenance[];
  totalChunks: number;
}

/** A bounded fragment of one source paragraph. */
interface Piece {
  text: string;
  paragraphIndex: number;
  charStart: number;
  charEnd: number;
  pageStart: number | null;
  pageEnd: number | null;
  heading: string | null;
  sectionPath: string | null;
}

/**
 * Estimate tokens from character count.
 * Documented approximation: ceil(chars / 4) for Latin text.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Break one paragraph into fragments that each fit `budgetChars`.
 *
 * Granularity is deliberately fine so packing and overlap operate on real
 * units rather than pre-packed chunk-sized blobs:
 *   1. one piece per sentence
 *   2. a sentence longer than the budget is packed at word boundaries
 *   3. a single token longer than the budget is split by characters
 */
function splitParagraphToBudget(text: string, budgetChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= budgetChars) return [trimmed];

  const fragments: string[] = [];

  const splitWordsToBudget = (segment: string): string[] => {
    const words = segment.split(/\s+/).filter((word) => word.length > 0);
    const output: string[] = [];
    let buffer = '';

    const flush = (): void => {
      const value = buffer.trim();
      if (value) output.push(value);
      buffer = '';
    };

    for (const word of words) {
      if (word.length > budgetChars) {
        flush();
        for (let offset = 0; offset < word.length; offset += budgetChars) {
          output.push(word.slice(offset, offset + budgetChars));
        }
        continue;
      }

      const candidate = buffer ? `${buffer} ${word}` : word;
      if (candidate.length <= budgetChars) {
        buffer = candidate;
      } else {
        flush();
        buffer = word;
      }
    }

    flush();
    return output;
  };

  // Split after sentence terminators while keeping the terminator attached.
  const sentences = trimmed.split(/(?<=[.!?])\s+/);

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;

    if (sentence.length <= budgetChars) {
      fragments.push(sentence);
    } else {
      fragments.push(...splitWordsToBudget(sentence));
    }
  }

  // Defensive: the only way this is empty is an all-whitespace input.
  return fragments.length > 0 ? fragments : [trimmed.slice(0, budgetChars)];
}

/**
 * Convert source paragraphs into bounded pieces, preserving provenance.
 * Character offsets are located inside the original paragraph text so a
 * piece's range always maps back to real source characters.
 */
function buildPieces(extraction: ExtractionResult, budgetChars: number): Piece[] {
  const pieces: Piece[] = [];

  for (let paragraphIndex = 0; paragraphIndex < extraction.paragraphs.length; paragraphIndex += 1) {
    const paragraph = extraction.paragraphs[paragraphIndex];
    if (!paragraph) continue;

    const fragments = splitParagraphToBudget(paragraph.text, budgetChars);
    const provenance = paragraph.provenance;

    let searchFrom = 0;
    for (const fragment of fragments) {
      const located = paragraph.text.indexOf(fragment, searchFrom);
      const localStart = located >= 0 ? located : searchFrom;
      const localEnd = localStart + fragment.length;
      searchFrom = localEnd;

      pieces.push({
        text: fragment,
        paragraphIndex,
        charStart: provenance.charStart + localStart,
        charEnd: provenance.charStart + localEnd,
        pageStart: provenance.pageStart,
        pageEnd: provenance.pageEnd,
        heading: provenance.heading,
        sectionPath: provenance.sectionPath,
      });
    }
  }

  return pieces;
}

/** Render a list of pieces into chunk content with sensible separators. */
function renderPieces(pieces: Piece[]): string {
  let content = '';

  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (!piece) continue;

    if (index === 0) {
      content = piece.text;
      continue;
    }

    const previous = pieces[index - 1];
    // Split fragments of the same paragraph join with a space; different
    // paragraphs keep a visible boundary.
    const separator =
      previous && previous.paragraphIndex === piece.paragraphIndex ? ' ' : '\n\n';
    content += separator + piece.text;
  }

  return content;
}

function minPage(pieces: Piece[]): number | null {
  let min: number | null = null;
  for (const piece of pieces) {
    if (piece.pageStart === null) continue;
    min = min === null ? piece.pageStart : Math.min(min, piece.pageStart);
  }
  return min;
}

function maxPage(pieces: Piece[]): number | null {
  let max: number | null = null;
  for (const piece of pieces) {
    const value = piece.pageEnd ?? piece.pageStart;
    if (value === null) continue;
    max = max === null ? value : Math.max(max, value);
  }
  return max;
}

/**
 * Select the trailing pieces of an emitted chunk to carry forward as overlap.
 * Never carries the whole chunk (that would duplicate everything) and never
 * exceeds the overlap budget.
 */
function selectOverlap(pieces: Piece[], overlapChars: number): Piece[] {
  if (overlapChars <= 0 || pieces.length < 2) return [];

  const selected: Piece[] = [];
  let totalChars = 0;

  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index];
    if (!piece) continue;

    const cost = piece.text.length + 2;
    if (selected.length > 0 && totalChars + cost > overlapChars) break;

    selected.unshift(piece);
    totalChars += cost;

    if (totalChars >= overlapChars) break;
  }

  // Never repeat the entire chunk.
  return selected.length === pieces.length ? [] : selected;
}

function sectionKey(heading: string | null, sectionPath: string | null): string {
  return `${heading ?? ''}\u0000${sectionPath ?? ''}`;
}

/**
 * Chunk an extraction result into provenance-aware chunks.
 *
 * @param documentId  The document's UUID.
 * @param userId      The owning user's UUID.
 * @param extraction  The extraction result from Phase 3.
 * @param config      Document configuration (chunk sizes, limits).
 */
export function chunkDocument(
  documentId: string,
  userId: string,
  extraction: ExtractionResult,
  config: DocumentsConfig,
): ChunkingResult {
  const targetTokens = Math.max(1, config.chunkTargetTokens);
  const overlapTokens = Math.max(0, Math.min(config.chunkOverlapTokens, targetTokens - 1));
  const maxChunks = Math.max(0, config.maxChunksPerDocument);

  const targetChars = targetTokens * 4;
  const overlapChars = overlapTokens * 4;

  const pieces = buildPieces(extraction, targetChars);

  const chunks: ChunkProvenance[] = [];
  let pending: Piece[] = [];
  let pendingIsOverlapOnly = false;
  let carry: Piece[] = [];

  let activeSectionKey: string | null = null;
  let activeHeading: string | null = null;
  let activeSectionPath: string | null = null;

  const emitChunk = (): void => {
    if (pending.length === 0) return;
    if (chunks.length >= maxChunks) {
      pending = [];
      carry = [];
      return;
    }

    const content = renderPieces(pending).trim();
    if (!content) {
      pending = [];
      carry = [];
      return;
    }

    let paragraphStart = pending[0]?.paragraphIndex ?? 0;
    let paragraphEnd = paragraphStart;
    let charStart = pending[0]?.charStart ?? 0;
    let charEnd = pending[0]?.charEnd ?? 0;

    for (const piece of pending) {
      paragraphStart = Math.min(paragraphStart, piece.paragraphIndex);
      paragraphEnd = Math.max(paragraphEnd, piece.paragraphIndex);
      charStart = Math.min(charStart, piece.charStart);
      charEnd = Math.max(charEnd, piece.charEnd);
    }

    chunks.push({
      documentId,
      userId,
      chunkIndex: chunks.length,
      content,
      pageStart: minPage(pending),
      pageEnd: maxPage(pending),
      heading: activeHeading,
      sectionPath: activeSectionPath,
      paragraphStart,
      paragraphEnd,
      charStart,
      charEnd,
      tokenEstimate: estimateTokens(content),
    });

    carry = selectOverlap(pending, overlapChars);
    pending = [];
    pendingIsOverlapOnly = false;
  };

  const tryAddPiece = (piece: Piece): void => {
    if (chunks.length >= maxChunks) return;

    if (pending.length === 0) {
      pending.push(piece);
      pendingIsOverlapOnly = false;
      return;
    }

    const candidate = renderPieces([...pending, piece]);
    if (estimateTokens(candidate) <= targetTokens) {
      pending.push(piece);
      pendingIsOverlapOnly = false;
      return;
    }

    if (pendingIsOverlapOnly) {
      // Only overlap is present so far — discard it until the real piece fits.
      while (
        pending.length > 0 &&
        estimateTokens(renderPieces([...pending, piece])) > targetTokens
      ) {
        pending.shift();
      }
      pending.push(piece);
      pendingIsOverlapOnly = false;
      return;
    }

    // A real chunk boundary: emit, then retry with the overlap tail.
    emitChunk();
    pending = carry.slice();
    pendingIsOverlapOnly = pending.length > 0;
    tryAddPiece(piece);
  };

  for (const piece of pieces) {
    if (chunks.length >= maxChunks) break;

    const key = sectionKey(piece.heading, piece.sectionPath);
    if (key !== activeSectionKey) {
      // Section boundary: finish the open chunk and do not carry overlap
      // across unrelated sections.
      emitChunk();
      carry = [];
      pending = [];
      pendingIsOverlapOnly = false;
      activeSectionKey = key;
      activeHeading = piece.heading;
      activeSectionPath = piece.sectionPath;
    }

    tryAddPiece(piece);
  }

  emitChunk();

  return { chunks, totalChunks: chunks.length };
}
