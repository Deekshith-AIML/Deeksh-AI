/**
 * src/store/useChatStore.ts
 * -------------------------
 * Zustand store managing chat messages and the POST /chat flow.
 *
 * Key behaviors:
 * 1. On send, an optimistic user bubble is appended immediately.
 * 2. A temporary assistant bubble with `isLoading: true` is shown so the
 *    user sees a "typing" indicator while the AI provider (Gemini) processes the request.
 * 3. When the backend responds, the temporary bubble is replaced with the
 *    real assistant reply.
 * 4. After a successful response, `useTaskStore.getState().fetchTasks()` and
 *    `useReminderStore.getState().fetchReminders()` are called automatically
 *    so the Kanban board and reminder panel refresh in case the AI created
 *    a task or scheduled a reminder via the `create_task` tool.
 *
 * SECURITY: the request body carries ONLY `{ message }`. The hard-coded
 * demo `user_id` has been removed — the backend derives identity from the
 * `Authorization` header attached by the Axios interceptor.
 */

'use client';

import { create } from 'zustand';
import api from '@/lib/api';
import { useTaskStore } from './useTaskStore';
import { useReminderStore } from './useReminderStore';
import type { ChatMessage, ChatResponse } from '@/types';

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface ChatState {
  /** Full conversation, oldest → newest. */
  messages: ChatMessage[];
  /** True while waiting for the assistant reply. */
  isLoading: boolean;
  /** Last error message, if any. */
  error: string | null;

  /** Send a user message, run the AI tool-calling loop, refresh tasks. */
  sendMessage: (content: string) => Promise<void>;
  /** Reset the error banner. */
  clearError: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a stable-enough local id for optimistic messages. */
function localId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  error: null,

  sendMessage: async (content: string) => {
    const trimmed = content.trim();
    // Guard against empty sends and double-submits while a reply is pending.
    if (!trimmed || get().isLoading) return;

    const userMessage: ChatMessage = {
      id: localId('user'),
      role: 'user',
      content: trimmed,
      created_at: new Date().toISOString(),
    };

    const loadingMessage: ChatMessage = {
      id: localId('assistant-loading'),
      role: 'assistant',
      content: '',
      isLoading: true,
    };

    // 1. Append the user's message plus the temporary "typing" bubble.
    set((state) => ({
      messages: [...state.messages, userMessage, loadingMessage],
      isLoading: true,
      error: null,
    }));

    try {
      // 2. POST /chat — identity comes from the bearer token (attached by
      //    the Axios interceptor); the body contains only the message.
      //    The backend runs the AI tool-calling loop and may create a
      //    task in Supabase before replying.
      const { data } = await api.post<ChatResponse>('/chat', {
        message: trimmed,
      });

      // 3. Replace the loading bubble with the real assistant reply.
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === loadingMessage.id
            ? {
                id: localId('assistant'),
                role: 'assistant' as const,
                content: data.reply,
                created_at: new Date().toISOString(),
                isLoading: false,
              }
            : m,
        ),
        isLoading: false,
      }));

      // 4. CRUCIAL: refresh the Kanban board AND the reminder panel so any
      //    task/reminder created by the AI's `create_task` tool appears
      //    without a manual reload. Each refresh is wrapped in its own
      //    try/catch so a refresh failure never removes the chat reply.
      try {
        await useTaskStore.getState().fetchTasks();
      } catch {
        // Non-fatal — the chat reply is already shown.
      }
      try {
        await useReminderStore.getState().fetchReminders();
      } catch {
        // Non-fatal — the chat reply is already shown.
      }
    } catch (err) {
      // 5. On failure, remove the optimistic loading bubble and surface
      //    the error so the user can retry.
      set((state) => ({
        messages: state.messages.filter((m) => m.id !== loadingMessage.id),
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to send message',
      }));
    }
  },

  clearError: () => set({ error: null }),
}));
