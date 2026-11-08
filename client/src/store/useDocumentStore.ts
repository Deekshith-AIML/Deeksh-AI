/**
 * client/src/store/useDocumentStore.ts
 * ------------------------------------
 * Zustand store for the Knowledge Base (Milestone 5).
 *
 * Manages document list, upload, rename, delete, retry, view, chunks,
 * and semantic search. All calls go through the authenticated Axios
 * instance (token attached by the interceptor).
 */

'use client';

import { create } from 'zustand';
import api from '@/lib/api';
import type {
  KnowledgeDocument,
  DocumentChunkPreview,
  DocumentDetailsResponse,
  DocumentListResponse,
  DocumentSearchResponse,
  DocumentViewResponse,
  DocumentUploadResponse,
} from '@/types';

interface DocumentState {
  documents: KnowledgeDocument[];
  selectedIds: string[];
  loading: boolean;
  uploading: boolean;
  uploadProgress: number;
  error: string | null;

  fetchDocuments: (filters?: { q?: string; type?: string; status?: string }) => Promise<void>;
  uploadDocument: (file: File) => Promise<KnowledgeDocument | null>;
  renameDocument: (id: string, name: string) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  retryDocument: (id: string) => Promise<void>;
  viewDocument: (id: string) => Promise<DocumentViewResponse | null>;
  fetchChunks: (id: string) => Promise<DocumentChunkPreview[]>;
  searchDocuments: (query: string, documentIds?: string[]) => Promise<DocumentSearchResponse | null>;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  clearError: () => void;
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  documents: [],
  selectedIds: [],
  loading: false,
  uploading: false,
  uploadProgress: 0,
  error: null,

  fetchDocuments: async (filters = {}) => {
    set({ loading: true, error: null });
    try {
      const params = new URLSearchParams();
      if (filters.q) params.set('q', filters.q);
      if (filters.type) params.set('type', filters.type);
      if (filters.status) params.set('status', filters.status);
      const { data } = await api.get<DocumentListResponse>(`/documents?${params.toString()}`);
      set({ documents: data.documents, loading: false });
    } catch (err: any) {
      set({ error: err?.response?.data?.error ?? 'Failed to load documents', loading: false });
    }
  },

  uploadDocument: async (file: File) => {
    set({ uploading: true, uploadProgress: 0, error: null });
    try {
      const formData = new FormData();
      formData.append('file', file);
      const { data } = await api.post<DocumentUploadResponse>('/documents', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => {
          if (e.total) {
            set({ uploadProgress: Math.round((e.loaded * 100) / e.total) });
          }
        },
      });
      set((state) => ({
        documents: [data.document, ...state.documents],
        uploading: false,
        uploadProgress: 100,
      }));
      return data.document;
    } catch (err: any) {
      set({ error: err?.response?.data?.error ?? 'Upload failed', uploading: false });
      return null;
    }
  },

  renameDocument: async (id: string, name: string) => {
    try {
      const { data } = await api.patch<{ document: KnowledgeDocument }>(`/documents/${id}`, {
        original_filename: name,
      });
      set((state) => ({
        documents: state.documents.map((d) => (d.id === id ? data.document : d)),
      }));
    } catch (err: any) {
      set({ error: err?.response?.data?.error ?? 'Rename failed' });
    }
  },

  deleteDocument: async (id: string) => {
    try {
      await api.delete(`/documents/${id}`);
      set((state) => ({
        documents: state.documents.filter((d) => d.id !== id),
        selectedIds: state.selectedIds.filter((s) => s !== id),
      }));
    } catch (err: any) {
      set({ error: err?.response?.data?.error ?? 'Delete failed' });
    }
  },

  retryDocument: async (id: string) => {
    try {
      const { data } = await api.post<{ document: KnowledgeDocument }>(`/documents/${id}/retry`);
      set((state) => ({
        documents: state.documents.map((d) => (d.id === id ? data.document : d)),
      }));
    } catch (err: any) {
      set({ error: err?.response?.data?.error ?? 'Retry failed' });
    }
  },

  viewDocument: async (id: string) => {
    try {
      const { data } = await api.get<DocumentViewResponse>(`/documents/${id}/view`);
      return data;
    } catch (err: any) {
      set({ error: err?.response?.data?.error ?? 'View failed' });
      return null;
    }
  },

  fetchChunks: async (id: string) => {
    try {
      const { data } = await api.get<{ chunks: DocumentChunkPreview[] }>(`/documents/${id}/chunks`);
      return data.chunks;
    } catch (err: any) {
      set({ error: err?.response?.data?.error ?? 'Failed to load chunks' });
      return [];
    }
  },

  searchDocuments: async (query: string, documentIds?: string[]) => {
    try {
      const { data } = await api.post<DocumentSearchResponse>('/documents/search', {
        query,
        document_ids: documentIds,
      });
      return data;
    } catch (err: any) {
      set({ error: err?.response?.data?.error ?? 'Search failed' });
      return null;
    }
  },

  toggleSelection: (id: string) => {
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds.filter((s) => s !== id)
        : [...state.selectedIds, id],
    }));
  },

  clearSelection: () => set({ selectedIds: [] }),

  clearError: () => set({ error: null }),
}));
