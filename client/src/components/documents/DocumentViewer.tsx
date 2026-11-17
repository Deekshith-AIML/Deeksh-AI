/**
 * client/src/components/documents/DocumentViewer.tsx
 * --------------------------------------------------
 * Citation-aware document viewer.
 *
 * - PDF: renders the private document bytes in the browser PDF viewer and
 *   appends `#page=N` only when extraction recorded a real page.
 * - DOCX: never invents pages; it shows the cited heading/section and the
 *   matching extracted chunk, scrolled into view.
 * - TXT: resolves the cited chunk and displays its paragraph and line range
 *   plus the highlighted excerpt.
 *
 * SECURITY: bytes are fetched through the authenticated backend content
 * route with the user's bearer token. No storage path or public bucket URL
 * is ever used by this component.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowLeft,
  Download,
  ExternalLink,
  FileText,
  Loader2,
} from 'lucide-react';
import api from '@/lib/api';
import { pdfPageFragment, type ViewerTarget } from '../../../../shared/citation-link';
import type {
  DocumentChunkPreview,
  DocumentDetailsResponse,
  DocumentViewResponse,
} from '@/types';

interface DocumentViewerProps {
  documentId: string;
  target: ViewerTarget;
}

interface ViewerData {
  details: DocumentDetailsResponse;
  view: DocumentViewResponse;
  chunks: DocumentChunkPreview[];
  objectUrl: string;
  text: string | null;
}

/** Clamp a character offset into the loaded text. */
function clampOffset(value: number, length: number): number {
  return Math.min(Math.max(value, 0), length);
}

/** 1-based line number for a character offset. */
function lineNumberAt(text: string, offset: number): number {
  return text.slice(0, clampOffset(offset, text.length)).split('\n').length;
}

/** Paragraph label from zero-based extraction provenance. */
function paragraphLabel(chunk: DocumentChunkPreview): string | null {
  if (chunk.paragraph_start === null) return null;
  const start = chunk.paragraph_start + 1;
  const end =
    chunk.paragraph_end !== null && chunk.paragraph_end !== chunk.paragraph_start
      ? chunk.paragraph_end + 1
      : null;
  return end ? `Paragraphs ${start}–${end}` : `Paragraph ${start}`;
}

/** Line label computed from real character offsets when available. */
function lineLabel(chunk: DocumentChunkPreview, text: string | null): string | null {
  if (!text || chunk.char_start === null) return null;
  const start = lineNumberAt(text, chunk.char_start);
  const end =
    chunk.char_end === null
      ? start
      : lineNumberAt(text, Math.max(chunk.char_start, chunk.char_end - 1));
  return end > start ? `Lines ${start}–${end}` : `Line ${start}`;
}

/** Find the cited chunk by id, then by heading, then fall back to the start. */
function resolveActiveChunk(
  chunks: DocumentChunkPreview[],
  target: ViewerTarget,
): { chunk: DocumentChunkPreview | null; matched: boolean } {
  if (target.chunkId) {
    const exact = chunks.find((chunk) => chunk.id === target.chunkId);
    if (exact) return { chunk: exact, matched: true };
  }
  if (target.heading) {
    const heading = target.heading;
    const byHeading = chunks.find(
      (chunk) =>
        chunk.heading === heading ||
        chunk.section_path === heading ||
        chunk.section_path?.includes(heading) === true,
    );
    if (byHeading) return { chunk: byHeading, matched: true };
  }
  return { chunk: chunks[0] ?? null, matched: false };
}

/** Small location badge shared by the three renderers. */
function LocationBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">
      {children}
    </span>
  );
}

