'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Upload,
  FileText,
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
} from 'lucide-react';
import { useDocumentStore } from '@/store/useDocumentStore';
import type { KnowledgeDocument, DocumentExtension, DocumentStatus } from '@/types';

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
    loading,
    uploading,
    uploadProgress,
    error,
    fetchDocuments,
    uploadDocument,
    deleteDocument,
    retryDocument,
    viewDocument,
    clearError,
  } = useDocumentStore();

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<DocumentExtension | ''>('');
  const [statusFilter, setStatusFilter] = useState<DocumentStatus | ''>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadDocument(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFilter = () => {
    fetchDocuments({
      q: query || undefined,
      type: typeFilter || undefined,
      status: statusFilter || undefined,
    });
  };

  const handleView = async (id: string) => {
    const view = await viewDocument(id);
    if (view?.url) {
      window.open(view.url, '_blank', 'noopener,noreferrer');
    }
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

      {/* Search + filters */}
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search documents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleFilter()}
            className="w-full rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm focus:border-slate-400 focus:outline-none"
          />
        </div>
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
          onClick={handleFilter}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
        >
          <Filter className="h-4 w-4" />
        </button>
      </div>

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
