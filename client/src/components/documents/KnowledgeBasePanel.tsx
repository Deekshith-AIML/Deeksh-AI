'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload,
  Trash2,
  RefreshCw,
  Search,
  Filter,
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Eye,
  ChevronRight,
} from 'lucide-react';
import { useDocumentStore } from '@/store/useDocumentStore';
import { buildDocumentCitationHref } from '../../../../shared/citation-link';
import type {
  DocumentExtension,
  DocumentStatus,
  DocumentSearchHit,
} from '@/types';

const STATUS_COLORS: Record<DocumentStatus, string> = {
  uploaded: 'bg-slate-100 text-slate-700',
  pending: 'bg-amber-100 text-amber-700',
  processing: 'bg-blue-100 text-blue-700',
  ready: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  deleting: 'bg-slate-200 text-slate-600',
  deleted: 'bg-slate-200 text-slate-600',
};

const EXT_ICONS: Record<DocumentExtension, string> = {
  pdf: '📄',
  docx: '📝',
  txt: '📃',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[status]}`}>
      {status === 'processing' && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === 'ready' && <CheckCircle2 className="h-3 w-3" />}
      {status === 'failed' && <AlertCircle className="h-3 w-3" />}
      {status === 'pending' && <Clock className="h-3 w-3" />}
      {status}
    </span>
  );
}

export function KnowledgeBasePanel() {
  const {
    documents,
    selectedIds,
    loading,
    uploading,
    uploadProgress,
    error,
    fetchDocuments,
    uploadDocument,
    deleteDocument,
    retryDocument,
    searchDocuments,
    toggleSelection,
    clearSelection,
    clearError,
  } = useDocumentStore();

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<DocumentExtension | ''>('');
  const [statusFilter, setStatusFilter] = useState<DocumentStatus | ''>('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<DocumentSearchHit[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const groupedResults = useMemo(() => {
    const groups = new Map<
      string,
      { documentId: string; filename: string; hits: DocumentSearchHit[] }
    >();
    for (const hit of searchResults) {
      const existing = groups.get(hit.document_id);
      if (existing) {
        existing.hits.push(hit);
      } else {
        groups.set(hit.document_id, {
          documentId: hit.document_id,
          filename: hit.filename,
          hits: [hit],
        });
      }
    }
    return Array.from(groups.values());
  }, [searchResults]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadDocument(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFilter = () => {
    // The text box drives semantic search; these selects filter the list.
    fetchDocuments({
      type: typeFilter || undefined,
      status: statusFilter || undefined,
    });
  };

  const handleSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchError('Enter a question or keyword to search inside your documents.');
      return;
    }

    setSearching(true);
    setSearchError(null);
    setHasSearched(false);

    const result = await searchDocuments(
      trimmed,
      selectedIds.length > 0 ? selectedIds : undefined,
    );

    if (result) {
      setSearchResults(result.chunks);
      setHasSearched(true);
    } else {
      // `searchDocuments` stores the server message in the shared store.
      setSearchResults([]);
      setSearchError(useDocumentStore.getState().error ?? 'Search failed.');
      clearError();
    }
    setSearching(false);
  };

  const handleView = (id: string) => {
    // The viewer route fetches bytes with the bearer token; opening the raw
    // `/content` URL or a signed URL directly would lose authentication.
    window.open(`/documents/${id}`, '_blank', 'noopener,noreferrer');
  };

  const openHit = (hit: DocumentSearchHit) => {
    const href = buildDocumentCitationHref({
      document_id: hit.document_id,
      chunk_id: hit.chunk_id,
      page: hit.page_start,
      heading: hit.heading ?? hit.section_path,
    });
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  const formatLocation = (hit: DocumentSearchHit): string => {
    const parts: string[] = [];
    if (hit.page_start !== null) {
      parts.push(
        hit.page_end !== null && hit.page_end !== hit.page_start
          ? `Pages ${hit.page_start}–${hit.page_end}`
          : `Page ${hit.page_start}`,
      );
    }
    if (hit.heading) parts.push(hit.heading);
    else if (hit.section_path) parts.push(hit.section_path);
    if (parts.length === 0) parts.push(`Section ${hit.chunk_index + 1}`);
    return parts.join(' · ');
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Knowledge Base</h2>
        <label className="cursor-pointer rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
          <Upload className="mr-1.5 inline h-4 w-4" />
          Upload
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt"
            className="hidden"
            onChange={handleUpload}
            disabled={uploading}
          />
        </label>
      </div>

      {uploading && (
        <div className="mb-3 rounded-lg bg-slate-50 p-3">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="text-slate-600">Uploading…</span>
            <span className="font-medium text-slate-900">{uploadProgress}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-slate-900 transition-all"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="mb-3 flex items-center justify-between rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <span>{error}</span>
          <button onClick={clearError} className="ml-2 text-red-500 hover:text-red-700">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Semantic search + list filters */}
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search inside documents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleSearch();
              }
            }}
            className="w-full rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm focus:border-slate-400 focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => void handleSearch()}
          disabled={searching}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {searching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          Search
        </button>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as DocumentExtension | '')}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
        >
          <option value="">All types</option>
          <option value="pdf">PDF</option>
          <option value="docx">DOCX</option>
          <option value="txt">TXT</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as DocumentStatus | '')}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
        >
          <option value="">All statuses</option>
          <option value="ready">Ready</option>
          <option value="processing">Processing</option>
          <option value="failed">Failed</option>
        </select>
        <button
          type="button"
          onClick={handleFilter}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
          title="Apply type/status filters to the document list"
          aria-label="Apply document list filters"
        >
          <Filter className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          {selectedIds.length > 0
            ? `Searching ${selectedIds.length} selected document${selectedIds.length === 1 ? '' : 's'}`
            : 'Searching all ready documents'}
        </span>
        {selectedIds.length > 0 && (
          <button
            type="button"
            onClick={clearSelection}
            className="font-medium text-slate-700 underline hover:no-underline"
          >
            Clear selection
          </button>
        )}
      </div>

      {/* Semantic search states */}
      {searching && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          Searching your documents…
        </div>
      )}

      {searchError && (
        <div className="mb-3 flex items-center justify-between rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <span>{searchError}</span>
          <button
            type="button"
            onClick={() => setSearchError(null)}
            className="ml-2 text-red-500 hover:text-red-700"
            aria-label="Dismiss search error"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {hasSearched && !searching && !searchError && (
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Search results</h3>
            <span className="text-xs text-slate-500">
              {searchResults.length} passage{searchResults.length === 1 ? '' : 's'}
            </span>
          </div>

          {groupedResults.length === 0 ? (
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-4 text-sm text-slate-500">
              No matching passages were found. Try a different question, raise the document
              selection, or wait for processing to finish.
            </div>
          ) : (
            <ul className="space-y-2">
              {groupedResults.map((group) => (
                <li
                  key={group.documentId}
                  className="overflow-hidden rounded-lg border border-slate-200 bg-white"
                >
                  <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {group.filename}
                    </p>
                    <span className="shrink-0 text-xs text-slate-500">
                      {group.hits.length} match{group.hits.length === 1 ? '' : 'es'}
                    </span>
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {group.hits.map((hit) => (
                      <li key={hit.chunk_id} className="p-3">
                        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs text-slate-500">
                            {formatLocation(hit)} · {Math.round(hit.similarity * 100)}% match
                          </span>
                          <button
                            type="button"
                            onClick={() => openHit(hit)}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            Open source
                            <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <p className="line-clamp-3 whitespace-pre-wrap text-sm text-slate-700">
                          {hit.preview}
                        </p>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Document list */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      ) : documents.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-500">
          No documents yet. Upload a PDF, DOCX, or TXT file to get started.
        </div>
      ) : (
        <ul className="space-y-2">
          {documents.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center gap-3 rounded-lg border border-slate-100 p-3 hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(doc.id)}
                onChange={() => toggleSelection(doc.id)}
                disabled={
                  doc.status !== 'ready' ||
                  (!selectedIds.includes(doc.id) && selectedIds.length >= 20)
                }
                className="h-4 w-4 shrink-0 rounded border-slate-300 text-slate-900 focus:ring-slate-400 disabled:opacity-40"
                aria-label={`Include ${doc.original_filename} in semantic search`}
                title={
                  doc.status !== 'ready'
                    ? 'Only ready documents can be searched'
                    : selectedIds.length >= 20 && !selectedIds.includes(doc.id)
                      ? 'At most 20 documents can be selected for one search'
                      : 'Include this document in semantic search'
                }
              />
              <span className="text-2xl" aria-hidden="true">
                {EXT_ICONS[doc.extension]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">
                  {doc.original_filename}
                </p>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>{formatBytes(doc.file_size)}</span>
                  <span>·</span>
                  <span>{doc.chunk_count} chunks</span>
                  {doc.page_count && (
                    <>
                      <span>·</span>
                      <span>{doc.page_count} pages</span>
                    </>
                  )}
                </div>
              </div>
              <StatusBadge status={doc.status} />
              <div className="flex items-center gap-1">
                {doc.status === 'ready' && (
                  <button
                    onClick={() => handleView(doc.id)}
                    className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                    title="View"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                )}
                {doc.status === 'failed' && (
                  <button
                    onClick={() => retryDocument(doc.id)}
                    className="rounded p-1.5 text-amber-600 hover:bg-amber-50"
                    title="Retry"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </button>
                )}
                <button
                  onClick={() => deleteDocument(doc.id)}
                  className="rounded p-1.5 text-red-500 hover:bg-red-50"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {documents.length > 0 && (
        <p className="mt-3 text-xs text-slate-400">
          {documents.length} document{documents.length !== 1 ? 's' : ''} · Select documents in chat to ask questions about them.
        </p>
      )}
    </section>
  );
}

export default KnowledgeBasePanel;