function DownloadActions({
  objectUrl,
  filename,
}: {
  objectUrl: string;
  filename: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a
        href={objectUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
      >
        <ExternalLink className="h-4 w-4" />
        Open original
      </a>
      <a
        href={objectUrl}
        download={filename}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        <Download className="h-4 w-4" />
        Download
      </a>
    </div>
  );
}

export function DocumentViewer({ documentId, target }: DocumentViewerProps) {
  const [data, setData] = useState<ViewerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeChunkRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setLoading(true);
    setError(null);
    setData(null);

    async function load() {
      try {
        // `/view` verifies ownership + status before any bytes are read.
        const [detailsRes, viewRes, chunksRes] = await Promise.all([
          api.get<DocumentDetailsResponse>(`/documents/${documentId}`),
          api.get<DocumentViewResponse>(`/documents/${documentId}/view`),
          api.get<{ chunks: DocumentChunkPreview[] }>(`/documents/${documentId}/chunks`),
        ]);

        const contentRes = await api.get<Blob>(`/documents/${documentId}/content`, {
          responseType: 'blob',
        });

        if (cancelled) return;

        const document = detailsRes.data.document;
        const contentType =
          contentRes.headers['content-type'] ??
          (document.mime_type || 'application/octet-stream');
        const blob = new Blob([contentRes.data], { type: String(contentType) });
        objectUrl = URL.createObjectURL(blob);
        const text = document.extension === 'txt' ? await blob.text() : null;

        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        setData({
          details: detailsRes.data,
          view: viewRes.data,
          chunks: chunksRes.data.chunks ?? [],
          objectUrl,
          text,
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'This document could not be opened.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [documentId]);

  const active = useMemo(
    () => (data ? resolveActiveChunk(data.chunks, target) : { chunk: null, matched: false }),
    [data, target],
  );

  useEffect(() => {
    if (data && activeChunkRef.current) {
      activeChunkRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [data, active.chunk]);

  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-100">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" />
          Opening document…
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-100 px-4">
        <div className="w-full max-w-md rounded-2xl border border-red-200 bg-white p-6 shadow-sm">
          <div className="mb-3 flex items-center gap-2 text-red-700">
            <AlertCircle className="h-5 w-5" />
            <h1 className="text-lg font-semibold">Document unavailable</h1>
          </div>
          <p className="text-sm text-slate-600">
            {error ?? 'This document could not be opened.'}
          </p>
          <p className="mt-2 text-xs text-slate-400">
            It may have been deleted, may still be processing, or may belong to another
            account.
          </p>
          <Link
            href="/"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to dashboard
          </Link>
        </div>
      </main>
    );
  }

  const document = data.details.document;
  const pageCount = document.page_count ?? data.view.page_count;
  const citedPage = target.page;
  const pageWithinDocument =
    citedPage !== null && (pageCount === null || citedPage <= pageCount);
  const effectivePage = pageWithinDocument ? citedPage : null;
  const pageNotice =
    citedPage === null
      ? 'No page number was recorded for this citation.'
      : !pageWithinDocument
        ? `Cited page ${citedPage} is outside this document (${pageCount} pages).`
        : null;

  const activeChunk = active.chunk;
  const activeIndex = activeChunk ? data.chunks.indexOf(activeChunk) : 0;
  const windowStart = activeChunk ? Math.max(0, activeIndex - 2) : 0;
  const windowEnd = activeChunk ? Math.min(data.chunks.length, activeIndex + 3) : 5;
  const visibleChunks = data.chunks.slice(windowStart, windowEnd);

  return (
    <main className="min-h-dvh bg-slate-100 pb-10">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Link>
          <FileText className="h-5 w-5 text-slate-500" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-slate-900">
              {document.original_filename}
            </h1>
            <p className="text-xs text-slate-500">
              {document.extension.toUpperCase()}
              {pageCount !== null ? ` · ${pageCount} pages` : ''}
              {` · ${data.chunks.length} indexed section${data.chunks.length === 1 ? '' : 's'}`}
            </p>
          </div>
          <DownloadActions objectUrl={data.objectUrl} filename={document.original_filename} />
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 pt-5">
        {target.page === null && document.extension === 'pdf' && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {pageNotice}
          </div>
        )}
        {document.extension === 'pdf' && target.page !== null && !pageWithinDocument && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {pageNotice}
          </div>
        )}

        {document.extension === 'pdf' && (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5 text-xs text-slate-600">
              {effectivePage !== null ? (
                <LocationBadge>Page {effectivePage}</LocationBadge>
              ) : (
                <LocationBadge>Page information unavailable</LocationBadge>
              )}
              <span>PDF pages use the page numbers recorded during extraction.</span>
            </div>
            <iframe
              title={`PDF preview of ${document.original_filename}`}
              src={`${data.objectUrl}${pdfPageFragment(effectivePage)}`}
              className="h-[75vh] w-full bg-slate-50"
            />
          </div>
        )}

        {document.extension === 'docx' && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <LocationBadge>Section citation</LocationBadge>
              {(target.heading ?? activeChunk?.heading) && (
                <span className="text-sm font-medium text-slate-900">
                  {target.heading ?? activeChunk?.heading}
                </span>
              )}
            </div>
            <p className="mb-4 text-xs text-slate-500">
              DOCX files do not carry page numbers. This citation points to the extracted
              heading/section below.
            </p>

            {!active.matched && target.chunkId && data.chunks.length > 0 && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                The cited section could not be matched exactly; showing the start of the
                document.
              </div>
            )}

            {visibleChunks.length === 0 ? (
              <p className="rounded-lg bg-slate-50 px-3 py-4 text-sm text-slate-500">
                No extracted sections are available yet. Open the original file above.
              </p>
            ) : (
              <ul className="space-y-2">
                {visibleChunks.map((chunk) => {
                  const isActive = chunk.id === activeChunk?.id;
                  return (
                    <li
                      key={chunk.id}
                      ref={isActive ? activeChunkRef : undefined}
                      className={`rounded-xl border p-3 ${
                        isActive
                          ? 'border-slate-900 bg-slate-50'
                          : 'border-slate-100 bg-white'
                      }`}
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        {chunk.heading && (
                          <span className="font-semibold text-slate-700">{chunk.heading}</span>
                        )}
                        {chunk.section_path && <span>{chunk.section_path}</span>}
                        {paragraphLabel(chunk) && <span>{paragraphLabel(chunk)}</span>}
                        <span>Section {chunk.chunk_index + 1}</span>
                      </div>
                      <p className="whitespace-pre-wrap text-sm text-slate-700">
                        {chunk.preview}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {document.extension === 'txt' && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <LocationBadge>Text citation</LocationBadge>
              {activeChunk && paragraphLabel(activeChunk) && (
                <span className="text-sm font-medium text-slate-900">
                  {paragraphLabel(activeChunk)}
                </span>
              )}
              {activeChunk && lineLabel(activeChunk, data.text) && (
                <span className="text-sm text-slate-600">
                  {lineLabel(activeChunk, data.text)}
                </span>
              )}
            </div>

            {!active.matched && target.chunkId && data.chunks.length > 0 && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                The cited passage could not be matched exactly; showing the start of the
                document.
              </div>
            )}

            {activeChunk ? (
              <div className="mb-4 rounded-xl border border-slate-900 bg-slate-50 p-3">
                <p className="whitespace-pre-wrap text-sm text-slate-700">
                  {data.text &&
                  activeChunk.char_start !== null &&
                  activeChunk.char_end !== null
                    ? data.text.slice(
                        clampOffset(activeChunk.char_start, data.text.length),
                        clampOffset(activeChunk.char_end, data.text.length),
                      )
                    : activeChunk.preview}
                </p>
              </div>
            ) : (
              <p className="mb-4 rounded-lg bg-slate-50 px-3 py-4 text-sm text-slate-500">
                No extracted passage is available yet. Open the original file above.
              </p>
            )}

            {data.text !== null && (
              <details className="rounded-lg border border-slate-100">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-700">
                  Show full document text
                </summary>
                <div className="max-h-[60vh] overflow-auto border-t border-slate-100 p-3">
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm text-slate-700">
                    {activeChunk &&
                    activeChunk.char_start !== null &&
                    activeChunk.char_end !== null &&
                    activeChunk.char_end > activeChunk.char_start ? (
                      <>
                        {data.text.slice(
                          0,
                          clampOffset(activeChunk.char_start, data.text.length),
                        )}
                        <mark className="rounded bg-amber-200 px-0.5 text-slate-900">
                          {data.text.slice(
                            clampOffset(activeChunk.char_start, data.text.length),
                            clampOffset(activeChunk.char_end, data.text.length),
                          )}
                        </mark>
                        {data.text.slice(
                          clampOffset(activeChunk.char_end, data.text.length),
                        )}
                      </>
                    ) : (
                      data.text
                    )}
                  </pre>
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

export default DocumentViewer;
