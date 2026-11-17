/**
 * shared/citation-link.ts
 * -----------------------
 * Pure helpers for turning a validated citation source into a document-viewer
 * URL, and for parsing that URL back inside the viewer.
 *
 * The helpers intentionally carry only provenance that actually exists:
 * - PDF chunks have a real 1-based `page` from extraction.
 * - DOCX chunks have a `heading`/section, never a page.
 * - TXT chunks are located by `chunk_id` (the viewer then reads the chunk's
 *   paragraph range from the chunk API).
 *
 * No storage path, signed URL or public bucket URL is ever constructed here.
 */

export interface CitationLinkSource {
  document_id: string;
  chunk_id?: string | null;
  /** Real 1-based PDF page, or null when the source has no page provenance. */
  page?: number | null;
  /** Nearest heading/section title, or null. */
  heading?: string | null;
}

export interface ViewerTarget {
  /** Real 1-based PDF page, or null when no valid page was supplied. */
  page: number | null;
  /** Chunk id used to locate DOCX/TXT provenance. */
  chunkId: string | null;
  /** Heading/section requested by the citation. */
  heading: string | null;
}

function positiveInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function first(value: string | string[] | null | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Build the frontend viewer URL for a citation.
 * Missing page/heading/chunk values are omitted instead of guessed.
 */
export function buildDocumentCitationHref(source: CitationLinkSource): string {
  const params = new URLSearchParams();
  const page = positiveInt(source.page ?? null);
  if (page !== null) params.set('page', String(page));

  const chunkId = source.chunk_id?.trim();
  if (chunkId) params.set('chunk', chunkId);

  const heading = source.heading?.trim();
  if (heading) params.set('heading', heading);

  const query = params.toString();
  return `/documents/${encodeURIComponent(source.document_id)}${query ? `?${query}` : ''}`;
}

/** Parse viewer query parameters defensively (bad values become null). */
export function parseDocumentViewerTarget(input: {
  page?: string | string[] | null;
  chunk?: string | string[] | null;
  heading?: string | string[] | null;
}): ViewerTarget {
  const chunk = first(input.chunk);
  const heading = first(input.heading);
  return {
    page: positiveInt(first(input.page)),
    chunkId: chunk && chunk.trim() ? chunk.trim() : null,
    heading: heading && heading.trim() ? heading.trim() : null,
  };
}

/**
 * PDF viewer fragment. Browsers honour `#page=N`; when the page is unknown
 * we return an empty fragment rather than inventing page 1.
 */
export function pdfPageFragment(page: number | null): string {
  const parsed = positiveInt(page);
  return parsed !== null ? `#page=${parsed}` : '';
}
