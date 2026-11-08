/**
 * src/store/useMemoryStore.ts
 * ---------------------------
 * Zustand store managing long-term memory state and API calls
 * (Milestone 4).
 *
 * Endpoints used (via the shared Axios instance, which attaches the
 * bearer token automatically):
 *   - GET    /memories             → fetchMemories
 *   - POST   /memories             → createMemory (explicit user action)
 *   - PATCH  /memories/:id         → updateMemory (explicit correction)
 *   - DELETE /memories/:id         → deleteMemory
 *   - POST   /memories/:id/supersede → supersedeMemory (user-confirmed only)
 *   - GET    /memories/settings    → fetchSettings
 *   - PATCH  /memories/settings    → updateSettings (consent controls)
 *
 * SECURITY: no user id is ever sent — identity comes from the bearer token.
 * Sensitive/credential safeguards are enforced server-side; this store only
 * surfaces the resulting errors honestly.
 */

'use client';

import { create } from 'zustand';
import api from '@/lib/api';
import type {
  Memory,
  MemorySettings,
  CreateMemoryInput,
  MemoryListResponse,
  MemorySettingsResponse,
} from '@/types';

interface MemoryFilters {
  q?: string;
  category?: string;
  status?: 'active' | 'needs_review';
}

interface MemoryState {
  memories: Memory[];
  settings: MemorySettings | null;
  isLoading: boolean;
  isMutating: boolean;
  error: string | null;
  successMessage: string | null;

  fetchMemories: (filters?: MemoryFilters) => Promise<void>;
  fetchSettings: () => Promise<void>;
  createMemory: (input: CreateMemoryInput) => Promise<Memory | null>;
  updateMemory: (id: string, patch: Partial<Pick<Memory, 'content' | 'status' | 'sensitivity'>>) => Promise<Memory | null>;
  deleteMemory: (id: string) => Promise<boolean>;
  supersedeMemory: (id: string, newMemoryId: string) => Promise<boolean>;
  updateSettings: (patch: Partial<MemorySettings>) => Promise<void>;
  clearError: () => void;
  clearSuccess: () => void;
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  settings: null,
  isLoading: false,
  isMutating: false,
  error: null,
  successMessage: null,

  fetchMemories: async (filters) => {
    set({ isLoading: true, error: null });
    try {
      const { data } = await api.get<MemoryListResponse>('/memories', {
        params: {
          ...(filters?.q ? { q: filters.q } : {}),
          ...(filters?.category ? { category: filters.category } : {}),
          ...(filters?.status ? { status: filters.status } : {}),
        },
      });
      set({ memories: data.memories, isLoading: false });
    } catch (err) {
      set({ error: messageOf(err, 'Failed to load memories'), isLoading: false });
    }
  },

  fetchSettings: async () => {
    try {
      const { data } = await api.get<MemorySettingsResponse>('/memories/settings');
      set({ settings: data.settings });
    } catch (err) {
      set({ error: messageOf(err, 'Failed to load memory settings') });
    }
  },

  createMemory: async (input) => {
    set({ isMutating: true, error: null, successMessage: null });
    try {
      const { data } = await api.post<{ memory: Memory; created: boolean }>('/memories', input);
      set((state) => ({
        memories: [data.memory, ...state.memories.filter((m) => m.id !== data.memory.id)],
        isMutating: false,
        successMessage: data.created ? 'Memory saved.' : 'Duplicate memory — nothing new was stored.',
      }));
      return data.memory;
    } catch (err) {
      set({ error: messageOf(err, 'Failed to save memory'), isMutating: false });
      return null;
    }
  },

  updateMemory: async (id, patch) => {
    set({ isMutating: true, error: null, successMessage: null });
    try {
      const { data } = await api.patch<{ memory: Memory }>(`/memories/${id}`, patch);
      set((state) => ({
        memories: state.memories.map((m) => (m.id === id ? data.memory : m)),
        isMutating: false,
        successMessage: 'Memory updated.',
      }));
      return data.memory;
    } catch (err) {
      set({ error: messageOf(err, 'Failed to update memory'), isMutating: false });
      return null;
    }
  },

  deleteMemory: async (id) => {
    set({ isMutating: true, error: null, successMessage: null });
    try {
      await api.delete(`/memories/${id}`);
      set((state) => ({
        memories: state.memories.filter((m) => m.id !== id),
        isMutating: false,
        successMessage: 'Memory deleted.',
      }));
      return true;
    } catch (err) {
      set({ error: messageOf(err, 'Failed to delete memory'), isMutating: false });
      return false;
    }
  },

  /** User-confirmed supersession — the ONLY path that supersedes a memory. */
  supersedeMemory: async (id, newMemoryId) => {
    set({ isMutating: true, error: null, successMessage: null });
    try {
      await api.post(`/memories/${id}/supersede`, { new_memory_id: newMemoryId });
      await get().fetchMemories();
      set({ isMutating: false, successMessage: 'Memory superseded (your confirmation).' });
      return true;
    } catch (err) {
      set({ error: messageOf(err, 'Failed to supersede memory'), isMutating: false });
      return false;
    }
  },

  updateSettings: async (patch) => {
    set({ isMutating: true, error: null, successMessage: null });
    try {
      const { data } = await api.patch<MemorySettingsResponse>('/memories/settings', patch);
      set({ settings: data.settings, isMutating: false, successMessage: 'Settings saved.' });
    } catch (err) {
      set({ error: messageOf(err, 'Failed to save settings'), isMutating: false });
    }
  },

  clearError: () => set({ error: null }),
  clearSuccess: () => set({ successMessage: null }),
}));
